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
   gate the most damaging actions, and `close_tab` won't even close
   non-allowlisted tabs.
3. **Filesystem exfiltration via `upload`** — the daemon-side sandbox
   (`~/Downloads/sallyport/` by default, override `SALLYPORT_DOWNLOAD_DIR`)
   rejects paths outside the sandbox; `Path.resolve()` defeats symlink
   escapes.
4. **Replay** — every WS frame carries an HMAC, a timestamp (±30 s
   tolerance), and a one-time nonce (4096-entry rolling cache).

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
| Arbitrary JS | Per-domain `allowEvaluate` opt-in; fixed-literal probes (`fetch_in_page` body, keystroke password probe, `snapshot`'s DOM-fallback walker, `screenshot`'s `document.visibilityState` probe, `mouse_click`'s aiming probes — coordinates travel as structured `callFunctionOn` arguments, not interpolation) interpolate no agent input and need only the allowlist | `extension/src/tools/gates.ts:ensureEvaluateAllowed`; `fetch.ts`, `focus.ts`, `domtree.ts`, `screenshot.ts`, `aim.ts` |
| Password input | `fill` reads the `type` attribute via CDP `DOM.getAttributes` (browser DOM, not page JS); `key_type`/`send_keys` probe `activeElement.type` | `extension/src/tools/dom.ts`, `keyboard.ts` |
| Closing tabs | Allowlist-gated like other DOM tools | `extension/src/tools/tabs.ts:closeTab` |
| Filesystem (write) | `save_to_file` sandbox to `~/Downloads/sallyport/` | `daemon/.../local_tools.py:save_to_file` |
| Filesystem (read via Chrome) | `upload` paths must resolve under the same sandbox; symlink-safe | `daemon/.../local_tools.py:validate_upload_paths` + `PRE_CALL_VALIDATORS` |
| Frame size | 16 MiB cap, 1009 close on overflow | `daemon/.../bridge.py:MAX_FRAME_BYTES` |
| Secret file | `chmod 600`, perms warned on relax | `daemon/.../secret.py` |
| Concurrent calls | Daemon `_call_lock` serialises MCP tool calls | `daemon/.../bridge.py` |
| Multiple WS clients | Slot claimed only after verified signed hello; second authenticated client rejected with 1008 | `daemon/.../bridge.py:_handle_client` |
| Unauthenticated slot-squatting / probing | Hello-before-slot + 10 s hello deadline + browser-page Origins refused | `daemon/.../bridge.py:_handle_client` |
| Tab ownership (broker mode) | Daemon `ensure_owns` gate before every tab-touching call; `(clientId,tabId,epoch)` registry; extension epoch confirm | `daemon/.../ownership.py`, `extension/src/tools/ownership.ts` |
| MCP-client auth (broker mode) | Signed `hello` before any disclosure/action; server-minted connection-bound `clientId`; per-connection nonce cache | `daemon/.../broker.py:authenticate_connection` |
| Broker socket exposure | `0600` AF_UNIX socket beside the secret (same uid gate); authenticated-client cap (16), with half-open handshakes bounded separately so a never-hello peer can't consume an earned slot | `daemon/.../broker.py:start_broker_server` |

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
(`bringtofront_forbidden`) so automation can't yank the human's focus. The
diagnostic `status` ring (recent tool outcomes + last error) is owner-scoped too:
a session sees only its own calls, never another client's tools, codes, or
server-minted `clientId` — so the shared ring can't become a cross-client
activity oracle.

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

### Nonce cache lives only as long as the extension's service worker

MV3 service workers are killed after ~30 s of inactivity. The
`Signer`'s in-memory nonce cache (`extension/src/crypto.ts`) goes with
it. A captured WS frame could in principle be replayed inside the
±30 s `MAX_CLOCK_SKEW_S` window in a freshly-spawned SW.

Reconnecting to the same daemon no longer clears the cache: `setSecret`
is a no-op when the secret is unchanged, so a network blip or a daemon
restart keeps the replay window closed on the extension side. The only
remaining reset is genuine SW termination — the gap is bounded by the SW
lifetime, not by every reconnect.

**Exploitability:** very low. Everything is loopback, so capture requires
local root or a kernel-level shim, and timing requires the SW to be down
exactly when the replay arrives. The daemon side's nonce cache is
process-lifetime, so a replay against the daemon (which is the actual
target) is always caught.

**Possible fix:** persist `seenNonces` in `chrome.storage.session` —
not done because the storage write per frame is a real overhead and the
practical exposure is near-zero.

### Password probe: closed shadow roots and cross-origin iframes

The keystroke gate (`key_type` / `send_keys`) finds the focused element
by walking `document.activeElement` down through **open** shadow roots
(`fill` resolves a specific node by selector/ref and reads its `type`
attribute via CDP `DOM.getAttributes`, so it is immune to the in-page
getter trick below). Two cases the keystroke gate cannot reach:

- **Closed shadow roots.** `element.shadowRoot` is `null` to page
  script for `attachShadow({mode:'closed'})`, so a focused
  `<input type=password>` inside a closed root is invisible to the
  probe. Open roots (the default and overwhelmingly common case) are
  covered.
- **Iframes (any origin).** The probe runs in the top frame and descends
  only `.shadowRoot`, never `.contentDocument`, so `document.activeElement`
  returns the `<iframe>` element, not the focused element inside it.
  Typing into a password field inside *any* iframe — same-origin or
  cross-origin — isn't caught.
- **Hostile in-page getters (keystroke gate only).** The keystroke probe
  reads the focused element's `type` / `shadowRoot` via `Runtime.evaluate`.
  A page that defines a throwing getter for one of those makes the probe
  throw; the result then reads as `undefined` and the keystroke gate
  passes. `fill` is **not** affected: it reads the `type` attribute from
  the browser's DOM via CDP `DOM.getAttributes`, which a page cannot
  shadow with a throwing or lying JS accessor, and fails closed if the
  node can't be read.

**Exploitability:** the agent must (a) drive focus into the closed root
/ iframe and (b) the page (or iframe) must be on an allowlisted domain —
a site the user already trusted. Real but narrow blind spots, and only
for `key_type` / `send_keys`; `fill` into the same field reads the DOM
attribute directly and is caught regardless of in-page getters.

**Possible fix:** resolve the focused node at the CDP `DOM` level (which
can pierce closed roots) and walk frames via `Target.getTargets` — the
same approach `fill` already uses for its node. Not done for the
keystroke gate yet — it adds CDP round-trips on every keystroke tool call
for a narrow, already-trusted-origin case.

### Audit log persistence depends on `chrome.storage.local` quota

Even with per-entry truncation (`MAX_AUDIT_STRING = 1024`), 500 entries
× ~5 KB headroom = ~2.5 MB, well inside the 10 MiB quota. A pathological
agent that spams huge structured arg objects could in principle still
push it. The truncation walks objects/arrays recursively, so unusual
shapes don't slip through unbounded.

**Typed credentials are redacted.** When `fill` / `key_type` /
`send_keys` run with `allowPassword=true` (the only way text reaches a
password field), the typed value is replaced with a length placeholder
before it is written to the audit log, so passwords are not retained at
rest or surfaced by the popup's Export. Values typed into non-password
fields are kept verbatim — that is the point of a visible audit trail —
so treat the exported log as containing whatever the agent typed into
ordinary inputs.

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

### Broker mode: tool calls are fair-by-arrival, not round-robin-fair

All MCP tool calls across all sessions serialise through one daemon lock (the
single browser can do one thing at a time, invariant #8). The lock is FIFO **by
arrival**, so a session that pipelines many calls can delay a latecomer from
another session until its queue drains. Every call is still bounded by the 60 s
request timeout, and `status` answers without taking the lock, so a stall is
always attributable. A per-owner round-robin scheduler is designed but deferred
(it is a fairness optimisation on an already-correct lock, and a custom scheduler
in the per-call critical path carries more risk than the benefit warrants for
v1). DoS here is **within the trusted set** (the user's own sessions).

### Broker mode: the dedicated agent window is presentation, not isolation

Agent-created tabs open in one non-focused window to keep them out of the human's
way. Ownership never keys on `windowId` (the human may drag a tab between
windows), so the window is purely cosmetic separation — it is **not** a security
boundary. Confinement is the daemon ownership gate, not the window.

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
   `console_tail` / `console-capture.ts`)? Keep it opt-in behind a popup
   setting (default off) and enable the underlying domain (`Runtime.enable`,
   …) lazily — never on the unconditional `attach()` path, so the observable
   CDP footprint only widens for users who asked for it. Buffer with a hard
   per-tab cap, clear on `tabs.onRemoved` / `debugger.onDetach`, and tag each
   captured item with its producing origin so reads can be filtered to the
   allowlist (fail-closed on an unknown origin — a tab can navigate
   cross-origin while buffering, so the read-time tab URL alone isn't enough).

## Reporting

There is no formal vulnerability-reporting channel set up for this
project yet. For non-sensitive issues, open a GitHub issue. For anything
you'd rather not disclose publicly, reach the project maintainer
directly via whatever channel you normally use — there is no advisory
email address.
