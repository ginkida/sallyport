# Sallyport security

This document describes what Sallyport is designed to defend against, what
it deliberately doesn't try to defend against, and the known limitations
of the current implementation. The README's `## Security model` section
is the user-facing summary; this file is the deeper reference for anyone
auditing the code or considering Sallyport for their setup.

## Threat model

Sallyport assumes:

- **one trusted local user** running Claude Code (or another MCP client)
  on their own machine;
- the user wants the client to drive Chrome on a **small, explicit set of
  domains** rather than the open web;
- the user wants a **visible audit trail** of every action and a **kill
  switch** they can hit from the popup.

Concretely we try to defend against:

1. **Other local processes** on the same machine that could otherwise
   speak the bridge protocol to the daemon — HMAC pairing + loopback-only
   bind close this. The single-client slot is claimed only **after** a
   verified signed `hello` (first frame, 10 s deadline), and browser-page
   `Origin` headers are refused at connect time — so an unauthenticated
   peer (including a malicious web page opening a cross-origin WebSocket
   to `127.0.0.1`) can neither hold the slot to deny service to the real
   extension nor probe whether an extension is attached.
2. **An agent over-reaching its scope** — the per-domain allowlist gates
   every DOM tool, the per-domain `evaluate` flag gates arbitrary JS, the
   per-tool `password_field` / `unsafe_path` / `wrong_element` checks
   gate the most damaging actions, and `close_tab` won't close a
   non-allowlisted tab — unless it is one the calling session created
   itself, where proven ownership stands in for the allowlist.
3. **Filesystem exfiltration via `upload`** — the daemon-side sandbox
   (`~/Downloads/sallyport/` by default, override `SALLYPORT_DOWNLOAD_DIR`)
   rejects paths outside the sandbox; `Path.resolve()` defeats symlink
   escapes.
4. **Replay** — every WS frame carries an HMAC, a timestamp (±30 s
   tolerance), and a one-time nonce (4096-entry rolling cache). The extension
   serialises verification and persists its receive cache in
   `chrome.storage.session`, tagged to the pairing secret, so concurrent
   duplicates and normal MV3 worker eviction cannot reopen the window.

We do **not** try to defend against:

- a local user with read access to `~/.config/sallyport/secret` (they pair
  to the bridge and become the agent);
- a compromised Chrome process or extension (debugger access is full
  page access by definition — Sallyport limits *which* pages it drives,
  not what driving can do);
- prompt injection against the upstream model;
- adversaries on the local network (everything is loopback);
- side-channel attacks via the audit log timing or popup rendering.

## What's gated and how

See the README "Security model" section for the user-facing bullets and
the "Tools" table for per-tool notes. Quick reference:

| Concern | Mechanism | Where |
|---|---|---|
| Daemon ↔ extension authenticity | HMAC-SHA256, ts±30 s, 4096-nonce cache | `daemon/.../protocol.py`, `extension/src/crypto.ts` |
| Network exposure | Loopback-only bind (`refuse_non_loopback`) | `daemon/.../__main__.py` |
| Domain scope | Allowlist enforced before every DOM tool | `extension/src/allowlist.ts`, `extension/src/tools/gates.ts` |
| Arbitrary JS | Per-domain `allowEvaluate` opt-in; fixed-literal probes (`fetch_in_page` body, `snapshot`'s DOM-fallback walker, `mouse_click`'s aiming probes — coordinates travel as structured `callFunctionOn` arguments, not interpolation) interpolate no agent input and need only the allowlist | `extension/src/tools/gates.ts:ensureEvaluateAllowed`; `fetch.ts`, `domtree.ts`, `aim.ts`. `screenshot` and `print_to_pdf` run NO page JS at all — structured CDP only |
| Password input | `fill` reads `type` via browser DOM; `key_type`/`send_keys` enumerate frames (temporary flat child sessions for OOPIFs), locate focused AX nodes through closed shadow DOM, then inspect browser-owned DOM attributes | `extension/src/tools/dom.ts`, `focus.ts`, `keyboard.ts` |
| Closing tabs | Allowlist-gated like other DOM tools, EXCEPT a tab the caller created in broker mode: the daemon has already proved ownership, which is a stronger answer to "may I destroy this tab" (and without it an agent tab that redirected off-allowlist could never be closed by its owner) | `extension/src/tools/tabs.ts:closeTab` |
| Filesystem (write) | `save_to_file` and `print_to_pdf`'s daemon post-call processor sandbox to `~/Downloads/sallyport/` (shared `_write_sandbox_blob`: filename rules + resolved-path containment re-check) | `daemon/.../local_tools.py:save_to_file`, `POST_CALL_PROCESSORS` |
| Filesystem (read via Chrome) | `upload` paths must resolve under the same sandbox; symlink-safe | `daemon/.../local_tools.py:validate_upload_paths` + `PRE_CALL_VALIDATORS` |
| Frame size | 16 MiB cap, 1009 close on overflow | `daemon/.../bridge.py:MAX_FRAME_BYTES` |
| Secret file | `chmod 600`, perms warned on relax | `daemon/.../secret.py` |
| Concurrent calls | One serial lane per client + a FIFO permit pool capping calls in flight; the lane spans the ownership check-then-act, the permit only the WS round-trip. The extension chains per TAB. Sessions run concurrently; a session's own calls stay serial | `daemon/.../scheduling.py`, `bridge.py`, `extension/src/tools.ts` |
| Multiple WS clients | Slot claimed only after verified signed hello; second authenticated client rejected with 1008 | `daemon/.../bridge.py:_handle_client` |
| Unauthenticated slot-squatting / probing | Hello-before-slot + 10 s hello deadline + browser-page Origins refused | `daemon/.../bridge.py:_handle_client` |
| Tab ownership (broker mode) | Daemon `ensure_owns` gate before every tab-touching call; `(clientId,tabId,epoch)` registry; extension epoch confirm | `daemon/.../ownership.py`, `extension/src/tools/ownership.ts` |
| MCP-client auth (broker mode) | Signed `hello` before any disclosure/action; server-minted connection-bound `clientId`; per-connection nonce cache | `daemon/.../broker.py:authenticate_connection` |
| Broker socket exposure | `0600` AF_UNIX socket beside the secret (same uid gate); authenticated-client cap (16), with half-open handshakes bounded separately so a never-hello peer can't consume an earned slot | `daemon/.../broker.py:start_broker_server` |
| Broker socket ownership | `flock` held for the process lifetime claims the path before binding — `asyncio.start_unix_server` unlinks a LIVE socket there, so the lock, not the file, is the exclusion. Shutdown unlinks only the inode it bound | `daemon/.../broker.py:acquire_broker_lock`, `unlink_socket_if_ours` |
| Session label (broker mode) | Peer-declared, sanitised (charset + 24 chars), used only for audit display and window grouping — never for a gate. Ownership keys on the server-minted `clientId`, which never leaves the daemon | `daemon/.../broker.py:sanitise_label` |

## Broker mode

`sallyport-daemon broker` lets one process own the single browser/extension leg
and serve **several** Claude Code sessions at once (plus the human, working in the
same browser). It changes the threat model in two ways, each met by a new
load-bearing invariant.

**The MCP leg becomes a network-ish surface.** A standalone daemon's MCP leg is a
private stdio pipe between Claude Code and the daemon. A broker's MCP leg is an
AF_UNIX socket any local process *could* `connect()` to. The four-part floor that
protects the extension WS leg is reused wholesale: a `0600` socket bound beside
the secret (only the owning uid can reach it — the loopback-bind analogue,
invariant #2), a signed `hello` as the first frame within a 10 s deadline, HMAC +
constant-time compare + per-connection nonce cache on every frame, and the same
secret-backed credential. An unauthenticated peer is closed before anything is
disclosed and learns nothing — not even whether an extension is attached
(**invariant #14, MCP-client auth earned-not-grabbed**). The `clientId` that
scopes ownership is **server-minted, connection-bound, and ephemeral**: a peer
cannot forge another's id because it cannot inject into another's socket.

**One browser is now shared by mutually-distrusting drivers.** Each session must
be confined to the tabs it created, and the human's tabs must stay invisible and
untouchable. This is **invariant #13 (tab ownership)**: the daemon is the
authoritative gate — it alone knows the `clientId` — and refuses any
tab-touching call whose `tabId` is not owned by the caller (`tab_not_owned`), or
that omits `tabId` entirely (`tab_required` — the active-tab fallback is disabled
in broker mode, so a tabId-less `navigate` opens a *new owned* tab instead of
clobbering the human's focused one). Ownership keys on `(tabId, epoch)`, never
`tabId` alone: the extension mints a create-time `epoch` so a recycled Chrome
tabId resolves to `tab_gone` rather than the wrong page. `list_tabs` is
owner-scoped at both layers (extension filters to agent-created tabs, daemon
re-scopes per-client, **fail-closed**), and `screenshot bringToFront` is refused
(`bringtofront_forbidden`) so automation can't yank the human's focus —
`screenshot` instead makes the tab active *within its own unfocused window*,
which the human never sees. The diagnostic `status` ring (recent tool outcomes +
last error) is stored **per client** rather than filtered out of a shared one, so
a session sees only its own calls — never another client's tools, codes, or
server-minted `clientId` — and there is no shared structure left to leak through.

Since 0.17 a broker is started **automatically** by the first session, so this is
the default deployment rather than an opt-in. That also means the tab-ownership
semantics above (explicit `tabId`, owner-scoped `list_tabs`, no active-tab
fallback) are what an agent normally sees. `--no-broker` /
`SALLYPORT_NO_BROKER=1` restores single-session standalone behaviour.

Each session's tabs open in **its own** non-focused window, muted, with the
human's previously-focused window restored afterwards. Those are ordinary
windows in the human's profile — same cookie jar, same logins — because the
point of driving the user's own browser is that an agent inherits the sessions
they are already signed into. The separation is ownership, never identity: there
is no incognito/profile boundary here and adding one would break that premise.
When a session disconnects its tabs stay OPEN but stop being driven — the daemon
fires an internal `_release_tabs` so the debugger detaches, ending Chrome's
"started debugging this browser" bar, the disabled back/forward cache and the
sticky focus emulation for tabs whose agent is gone.

**Honest framing — what broker mode is and isn't.** It is a **software partition**
of one shared browser profile, bounded by the allowlist + ownership + secret-gated
auth. It is **not** a Chrome-profile wall and **not** multi-tenant OS isolation.
There is **one shared secret**, so there is **no cryptographic isolation between
secret-holders** — every "another client can't…" claim above rests on
*connection binding* (you can't inject into another's socket) and on not handing
the secret around, not on distinct keys. The security floor is **same-uid**: any
process running as the user can read the secret, pair, and drive the browser
within the allowlist. The extension layer (epoch confirm, owner-scoped
`list_tabs`) is defence-in-depth; the daemon gate is authoritative. If the broker
process itself is compromised, all partitions fall at once.

## Known limitations

### Audit log persistence depends on `chrome.storage.local` quota

Per-entry truncation (`MAX_AUDIT_STRING = 1024` per string, including
object keys) plus a shared fan-out budget (`MAX_AUDIT_ITEMS = 16`
array-elements-or-object-keys, one running counter across the WHOLE
nested structure — not a per-level cap) keep 500 entries well inside the
10 MiB quota regardless of shape: a pathological agent that spams huge,
wide, or deeply-nested structured arg objects — or objects with
huge/attacker-controlled property names (e.g. HTTP header names via
`fetch_in_page`) — can't fan out the *stored* size past that bound.
**Residual, accepted gap:** enumerating a plain JS object's own keys is
inherently a pass over its full width in the extension's runtime (there
is no lazy/partial enumeration API), so an extremely wide single object
still costs CPU roughly proportional to its width before the bound kicks
in — a possible brief (sub-second at realistic sizes) main-thread stall
on the single-threaded MV3 service worker, not a storage or memory
blowout, and not exploitable beyond that.

**Typed credentials are redacted — both when typed AND when refused.**
When `fill` / `key_type` / `send_keys` run with `allowPassword=true` (the
only way text reaches a password field), the typed value is replaced
with a length placeholder before it is written to the audit log, so
passwords are not retained at rest or surfaced by the popup's Export.
The same redaction applies when a typing call is REJECTED for touching
(or possibly touching) a password field — both the confirmed
`password_field` case and the fail-closed `focus_probe_failed` case (the
CDP frame/AX/DOM focus walk returned incomplete data, so the field couldn't
be ruled out) — so an attempted credential doesn't leak
into the audit log just because the keystroke itself was correctly
blocked. Values typed into non-password fields are kept verbatim — that
is the point of a visible audit trail — so treat the exported log as
containing whatever the agent typed into ordinary inputs.

### Allowlist matches any port unless a port is pinned

A host-only entry (`example.com`, `*.example.com`) authorizes the host
on **any port** — intentional, so allowlisting `localhost` reaches a dev
server on `localhost:3000`. To scope to one port, use the URL form with
an explicit port: `https://example.com:8443/*` matches only `:8443`; a
URL pattern with no port (`https://example.com/p/*`) matches only the
scheme's default port. The matcher honors the port a URL pattern
specifies (earlier builds silently ignored it). If you run a second
sensitive service on a different port of an allowlisted host, pin the
port rather than relying on a host-only entry.

### Extension `host_permissions: <all_urls>`

Necessary for `chrome.debugger.attach` to be allowed on arbitrary URLs.
Chrome's install warning surfaces this as "Read and change all your
data on the websites you visit." Sallyport limits what we actually do with
it via the per-tab allowlist gate, but the initial permission grant is
broad. This is intrinsic to debugger-based bridges and not separately
fixable inside Sallyport.

### Secret file at `~/.config/sallyport/secret` is plaintext

By design. Any process running under the same UID can read it and pair
to the bridge. The threat model assumes one trusted local user. If you
need stronger isolation, run Sallyport inside a per-user container or VM.

### Tool-name shadowing between local and extension tools

`Bridge.call_tool` checks `LOCAL_TOOLS` before forwarding. If someone
adds a tool to `extension/src/tools.ts` with the same name as a local
tool, the local one silently wins. Currently no collision, and two tests
guard it: `test_no_local_tool_shadowing` parses the extension's
`tools.ts` registry and asserts it is disjoint from `LOCAL_TOOLS`, and
`test_tools_catalogue_covers_extension` pins the expected catalogue so
any new name needs an explicit `expected` update.

### Broker mode: a create that crashes mid-flight can leak an untracked tab

The daemon records ownership of a created tab from the tool *result*. If a
`navigate{newTab:true}` runs to completion in the extension but its result never
reaches the daemon (the session dies mid-call), the tab exists but the registry
never learns of it — so it is neither owned nor reaped. v1 closes this lazily:
the extension reconciles `epochByTab` against the live tab set on every
service-worker wake, and a session's tabs return to "unowned" (usable by the
human) on disconnect. There is **no unsolicited extension→daemon event channel**
in v1 (adding one would cost a `PROTOCOL_VERSION` bump + vector regeneration), so
reaping is on next-call / next-wake, not instant.

**Exploitability:** none in the adversarial sense — the floor is same-uid, and an
orphaned tab is just a tab the human can see and close. It is a tidiness gap, not
a confinement hole.

The tidiness half is now largely handled from the other direction: on disconnect
the daemon calls the extension (daemon→extension is an ordinary `tool_call`, so
no protocol bump) to stop driving that session's tabs, and the popup's **Agent
tabs** section lists what every session left open with a one-click sweep. A tab
the registry never learned about still won't appear there — that is the residual
gap, and it is still just a tab.

### Broker mode: concurrency is capped, and the cap is shared

Sessions no longer serialise against each other: each has its own lane, and a
FIFO pool caps how many calls are on the wire at once (default 8, so it only
binds once more than that many sessions are busy together). Because a session
can have at most one call waiting for a permit, the FIFO queue is round-robin
across sessions for free — a session that pipelines calls cannot get ahead of
one that doesn't. A call that waits out the queue window fails `busy` having
never been sent, which is what makes it safe to retry. `status` takes neither a
lane nor a permit, so it answers during any stall.

What remains is resource contention, not unfairness: N sessions genuinely
sharing one browser will each be slower than one session alone, and a runaway
session can keep the browser busy. That is DoS **within the trusted set** (the
user's own sessions), the same floor as everything else here.

### Broker mode: agent windows are presentation, not isolation

Agent-created tabs open in a non-focused window per session, to keep them out of
the human's way and to make "what is this session doing" legible. Ownership
never keys on `windowId` (the human may drag a tab between windows), so the
window is purely cosmetic separation — it is **not** a security boundary.
Confinement is the daemon ownership gate, not the window.

The same goes the other way: these are ordinary windows in the human's own
Chrome profile, sharing their cookies and logins by design. An agent driving an
allowlisted site acts **as the signed-in user**. That is the premise of the
whole project (see the threat model), not an oversight — the allowlist and
per-domain `evaluate` opt-in are what bound it.

### Broker mode: a session's label is peer-declared

A connecting session names itself in its `hello` (its working-directory name by
default). The broker sanitises it — charset-folded, 24 chars — and forwards it
to the extension for audit rows and window grouping. It is **display metadata
only**: any same-uid process that can pair could claim any label, so it must
never reach a gate, and it doesn't. Ownership keys on the server-minted
`clientId`, which never leaves the daemon.

## Adding a new tool safely

The "Adding a new tool" section in the README has the mechanical steps.
For *security-relevant* additions, also check:

1. **Does the tool touch the page?** Add `await ensureAllowed(tab.url)`
   before any CDP call. `list_tabs` is the only exception (listing is
   metadata, not action — already documented).
2. **Does it run arbitrary user-supplied JS?** Use
   `ensureEvaluateAllowed` instead of `ensureAllowed`. If the JS body
   is fixed and only args are JSON-interpolated (like `fetch_in_page`),
   `ensureAllowed` is enough.
3. **Does it touch the filesystem from the daemon?** Use
   `_resolve_dir()` and validate against it — the same sandbox shape as
   `save_to_file` and `upload`'s validator.
4. **Does it touch the filesystem via Chrome?** Register a validator in
   `PRE_CALL_VALIDATORS` (`local_tools.py`) that checks paths against
   `_resolve_dir()` with `Path.resolve()` to defeat symlinks.
5. **Does it accept focus-routed input** (keyboard/clipboard)? Mirror
   the `password_field` probe pattern from `keyboard.ts`.
6. **Does it produce binary blobs as output?** Truncated in audit
   automatically via `truncateAuditValue`; safe.
7. **Does it subscribe to CDP events** (`chrome.debugger.onEvent`, e.g.
   `console_tail` / `console-capture.ts`, `network_tail` /
   `network-capture.ts`, `handle_dialog` / `dialog-capture.ts`)? Keep it
   opt-in behind a popup setting (default off)
   and enable the underlying domain (`Runtime.enable`, `Network.enable`,
   `Page.enable`, …)
   lazily — never on the unconditional `attach()` path, so the observable
   CDP footprint only widens for users who asked for it. Buffer with a hard
   per-tab cap, clear on `tabs.onRemoved` / `debugger.onDetach`, and tag each
   captured item with its producing origin so reads can be filtered to the
   allowlist (fail-closed on an unknown origin — a tab can navigate
   cross-origin while buffering, so the read-time tab URL alone isn't enough).
   If it captures response **bodies** (`network_tail`), that is a read
   amplification: restrict to textual data content-types, cap each body, and
   never capture request/response headers (no `Authorization`/`Cookie`
   exfiltration). Response bodies can still carry sensitive same-origin data,
   so the opt-in default-off + allowlist origin filter are load-bearing.
   If the subscription also **acts** on the page (`handle_dialog` answers
   dialogs), keep the automatic action to the safest default (alert → OK,
   everything else → cancel) and route any escalation through the
   allowlist-gated tool as a per-event one-shot — never a sticky policy an
   agent sets once and keeps. Bind that one-shot to the origin it was
   allowlist-checked against when armed, and refuse to apply it to anything
   else (fail-closed if either origin can't be determined) — an armed
   escalation is scoped to intent for ONE page, not a standing grant any
   frame or later navigation on the tab can trigger. Origin-binding alone
   only stops a CROSS-origin hijack; an arm that never met its intended event
   still sits live until something clears it, so also invalidate it on
   navigation. Prefer a CDP-level signal (`dialog-capture.ts` listens for
   `Page.frameNavigated`, main-frame only) over hooking every tools.ts call
   site that might navigate — a call-site-only clear both MISSES navigations
   the tool layer doesn't know about (a plain `click()` on a link or
   form-submit button never routes through `navigate`/`reload`/`history_go`)
   and RACES the page it just landed on (clearing after `waitForLoad` is too
   late to beat a dialog the fresh page pops on its own load); a CDP event
   fires the instant the new document commits, before that page's scripts can
   run. And because acting (unlike passive observation) means the human may
   want their control back, the setting's OFF path must actively revoke the
   underlying CDP enable (`Page.disable`, not just stop future recording) —
   see `cdp.ts`'s `releaseKeepAwake`/`releaseDialogCapture` for the shape, and
   make that revoke UNCONDITIONAL (never gated on in-memory bookkeeping an
   MV3 service-worker restart can wipe while the debugger session itself
   survives). If enabling this CAPTURE from a tool that didn't need CDP
   before (`navigate`/`reload` calling `attach()` so dialog handling is live
   for the destination page's own load) turns a previously CDP-independent
   tool into one that hard-depends on `chrome.debugger.attach` succeeding,
   make that attach BEST-EFFORT (`tabs.ts:bestEffortAttach`) — a debugger
   conflict (DevTools already open on that tab, routine given this project's
   own usage model) must not break a call that used to work fine without
   CDP. If the same call site also has to mint state on success (broker
   ownership epoch), make sure the best-effort attach can't abort the
   function before that mint runs, or a swallowed failure still orphans
   whatever the call was supposed to create.
8. **Does the tool report an outcome that depends on an action actually
   having taken effect** (a navigation, a hop through history)? Don't infer
   success from a watchdog merely resolving — a beforeunload prompt (or
   anything else) can silently cancel the underlying action while every
   "did it finish" check still reads as done (status back to `'complete'`,
   no error thrown). Verify the tangible outcome directly when there's a
   cheap, reliable way to, but pick the RIGHT comparison: `history_go`
   compares the tab's landed URL against where it STARTED (`beforeUrl`), not
   an exact match against the assumed destination — attaching CDP disables
   the back/forward cache, so the "did it finish" question always resolves
   against a live navigation that can legitimately redirect, and an
   exact-match check would misreport a real redirect as a cancelled action.
   Report what actually happened (the observed landed URL), not the
   requested one.

## Reporting

There is no formal vulnerability-reporting channel set up for this
project yet. For non-sensitive issues, open a GitHub issue. For anything
you'd rather not disclose publicly, reach the project maintainer
directly via whatever channel you normally use — there is no advisory
email address.
