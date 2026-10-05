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
| Arbitrary JS | Per-domain `allowEvaluate` opt-in; fixed-literal probes (`fetch_in_page` body, `snapshot`'s DOM-fallback walker, `mouse_click`'s aiming probes — coordinates travel as structured `callFunctionOn` arguments, not interpolation; `set_viewport`'s viewport read-back; `screenshot`'s one-word `window.devicePixelRatio` read, used only to RAISE a browser-owned size bound, never to lower it; the one argument-less function an agent's own tab runs before it navigates, which stops its `beforeunload` handlers from cancelling the leave) interpolate no agent input and need only the allowlist | `extension/src/tools/gates.ts:ensureEvaluateAllowed`; `fetch.ts`, `domtree.ts`, `aim.ts`, `viewport.ts`, `screenshot.ts`, `quiet-leave.ts`. `print_to_pdf` runs NO page JS at all — structured CDP only |
| Password input | `fill` reads `type` via browser DOM, then binds the write to its target: after `focus()` the browser's AX tree must show focus inside the target's subtree (through closed shadow roots, never into a frame), and an isolated-world guard cancels the insert at `beforeinput`/`textInput` if the focus chain has left the field (limits below); a frame is refused unless its whole document is an editor on an allowlisted origin; `key_type`/`send_keys` enumerate frames (temporary flat child sessions for OOPIFs), locate focused AX nodes through closed shadow DOM, then inspect browser-owned DOM attributes | `extension/src/tools/dom.ts`, `focus.ts`, `keyboard.ts` |
| Element refs (`@eN`) | Per-tab map; ids are monotonic per tab and restart at `e1` only when the tab closes (a detach, navigation or re-snapshot wipes the map but keeps counting; an extension worker restart or reload resumes from the exact high-water mark — the highest id handed out — persisted in `chrome.storage.local` before any id it covers is handed out, so a restart re-issues no id and skips none), so a held ref MISSES instead of re-binding. Best-effort at that one seam: if storage refuses, a restarted worker counts from `e1` again. A refusal is never sticky — a refused load is retried by the next call, a refused write re-arms so the next call writes again, and a worker that has not managed to load writes nothing rather than replace the stored marks of tabs it never touched. Each ref is stamped with the main-frame loader id of the document it was minted in and refused as `bad_ref` once the tab shows another document — after a navigation the PAGE starts into a new renderer process, an old backendNodeId resolves to a live node of the new page | `extension/src/tools/refs.ts`, `ref-store.ts`, `resolve.ts:refDocumentState` |
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
human's previously-focused window restored afterwards — only when the new
window really took focus (Chrome is then already frontmost); focusing a window
of a Chrome the human was not using would bring the whole app to the front
(macOS). Those are ordinary
windows in the human's profile — same cookie jar, same logins — because the
point of driving the user's own browser is that an agent inherits the sessions
they are already signed into. The separation is ownership, never identity: there
is no incognito/profile boundary here and adding one would break that premise.
When a session disconnects its tabs stop being driven — the daemon fires an
internal `_release_tabs` so the debugger detaches, ending Chrome's "started
debugging this browser" bar and the sticky focus emulation (which keeps a page
rendering as if visible) for tabs whose agent is gone. By DEFAULT the tabs
themselves stay open; the popup's `closeAgentTabsOnDisconnect` (off by default) closes them instead.
That switch is browser-global — the extension is identity-blind, so it cannot
distinguish an ephemeral agent from an interactive one — and a close requires the
daemon's recorded ownership epoch to match the extension's, so a recycled tab id
cannot destroy a live tab belonging to a different session.

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
CDP frame/AX/DOM focus walk returned incomplete data, or the page did not
answer one of its accessibility queries within the gate's deadline — at most
5 s, never more than the call has left — so the field couldn't be ruled out;
nothing is typed, and a late answer arms nothing), and `fill`'s target-binding refusals (`not_focusable`,
`no_editable_focus`, `focus_moved`, `wrong_element`), each of which fires
where the text could have been heading for a field nobody vetted — so an
attempted credential doesn't leak
into the audit log just because the keystroke itself was correctly
blocked. Values typed into non-password fields are kept verbatim — that
is the point of a visible audit trail — so treat the exported log as
containing whatever the agent typed into ordinary inputs.

### `fill`'s insert guard binds focus, not intent

`fill` binds its write to the target: the browser must report focus inside
the target before the insert, and a capture listener in an isolated world on
the target's window checks, at `beforeinput` and again at `textInput`, that
the whole focus chain (document and every shadow root, closed ones included)
still ends at the field — cancelling the insert if not. That closes the
passive trap that motivated it (a frame autofocusing a password field), an
honest page moving focus at the wrong moment, and a page's `beforeinput`
handler moving focus. What remains:

- **A move into another document.** The guard listens in the target's
  document. If focus moves into a different frame in the instant between the
  browser's focus check and the insert — an honest auto-advance timer can do
  this — the insert is not seen there and lands in that frame. `fill` then
  fails with `focus_moved` ("the target never received the text … it may have
  gone there") — detected and reported, not prevented.
- **A page written to defeat it.** The isolated world shares the DOM with the
  page. A page listener that runs after our `textInput` check (or a window
  capture listener registered before ours that stops propagation) can move
  focus once the check has passed, and Chrome inserts wherever focus then is.
  Such a page can only steer the text into its OWN fields — which it can read
  anyway, including the one the agent targeted — so this costs nothing the
  page didn't already have. What the gate protects is that an agent is not
  steered into a credential field by a page that isn't trying, or by the
  agent's own mistaken target.

`key_type` and `send_keys` have no target to bind to — they type into
whatever has focus by contract — so they keep the fail-closed walk over every
frame described above.

### A ref is bound to a document, checked between two calls

An `@eN` names a backendNodeId, which the browser keeps unique only within one
renderer process: after a navigation into a new process (a link to another
site, a form submit, a script redirect — even back to the first site) the new
process numbers its nodes from 1 again, and an old id resolves to a LIVE node
of the new page. Until this was fixed, a `click`/`fill`/`read_text` on a ref
from before such a navigation acted on whatever element of the new page held
that id and answered `ok:true` (reproduced on Chrome 154 through the real
extension: twenty stale refs clicked twenty foreign buttons).

Every ref therefore carries the main-frame loader id of its document, read
BEFORE the walk that mints it, and every resolve reads the tab's current loader
id AFTER turning the ref into a node and before acting; a mismatch is
`bad_ref`. A loader id changes with every cross-document navigation and not
with `pushState`, so SPA routing keeps its refs.

The check has THREE answers, not two. Besides "same document" and "another
document" it can be UNKNOWN: the ref carries no stamp (the browser did not say
at mint time), or the tab does not say in time which document it shows
(`Page.getFrameTree` is answered by the renderer, so it runs under a deadline —
at most 3 s, never more than the call has left), or the question loses its
context to a navigation committing. Unknown is never treated as proof of
anything: an action refuses it as `bad_ref` without touching the node, a
`wait_for` counts that tick as unread (an absent-wait keeps polling instead of
reporting a still-visible node gone), and `get_state` answers
`{exists:null, reason:'unknown'}` without reading the node. Any other refusal
(a detached debugger, a closed tab) still fails the call. What remains:

- **An A → B → A round trip between the two reads.** A page restored from the
  back/forward cache returns with its ORIGINAL loader id, and its old ids
  honestly name its own nodes again. The only way to slip past the check is
  for the tab to leave the document and come back to that very document
  between the resolve and the loader-id read — two consecutive CDP calls,
  under a millisecond apart. Not reachable in practice; noted because the
  check is a comparison, not a lock.
- **Frames.** The stamp is the MAIN frame's. Refs never reach into child
  frames (snapshot does not descend into them), so a frame navigating has
  nothing to rebind.

### Allowlist matches any port unless a port is pinned

A host-only entry (`example.com`, `*.example.com`, `localhost`) authorizes
the host on **any port** — intentional, so allowlisting `localhost` reaches a
dev server on `localhost:3000`.

Pattern shapes are gated in `allowlist.ts` and, importantly, at BOTH layers: the
popup's two add paths share one `validatePattern`, and `hostMatches` re-checks
the same shape at enforcement time, so an entry that arrives some other way (an
older build, a hand-edited store) is inert rather than honoured. The rule:

* a wildcard needs two labels of its own (`*.example.com`), or one of the
  reserved names that never resolve publicly — `*.localhost`, `*.test`,
  `*.invalid`, `*.example` (RFC 2606/6761);
* `*.local` and `*.internal` are **refused**, though equally unroutable.
  Unroutable is not trusted: `.local` is mDNS, where resolution is
  unauthenticated and first-responder-wins, so `*.local` would cover every
  device on whatever network the machine is attached to; `.internal` is
  split-horizon corporate/cloud DNS, i.e. a whole intranet the human is already
  logged into. Their scoped forms (`*.corp.local`) and exact hosts (`nas.local`)
  still work, which is what a homelab needs;
* a dotless host must be one of those reserved names. `localhost` has a
  specification behind it; `wiki` / `git` / `jira` resolve via the DHCP search
  list, LLMNR or NBT-NS — unauthenticated, different on every network;
* a wildcard over an IP literal is refused (an IP has no subdomains, and
  `*.0.0.1` would reach `1.0.0.1` and `10.0.0.1`);
* the `http(s)://` form gets the SAME host check. `*` is not a forbidden host
  code point, so `new URL('https://*.com/')` parses with hostname `*.com` and
  reaches the identical matcher — leaving that branch unchecked would have put
  the whole rule nine characters from a bypass.

Known and deliberately NOT closed: a two-label wildcard can still span a public
suffix or a shared-tenant host — `*.co.uk`, `*.github.io`, `*.vercel.app`,
`*.pages.dev` — so anyone who can register a free subdomain there becomes an
allowlisted origin. Closing that needs the Public Suffix List bundled into the
extension, not a label count. Prefer an exact host on those.

`localhost`, `127.0.0.1` and `[::1]` are distinct hosts to the matcher; add each
one that reaches your server. To scope to one port, use the URL form with
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
tabs** section lists what every session left open with a one-click sweep — the
released tabs keep their extension-side ownership epoch precisely so they stay
visible to it (it grants no access: the daemon has already forgotten them, so no
client can name them). A tab the registry never learned about still won't appear
there — that is the residual gap, and it is still just a tab.

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

### Broker mode: an agent's own tab leaves without asking

A page with a `beforeunload` handler that has seen a user gesture — and an
agent's click or typing is one — makes Chrome ask "Leave site?" / "Close
site?" before it goes. To show that prompt Chrome activates the tab and focuses
its window, even when a CDP client answers the dialog at once; on macOS the
whole app comes to the front, and the close or navigation waits for a human
click. So for a tab the agent CREATED and the human has not engaged with
(`quiet-leave.ts:mayCloseQuietly`) and that is not the tab in front of them
right now (`inFrontOfHuman`), the prompt is never raised: every close
(`close_tab`, the tab reaper, `_release_tabs`' close, the popup sweep — one
helper, `closeAgentTab`) goes through `Target.closeTarget` on the tab's own
PAGE target, which closes without running `beforeunload` (unload still runs —
what Puppeteer's `page.close()` does), and an in-place
`navigate`/`reload`/`history_go` first makes the main frame's `beforeunload`
handlers unable to CANCEL the leave (`PREPARE_LEAVE_FN`, ONE fixed function that
takes no arguments): for an event whose browser-owned `type` is `beforeunload`,
`Event.prototype.preventDefault` becomes a no-op and the
`BeforeUnloadEvent.prototype.returnValue` setter swallows its write, and the
`onbeforeunload` IDL handler — whose return value the browser applies natively,
out of JS's reach — is lifted off. The page's listeners stay registered and still
run. Its listener LIST is never touched: an earlier version removed and re-added
the listeners, which could not be undone faithfully — the re-add went through
the page's own `addEventListener`, which a listener multiplexer (zone.js, i.e.
Angular) patches, so the guard was silently lost or ran hundreds of times; it
dropped `once`; and a listener the page removed by aborting its `AbortSignal`
came back with no signal left to remove it. A stopping listener of our own is
no alternative: Chrome runs a window's listeners in registration order, capture
or not (measured, Chrome 154), so the page's ones run first. A `#hash` navigate
is left alone — Chrome raises no prompt for it. The rest is about giving the
guard back wherever the page stays:

- **Every path out restores.** `navigate`/`reload`/`history_go` hand the result
  to `rearmIfSameDocument` in a `finally` — a navigation that threw, never
  committed or was cancelled (a child frame's prompt, a dismissed form
  resubmission) leaves the same document, which gets its prototypes and its IDL
  handler back. Only a main-frame loader id that is KNOWN and DIFFERENT skips
  the restore; an unknown one still sends it (the in-page handle is bound to its
  document, so on a new one the call just fails).
- **What the page changes itself stands.** Its listeners were never removed, so
  whatever it adds or removes meanwhile — `removeEventListener`, an aborted
  signal, a `once` listener firing — is the browser's own bookkeeping. A write
  to `onbeforeunload` while it is lifted off is recorded (an accessor over the
  browser's own, taken down by the restore) and wins over the restore. The
  restore never puts a prototype descriptor back over one the page installed
  itself in the meantime.
- **The back/forward cache.** A `beforeunload` listener does not keep a page
  out of it, so a document left disarmed can come back — through `history_go`
  or the human's own Back button — with the same JS heap. The disarm installs a
  `pageshow` listener that restores the document when it returns `persisted`.
- **A disarm that misses its deadline never lands late.** The disarm is
  bounded (`DISARM_DEADLINE_MS`), and a bound does not cancel CDP work already
  under way: past it nothing that changes the page is sent any more, and once
  the one mutating command has gone out the caller gets its handle anyway, so
  the restore follows it in order.

What that means and what it doesn't:

- **The page's own `beforeunload` logic still runs** — a last-moment draft
  save or analytics beacon in a listener happens — except an `onbeforeunload`
  IDL handler, which is off for the leave. Only the cancel is taken away.
- **A human tab keeps Chrome's prompt**: anything without an epoch (the
  human's own tabs, the standalone active-tab fallback), an agent tab the
  human activated or dragged into their own window, and the agent tab that is
  the ACTIVE tab of the FOCUSED window at that moment — a person can type into
  that one without any event marking it theirs (the first tab of an agent
  window that took focus anyway, clicked into inside the 2 s grace that
  discounts our own window creation). Every agent window we create is looked at
  again once that grace is over (armed by the creation itself, so it holds for
  a session's very first window too): still focused, its active tab is marked
  the human's. There the prompt may guard their typing. This is best-effort on
  browser-observed signals, not a guarantee: a person who clicked into a fresh
  agent window, typed, and left Chrome all within the grace is not seen.
- **Best effort, falls back to the old behaviour.** No debugger foothold
  (DevTools open on the tab, a page extensions may not debug) → plain
  `chrome.tabs.remove`, and the prompt can appear — except for the tab reaper,
  which only ever closes quietly: a housekeeping close is never worth a raised
  window, so such a tab is simply not evicted that time. A page frozen on an
  `alert()` gets `DISARM_DEADLINE_MS` (1.5 s) and then navigates with its
  handlers intact. The disarm runs in the page's main world, so the page can see
  the shadowed prototypes while they exist (sub-second, agent tabs only) and
  can keep its prompt — a `preventDefault` it saved before the disarm, a
  `document.body.onbeforeunload` write the accessor does not see: it can only
  annoy, never reach anything. A CHILD frame's handlers are not disarmed.
- **Not covered: navigations the page starts.** A `click` on a link or a form
  submit is a navigation the renderer begins, and the agent's own tool calls
  give no reliable point to intervene before it; such a prompt still raises the
  tab. An `onbeforeunload` handler the page sets again after the disarm and
  before the navigation commits still prompts too. And an extension worker that
  dies between the disarm and the restore (the restore lives in that call)
  leaves the document disarmed for the rest of its life.

### Broker mode: there is no per-session allowlist, and one would not be a boundary

Every session shares one allowlist. A tempting ask — "let this dispatched agent
reach only `localhost`, while my own session keeps its full list" — cannot be
satisfied here in any meaningful sense, and it is worth writing down why rather
than re-deriving it.

Scoping needs a key the daemon can trust. The `clientId` is trustworthy but
ephemeral and server-minted, so there is nothing stable for a human to attach a
policy to. The session label is stable and human-meaningful but **peer-declared**:
any process that can pair can claim any label. And the floor is same-uid — a
process able to reach the socket can already read the secret, pair as anything,
and drive the browser across the whole allowlist. A per-session allowlist would
therefore be a *convenience* (stopping a well-behaved agent from wandering),
never a confinement boundary, and shipping it as a security feature would
misrepresent what it does.

If a session genuinely must be confined more tightly than the user, that is a
different OS-level boundary — a separate uid, container, or VM, each with its own
secret and its own browser.

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
   CDP footprint only widens for users who asked for it. Bound the
   BROWSER-side buffer too where the domain has one (`Network.enable`'s
   `maxTotalBufferSize`/`maxResourceBufferSize` — Chrome's defaults are
   200 MB / 20 MB per tab), and on opt-out revoke the domain best-effort
   (`Network.disable`; release the `'console'` object group before
   `Runtime.disable`, which alone frees nothing) — but never with a command
   whose reach is wider than this session: `Runtime.discardConsoleEntries`
   wipes the human's own DevTools console too. Buffer with a hard
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
   an exact match against the assumed destination — unless Chrome still holds
   a back/forward-cache entry for it, the hop is a live navigation that can
   legitimately redirect, and an exact-match check would misreport a real
   redirect as a cancelled action.
   Report what actually happened (the observed landed URL), not the
   requested one.

## Reporting

There is no formal vulnerability-reporting channel set up for this
project yet. For non-sensitive issues, open a GitHub issue. For anything
you'd rather not disclose publicly, reach the project maintainer
directly via whatever channel you normally use — there is no advisory
email address.
