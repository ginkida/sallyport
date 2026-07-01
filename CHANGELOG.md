# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
uses [Semantic Versioning](https://semver.org/).

## [0.12.0] — 2026-07-01

### Added

- **Broker mode — one browser, many Claude Code sessions, the human too.** A new
  `sallyport-daemon broker` runs one long-lived process that owns the single
  extension/WS leg and serves **N** Claude Code sessions at once over a `0600`
  **AF_UNIX socket** (`broker-<port>.sock`, beside the secret). Plain
  `sallyport-daemon` sessions **auto-detect** a running broker and attach to it
  as a thin **stdio shim** (framed, HMAC-signed relay) — registration is
  unchanged (`claude mcp add …`), and with no broker present they run standalone
  exactly as before. The socket is the loopback-bind analogue (invariant #2): the
  kernel uid gate that protects the secret protects the socket. AF_UNIX, not a
  loopback TCP port, so no other-process-reachable surface is opened.
- **Per-client tab ownership (new invariant #13).** In broker mode each session
  may act **only on tabs it created**; the human's tabs and other sessions' tabs
  are invisible and untouchable. The daemon is the authoritative gate (it alone
  knows the per-connection, server-minted `clientId`); tabs are keyed
  `(clientId, tabId, epoch)` where the extension mints a create-time `epoch` so a
  recycled Chrome tabId can't silently retarget a call. The extension is an
  identity-blind defence-in-depth layer (epoch confirm → `tab_gone`; `epochByTab`
  persisted to `chrome.storage.session`, reconciled on service-worker wake).
- **MCP-client auth, earned-not-grabbed (new invariant #14).** A shim must prove
  a valid signed `hello` (reusing the same HMAC `Signer` the extension uses,
  per-connection nonce cache) before anything is disclosed or done — the
  multi-slot analogue of the extension's hello-before-slot gate. A connecting
  peer learns nothing on failure (no reason echoed).
- **Owner-scoped `list_tabs`.** In broker mode `list_tabs` returns only the
  caller's own tabs — filtered at the extension (to agent-created tabs) **and**
  re-scoped per-client at the daemon, **fail-closed** (unknown/empty owner → empty
  list, never the whole profile). Invariant #3's "`list_tabs` is the only ungated
  tool" tightens to "owner-scoped at both layers" in broker mode.
- **Owner-scoped `status`.** In broker mode the diagnostic ring (recent tool
  outcomes + last error) is scoped per caller: a session sees only its own calls,
  never another client's tools, codes, or server-minted `clientId` — the shared
  ring can't become a cross-client activity oracle. Standalone keeps the full view.
- **Focus-theft mitigation.** Agent-created tabs open in a dedicated, **non-focused**
  window (`focused:false`) with `active:false`, kept out of the human's windows so
  automation never steals focus or clutters their workspace; `screenshot`'s
  `bringToFront` is refused in broker mode (`bringtofront_forbidden`). A tabId-less
  `navigate` in broker mode is a **create-own** (a fresh owned tab) rather than a
  clobber of the human's focused tab.
- **New error codes** (with recovery hints): `tab_required` (a tab-touching tool
  called with no tabId in broker mode — the active-tab fallback is disabled),
  `tab_not_owned` (collapses not-yours / never-existed / recycled so it is not an
  existence oracle), `tab_gone` (a tab you owned closed or was recycled),
  `bringtofront_forbidden`.
- **Connection cap, earned-not-grabbed** (`MAX_BROKER_CLIENTS = 16`): the cap
  counts **authenticated** clients. A connection arriving with no free slot is
  refused before auth (no disclosure); half-open handshakes are bounded by a
  separate budget, so a never-hello peer can occupy only a short-lived pending
  slot — never an earned client slot — and can't lock real sessions out (bounding
  resource use against a runaway client, DoS within the same-uid trusted set).
- **Long-lived broker is recognised, not reaped.** A detached broker re-parents to
  PID 1 and would otherwise look like a stale orphan; its pidfile is stamped
  `mode: broker` and its command is detected, so `doctor --kill-stale` and the
  port-reclaim guard report it and leave it running (stop it with `kill <pid>`).

The wire format is **unchanged** — broker mode adds a new internal channel
(broker↔shim envelopes of type `mcp`) and one additive `hello_ack` body field
(`{broker: bool}`); `PROTOCOL_VERSION` stays `1` and the canonical-JSON vectors
are untouched. Standalone mode is byte-for-byte the previous behaviour.

## [0.11.2] — 2026-06-29

### Changed

- **Popup Status tab rebuilt for simplicity.** The most-used screen now leads
  with what matters: a one-line summary (sites allowed · calls in the last
  hour), a prominent **This tab** card with a single **+ Allow this site**
  button, and a new **Recent activity** strip — the last few tool calls
  (✓/✕ + tool + relative time) plus the latest error — so you can tell "it
  threw and the page is wedged" from "merely slow" without opening the Audit
  tab. Settings (keep-awake, capture-console) and Advanced (Daemon URL, tools
  list) are now two clearly-labelled disclosures instead of one catch-all
  "Advanced", so the 0.11.1-fixed console-capture toggle is easy to find. The
  duplicate "add any other domain" box (the Allowlist tab already does this)
  and the bulky stat cards are gone, and Unpair is de-emphasised next to
  Pause/Reconnect. Extension-only — the daemon is unchanged.

## [0.11.1] — 2026-06-25

### Fixed

- **The status popup's "Advanced" section is reachable again** — keep-awake,
  the Daemon URL, the tools list, and 0.11.0's new "capture page console
  errors" toggle. `#status-advanced` carried a `hidden` class (`display:none`)
  since the first public release (v0.2.0) that nothing ever removed, so the
  whole `<details>` was dead. It went unnoticed because every control inside it
  had a working default — until 0.11.0 added the off-by-default
  `captureConsole` toggle, which then couldn't be switched on from the UI (so
  `console_tail` couldn't be enabled). Removed the stray `hidden`; the
  disclosure now shows (collapsed) whenever the extension is paired, and the
  Daemon URL is reachable even while disconnected. Extension-only — the daemon
  is unchanged from 0.11.0.

## [0.11.0] — 2026-06-25

### Added

- **`console_tail` tool — see the page's console errors instead of looping a
  silently-broken page.** A click could succeed, a snapshot could succeed, yet
  the page's JS quietly threw and wedged — with zero signal. `console_tail`
  surfaces recent `console.error`/`warning` + uncaught exceptions per tab as
  `{enabled, entries:[{ts, level, text, origin}], truncated?}`. This is the
  first `chrome.debugger.onEvent` surface in the project, so it is deliberately
  conservative: **opt-in** (a new popup setting, default off — when off the tool
  returns `{enabled:false, entries:[]}`, not an error); the `Runtime.enable`
  that turns events on is issued **lazily and only when the setting is on**,
  never on the unconditional `attach()` hot path; the buffer is a bounded
  per-tab ring (≤50 entries × ≤1024-char text) cleared on tab close / debugger
  detach; and reads are **origin-filtered to the allowlist** (each entry tagged
  with its producing-script origin from the event stack trace, fail-closed on an
  unknown origin) so a tab that navigated cross-origin while buffering can't
  leak a non-allowlisted origin's console. Capture starts at the first attach
  with the setting on — no history replay. Pure CDP event subscription: no
  `Runtime.evaluate`, no interpolation.
- **Tool errors can carry structured `detail` — `select_option`'s not_found is
  the first.** A failure's rich data (for `select_option`, the available
  options + the missing keys) was collapsed into English prose, forcing the
  agent to regex the option list back out of the message. `BridgeError` now
  takes an optional `detail` that rides the tool_result error body (additive
  key — the MAC covers the body wholesale, so `PROTOCOL_VERSION` stays 1) and
  the MCP layer appends it as a compact, parseable `detail: {…}` JSON line under
  the error (the human line + recovery hint are unchanged). `select_option`'s
  not_found populates `detail={missing, available:[{value,label}]}` (already
  capped at 50 options) so the agent can re-issue programmatically. By
  construction `detail` carries only structural metadata — `<option>`
  value/label, keys, counts, indices — **never a value read from a node**, so it
  opens no password-readback channel (tests pin that the password-gated paths
  populate no detail, and that only not_found among select failures does). An
  oversized detail is dropped rather than truncated into unparseable JSON.
- **`status` now carries a recent-call ring + last error for stall
  attribution.** "It just timed out" gave a loop nothing to act on. The daemon
  now keeps a small bounded ring (`LAST_CALLS_MAXLEN`=10) of recent tool
  **outcomes** and surfaces them via the existing `status` builtin:
  `lastCalls:[{tool, ok, ms, code?}]` (oldest→newest) plus
  `lastError:{tool, code, error}` (or null). It records outcomes only — tool
  name, ok, integer wall-clock ms, and the `BridgeError` code — and **never the
  args** (which for `fill`/`key_type`/`send_keys` carry credentials; a test
  enforces no leak), with the error string capped. `status` stays a pre-lock
  builtin (it still answers `connected:false` with no extension and never
  queues behind a running call), and is itself never recorded.
- **`hover` tool — pointer hover without a click.** CSS `:hover`-only dropdown
  menus, tooltips and "show actions on row hover" UIs were reachable only by
  clicking something first (which often dismisses or mis-activates). `hover`
  issues just the `Input.dispatchMouseEvent{mouseMoved}` step `mouse_click`
  already sends as its hover preamble — no press/release, so nothing is
  activated (strictly weaker than a click). Target is a selector/@eN (auto-aimed
  with the same overlay diagnostics as `mouse_click` — `covered`/`hitTargetRef`)
  or explicit viewport `x`/`y`; pair with embedded `waitFor` to
  hover→wait-for-menu in one call. The `:hover` state is transient (a synthetic
  mouseMoved holds it only until the next move). `mouse_click` and `hover` now
  share the pure `parsePointerTarget` disambiguation and the
  `validateViewportPoint` guard.
- **`scroll` tool — deterministic, predicate-less scrolling.** `reveal` only
  scrolls while hunting a target predicate and stops the moment it matches, so
  there was no way to "just page down to trigger a lazy-load / infinite-scroll
  feed" or "bring this element into view" without `evaluate`. `scroll` fills the
  gap: `selector` → `scrollIntoView({block:'center'})`, or scroll the page (or a
  `selector` container) by a `dx`/`dy` delta (negatives scroll up/left) or
  `to:'top'|'bottom'`. The result `{x, y, scrollHeight, atBottom}` tells a
  lazy-load loop when it has bottomed out. Structured CDP only — fixed
  `SCROLL_BY_PROBE`/`SCROLL_INTO_VIEW_PROBE` literals with the deltas and the
  `to` keyword carried as structured `callFunctionOn` arguments (never
  interpolated, the blessed `SCROLL_STEP_PROBE` shape), so no per-domain
  `evaluate` flag; allowlist-gated; the `@eN` ref space is untouched.

- **`get_state` tool — a cheap single-element liveness/visibility/box/text
  probe.** The dominant cost in an automation loop is verification: after
  every action the only way to ask "is `@e5` still there / visible / did its
  text change / where is it now" was to re-`snapshot` the whole page (tens of
  KB, a full `@eN` ref-space reset) and re-find the element. `get_state`
  answers that in one tiny round-trip and — critically — never throws for a
  vanished node: a missing element returns `{exists:false, reason}`
  (`not_found` for a CSS miss, `unknown_ref` for an `@eN` this tab never
  minted or lost on navigation, `detached` for a ref whose node died), so it
  is safe to poll instead of ending a loop on `bad_ref`. A hit returns
  `{exists:true, visible, tag, text, box?, inViewport?, ref?, role?, name?}`
  with `box`/`inViewport` in viewport-relative CSS px (the same coordinates
  `mouse_click`'s `x`/`y` take). Structured CDP only — a FIXED probe literal
  with the text cap as its sole structured argument (the same trust shape as
  `read_text`), so no per-domain `evaluate` flag — allowlist-gated, mints no
  refs, and reads **no** input `.value` (it cannot expose a password field's
  contents).
- **CDP debugger-attach failures now carry a stable, classified error code.**
  Every tool attaches the debugger first; when that failed the raw Chrome
  string ("Cannot access a chrome:// URL", "Another debugger is already
  attached…", "No tab with given id…") propagated code-less, so an autonomous
  loop had nothing to branch on and would retry blindly. `attach()` now maps
  the rejection (`cdp.ts:classifyAttachError`) to `attach_forbidden_url`
  (restricted page — give up), `attach_debugger_conflict` (DevTools/another
  client/tab mid-drag — retryable), `attach_target_closed` (tab gone — drop
  this tabId), or `attach_failed` (anything else, original text preserved).
  Best-effort overlay: Chrome's wording isn't a stable API, so an unmatched
  message still surfaces as `attach_failed` rather than being swallowed, and
  the echoed text is capped at 200 chars (it can embed a page URL). The
  existing "already attached → assume it's our own prior attachment, proceed"
  behaviour is unchanged.
- **Embedded `waitFor` outcomes now carry a `reason` on the not-found path.**
  The embedded wait folds its errors into the result (the action it followed
  already succeeded, so a wait blow-up must stay non-fatal), which meant a
  typo'd CSS selector (permanent), a stale `@eN` after a re-render
  (re-snapshot), and a not-yet-present element (retry) all collapsed into the
  same `{found:false}` — so an agent would burn a full 30 s poll on a condition
  it had itself malformed. `WaitOutcome` gains `reason?:
  'timeout'|'bad_ref'|'invalid_selector'|'error'` (`poll.ts:classifyWaitError`):
  `timeout` from `pollFor` (so standalone `wait_for` gets it for free), the
  others derived in the embedded path's catch. No wire change — `reason` rides
  the existing tool-result data, not the envelope, so no canonical-vector
  regeneration.
- **Tool errors now carry a machine-readable recovery hint.** A frozen
  daemon-side table (`error_taxonomy.py`) keyed by the stable error codes
  appends one compact `hint: retryable=yes|no; …` line after the existing
  `Error [code]: message` text (the human line is unchanged), so a tight
  autonomous loop can branch "when I see code X do Y" — retry a stale `bad_ref`
  after a fresh snapshot, give up on a `domain_not_allowed` (the user must
  allowlist it), open a custom combobox with `click` on `wrong_element`, and so
  on — across every tool with zero per-tool wiring. The hints describe only
  user-driven popup steps or structured-tool alternatives and never advertise
  `allowPassword`/`allowEvaluate` as automatic actions (a test enforces this);
  another test pins the table's keys to the real thrown-code universe so a
  renamed code can't leave a dead hint behind. Codes that are success-not-error
  (`wait_for`/`settle` returning `found:false`) deliberately have no entry.

## [0.10.0] — 2026-06-19

Connection-reliability pass: the bridge would intermittently go "now it
works, now it doesn't" because the MV3 service worker slept between tool
calls (dropping the socket) and then sat out a 30 s reconnect backoff —
while diagnosing it meant reading `lsof` and the worker console.

### Fixed

- **The service worker no longer sleeps mid-session and silently drops the
  WS.** While connected the extension now sends an application-level `ping`
  every 20 s; the daemon answers `pong`. WebSocket traffic resets MV3's ~30 s
  idle timer (Chrome 116+), so the worker — and the socket — stay alive
  between tool calls instead of being torn down and rebuilt on the next
  action. A recurring `chrome.alarms` keep-alive (0.5 min) is the backstop:
  if Chrome suspended the worker anyway, the alarm wakes it and reconnects,
  so the connection self-heals without waiting for the user to act. The
  daemon's existing `ping`/`pong` handlers (previously dead code, "reserved")
  are now the live keep-alive path.
- **Reconnect backoff is short for the loopback daemon.** The cap dropped
  from 30 s to 5 s (`RECONNECT_MAX_MS`): the daemon is on `127.0.0.1` and its
  common outage is a sub-second Claude-Code restart window, so a 30 s cap left
  the popup looking dead long after the daemon was back. Opening the popup now
  also fires an immediate reconnect attempt (once per disconnected episode)
  instead of sitting through the remaining backoff.
- **The popup can no longer show a stale "connected".** It polls the live
  status every 2 s while open, so a worker that was suspended (and therefore
  pushed no status update) can't leave a misleading green state on screen.

### Added

- **`doctor` reports live extension connectivity and the last rejected
  handshake.** A long-lived daemon now keeps a volatile
  `daemon-<port>.status.json` next to its pidfile, rewritten on every
  connect / disconnect / rejected-handshake. `doctor` reads it (cross-checking
  the writer PID against the process actually listening on the port, mirroring
  its pidfile check, so a stale or PID-reused snapshot is ignored) and prints
  `extension: connected (for Ns)` or `extension: NOT connected` plus
  `last rejected handshake: …`. This turns the previously console-and-`lsof`-
  only diagnosis — e.g. an extension paired with the wrong secret — into an
  up-front line. The file never holds secret material; the handshake reason is
  daemon-authored or a `ProtocolError` string, capped defensively.

## [0.9.0] — 2026-06-19

### Added

- **`select_option` tool — drive native `<select>` dropdowns reliably.** A
  native `<select>`'s popup is drawn by the OS menu layer, not the page
  renderer, so CDP `Input.*` events never reach it (keys ignored, `Escape`
  dismisses) — there was no working way to choose an option. `select_option`
  does what every mature framework does: it sets the selection in the DOM and
  fires bubbling `input` + `change`, never opening the popup. Choose by `value`,
  `label` (visible text), or `index`; pass an array for `<select multiple>`.
  Single-select uses the native `HTMLSelectElement` value setter (the React-safe
  path `fill` uses); multi-select sets `option.selected`. Allowlist-gated and
  needs **no** `allowEvaluate` — the function body is a fixed literal and the
  choice travels as a structured `callFunctionOn` argument (same trust shape as
  the aim probes). Errors: `wrong_element` for non-`<select>` targets (custom JS
  comboboxes like react-select/MUI live in the DOM — keep using
  `click`/`find`/`reveal` for those, and the message says so), `not_found`
  (lists the available options), `bad_args` for a disabled option/select or an
  array against a single-select. The matcher (`planSelection`) and arg parser
  (`buildSpec`) are pure and unit-tested.

## [0.8.1] — 2026-06-17

Robustness + correctness pass, driven by real-session feedback on 0.8.0:
daemon process/connection handling, the `fill` footgun, and hardening of the
new SPA tools.

### Added

- **`snapshot` (compact) and `find` surface an input's `type`.** A field whose
  accessibility role reads `textbox` but is actually `<input type=password>` is
  now visible (`type: "password"`) before you act on it, so a mislabelled ref
  is no longer a surprise at fill time. DOM-sourced snapshots only (the a11y
  path can't read it cheaply); the field value itself is still never exposed.

### Fixed

- **The daemon no longer proliferates when the port is held.** A startup
  single-instance guard probes the bind before serving: it reclaims the port
  from an *orphaned* sallyport daemon (parent died — a dead session's leftover,
  SIGTERM + re-probe) or refuses to start with a clear message naming the
  holder, instead of spawning a second daemon that fails to bind deep in an
  async task and lingers as a zombie fighting for the port. A live-session
  daemon or a non-sallyport process is never auto-killed.
- **`status` reflects real WebSocket liveness.** `connected` now reads the
  socket's protocol state (`OPEN`) instead of a merely-non-null reference, so a
  half-open / closing connection reports `connected: false` rather than lying
  `true` just before a tool call fails with `extension is not connected`.
- **`fill` (method=value) no longer silently no-ops on React-controlled
  inputs.** After setting `.value` it reads the value back; if a framework
  reverted it, it auto-falls-back to the keyboard-level `insertText` path (the
  result then carries `mode: "insertText"`, `fallbackFrom: "value"`) instead of
  returning `ok: true` on an empty field. The password gate still runs first,
  so the fallback can't slip text into a password field.
- **`settle` no longer reports `settled: true` when the quiescence probe never
  yields a reading.** A value-less probe response (page-side eval threw, so
  `Runtime.evaluate` returned no value) was substituted with a fixed
  `{n:-1,len:-1}` sentinel, so two consecutive failures compared equal and
  falsely satisfied the stability window. A reading-less tick now conservatively
  restarts the window, so `settle` can only succeed on two genuine equal
  readings and otherwise falls through to `settled: false` at the cap. The
  per-tick decision is extracted as the pure `advanceSettle` and unit-tested
  (this also indirectly hardens `reveal`, whose inter-step adaptive settle reuses
  it).

### Changed

- **MCP schema descriptions tightened to match handler output:** `reveal`'s
  `source` is marked optional (returned only on the found path), `settle`
  documents the `stableMs` cap (≤10 000), and `find` documents the optional
  `truncated` flag (set when the underlying snapshot was capped).
- **`reveal`/`find` arg parsing and `reveal`'s stall heuristic extracted into
  pure, unit-tested helpers** (`parseMaxSteps`/`scrollStalled` in `poll.ts`,
  `parseLimit` in `match.ts`) — no behaviour change, closing the test gap on the
  documented `limit ≤50` / `maxSteps ≤40` caps and the scroll-end detection.

## [0.8.0] — 2026-06-17

SPA-robustness release: three generic, site-agnostic tools that make heavy
single-page apps (Telegram Web, Threads) reliably driveable — semantic
location, virtualized-list reveal, and DOM-quiescence waiting. All reuse the
fixed serialized-probe pattern (agent input only as structured arguments,
never interpolated), stay behind the allowlist, and need no `allowEvaluate`,
so the trust model is untouched.

### Added

- **`find` — semantic locator** — snapshot the page and return `@eN` refs of
  interactive elements matching a predicate (`role` exact or one-of, `name`
  substring / `nameExact`, `value`), ranked exact-name-first and capped by
  `limit`. Replaces guessing brittle CSS against framework-hashed classnames
  on SPAs. The match runs extension-side over the snapshot's flat element list
  (`match.ts`) — `find` adds no page probe of its own, so it needs no
  `allowEvaluate`. Empty matches is a normal not-found, not an error.
- **`reveal` — scroll a virtualized container until a target appears** — so
  off-screen list items (older chat messages, feed posts) that have no `@eN`
  become reachable. Re-resolves the `container` and re-snapshots each step;
  terminates on found, stall (reached the end), `maxSteps` (≤40), or
  `timeoutMs` (≤30 000). Uses a fixed scroll probe with the direction as a
  structured argument (no `allowEvaluate`); scrolls the page as a side effect
  (within `mouse_click`'s precedent).
- **`settle` — DOM-quiescence wait** — wait until the DOM stops changing for
  `stableMs` (element count and body size both steady), the adaptive
  replacement for a blind sleep after an action on a busy SPA. Fixed
  quiescence probe (reads only `.length`, never field content), polls every
  250 ms up to `timeoutMs` (≤30 000). A page that never quiesces (live feed,
  animation) returns `settled: false` at the cap — not an error.

### Changed

- **`snapshot`'s a11y-vs-DOM tree-building extracted into `buildSnapshotTree`**
  (no behaviour change) so `find` and `reveal` reuse the exact same decision
  and per-tab ref choreography instead of duplicating it.

## [0.7.0] — 2026-06-12

Loop-efficiency release: an agent iterating on a schedule pays per
round-trip (a whole model turn each) and per result byte — this release
attacks both.

### Added

- **Embedded `waitFor` on `navigate`, `click`, `mouse_click`, `fill`** —
  action + wait-for-its-effect in ONE call: after the action succeeds, the
  extension polls (same engine as `wait_for`, shared `poll.ts`) until a
  selector/text is present — or gone, with `absent: true` — and the result
  gains `wait: {found, elapsedMs}`. A wait timeout or a wait error (stale
  ref, bad CSS) never fails the action itself; it is folded into the `wait`
  field. This halves the calls of the dominant act→wait→act loop pattern.
- **`wait_for` gains `absent: true`** — wait until the selector/text is
  GONE (spinner finished, modal closed, message left the outbox).
- **`snapshot` gains `selector`** — scope the snapshot to one subtree (CSS
  or `@eN`; always a DOM walk, `source: 'dom'`). On chat-style SPAs,
  snapshot just the panel being worked (dialog list, composer) instead of
  the whole page; combines with `compact` for the smallest possible result.
- **`status` tool** — instant daemon/extension health check answered by the
  daemon itself: no browser round-trip, and it deliberately does NOT queue
  behind the per-call lock, so it answers even while a slow tool call is in
  flight. Returns `{connected, version, port, pendingCalls, uptimeS}`. Loop
  preflight: `connected: false` → skip the browser work instead of burning
  a 60 s timeout. Works with `sallyport-daemon exec status` (no extension
  wait).

### Changed

- **`read_text` caps output at 20 000 chars by default** (override with
  `maxChars`); a cut result carries `truncated: true` + `totalChars`.
  Whole-page reads on chat SPAs ran to 60 KB+, blowing the MCP tool-result
  budget into a file detour.

## [0.6.0] — 2026-06-12

### Added

- **Keep-awake: driven tabs no longer freeze in the background.** Chrome
  freezes background tabs and (on macOS) fully-occluded windows — JS stalls,
  pages stop loading, dispatched clicks sit in a dead queue the moment the
  user looks at another window. On every tool call the extension now
  re-asserts `Page.setWebLifecycleState('active')` +
  `Emulation.setFocusEmulationEnabled(true)` on the attached tab:
  the tab stays unfrozen and believes it is focused, so SPA
  "I'm in background" logic stays off. Best-effort (older Chrome degrades
  to the previous behaviour); the effect ends at debugger detach. Paint is
  deliberately not covered — `visibilityState` stays `hidden`, so
  `screenshot` still wants a visible tab (`tab_not_visible` /
  `bringToFront`). Side effect worth knowing: a page that believes it is
  active behaves like one (Telegram sends read receipts / presence during
  automation) — new popup toggle **Advanced → keep automated tabs awake**
  (default on) turns it off.
- **`mouse_click` auto-aims around partial overlays.** Instead of always
  clicking the geometric center, the probe (pure `aim.ts`, unit-tested,
  still a fixed literal) hit-tests the center plus four points pulled
  toward the corners and clicks the first one where the target is actually
  the topmost element — badges/ripples/avatars covering the center no
  longer eat the click silently.
- **`mouse_click` mints a ref for the covering node.** When every probe
  point is covered, the result now carries `hitTargetRef` — a real per-tab
  `@eN` for the overlay (alongside the textual `hitTarget`), so "click the
  thing that ate it" is a single follow-up call instead of a dead end.
- **`mouse_click` accepts explicit coordinates** — `x`/`y` (viewport CSS
  px, mutually exclusive with `selector`) as the manual escape hatch: aim
  from a `screenshot` region or the hit diagnostics. Points outside the
  viewport are rejected with `bad_args` (CDP would silently drop them);
  the result reports what sat under the point.
- **README: Troubleshooting rows for frozen/occluded tabs** — the keep-awake
  toggle, Chrome's "Always keep these sites active" exception, occlusion
  flags, and why a sliver of visible window is enough for screenshots.

## [0.5.1] — 2026-06-12

### Fixed

- **`snapshot`'s DOM fallback now triggers on suspiciously sparse a11y trees,
  not only empty ones.** After a hash-navigation in Telegram Web K the page
  was fully rendered but Chrome kept a stale a11y tree whose single
  "interactive element" belonged to a third-party extension — one ref is
  "formally interactive", so the 0.4.0 fallback (zero refs) never fired.
  In auto mode, fewer than 4 interactive elements now runs the DOM walk as a
  cross-check and whichever side finds more actionable elements wins (ties
  keep a11y — richer semantics; a cross-check failure never loses a working
  a11y tree).

### Added

- **`mouse_click` reports where the events actually landed.** The measure
  probe (still a fixed literal) now hit-tests the click point with
  `elementFromPoint` from the element's own root (open shadow trees resolve
  to the inner node). When the topmost node there is not the target or one
  of its descendants, the result carries `covered: true` and a `hitTarget`
  descriptor (tag#id[aria-label]). Diagnostic only — the click is dispatched
  either way, since the covering node may be the app's legitimate
  event-handling layer, but a click that "did nothing" now says who ate it.

## [0.5.0] — 2026-06-12

### Added

- **`screenshot` fails fast on hidden tabs instead of hanging 60 s.** Chrome
  freezes the renderer of background tabs and occluded windows, so
  `Page.captureScreenshot` waits for a frame that never comes and the call
  dies at the daemon's 60 s timeout. The extension now probes
  `document.visibilityState` first (a fixed literal, no agent input — same
  trust shape as the other fixed probes) and returns a structured
  `tab_not_visible` error immediately. New opt-in `bringToFront: true`
  activates the tab via `Page.bringToFront` before capturing — explicit
  because it visibly steals the user's tab/window focus.
- **`snapshot` gains `compact: true`** — returns a flat `elements` list of
  just the actionable elements (`{ref, role, name, value?}`) instead of the
  full tree. On text-heavy SPAs this shrinks the result by an order of
  magnitude when the agent only needs something to click.
- **`doctor` names the process holding the port** — PID, uptime, command
  (via `lsof`/`ps`, best-effort), and the daemon version + start time from
  the new diagnostic pidfile (`daemon-<port>.pid` next to the secret,
  written by long-lived daemons, removed on clean shutdown). Orphaned
  holders are flagged as such.
- **`doctor --kill-stale`** — SIGTERMs orphaned `sallyport-daemon` processes
  (parent is PID 1, i.e. the session that spawned them is dead). Daemons
  whose parent is alive are listed but deliberately left running; survivors
  of SIGTERM are reported, never SIGKILLed automatically.

### Changed

- **`snapshot`'s a11y tree is drastically smaller.** `InlineTextBox` nodes
  (per-line layout fragments duplicating their parent's text), empty leaves,
  and text children that merely repeat the parent's accessible name are now
  always pruned — they carry nothing the agent can act on, and on real SPAs
  they were most of the payload (Telegram Web K: 63 KB → a few KB). The
  builder moved to `extension/src/tools/axtree.ts` (pure, unit-tested).
- **`mouse_click` dispatches the full pointer sequence** — `mouseMoved`
  (hover) → press → release with human-ish delays (30/60/80 ms) and
  `pointerType: 'mouse'`, instead of a bare instantaneous press+release.
  SPAs that gate navigation on a complete pointer sequence (React routers)
  rejected the old shape.
- **The daemon shuts itself down when its parent process dies.** Stdin EOF
  remains the primary lifecycle signal, but if the MCP client crashes while
  another process still holds the write end of the stdin pipe, EOF never
  arrives — the daemon used to linger as a zombie holding the port and
  running stale code. A watchdog now detects re-parenting to PID 1 (poll
  every 5 s) and triggers the normal clean shutdown. Daemons deliberately
  started under init/launchd are exempt.

## [0.4.0] — 2026-06-12

### Added

- **`wait_for` tool** — wait until a CSS selector / `@eN` ref is present and
  visible, and/or until the page's visible text contains a substring, polling
  every 250 ms up to `timeoutMs` (default 10 s, capped at 30 s — safely under
  the daemon's 60 s request timeout). Replaces blind `sleep`s between
  actions. A timeout returns `{found: false}` rather than an error, so the
  agent can decide what to do next. Selector presence is checked with
  structured CDP only (`DOM.querySelector` + `DOM.getBoxModel`); the text
  probe reuses `read_text`'s fixed function. Allowlist-gated.
- **`snapshot` DOM fallback for a11y-blind SPAs.** When the accessibility
  tree exposes no interactive elements (Telegram Web K renders an essentially
  empty tree), `snapshot` now falls back to walking the DOM — visible text
  plus interactive elements (tag/ARIA-role/contenteditable/tabindex
  heuristics) with the same per-tab `@eN` refs, so `click`/`fill`/`read_text`
  work unchanged. The walker (`extension/src/tools/domtree.ts`) is a FIXED
  serialised literal with no agent input interpolated — the same trust shape
  as `fetch_in_page`'s fixed body, so it does not require the per-domain
  `evaluate` flag. It descends open shadow roots, prunes hidden /
  `aria-hidden` subtrees, reads only the `value` *attribute* of text inputs
  (never live values, never passwords), and caps output (400 refs / 2000
  nodes / 200 chars per fragment) with a `truncated` flag. The result gains a
  `source` field (`'a11y'` | `'dom'`); `mode: 'auto' | 'a11y' | 'dom'`
  forces a path.
- **`fill` gains `method: 'insertText'`** — clears the field (select-all +
  `execCommand('delete')`, with a native-setter fallback) and types the value
  through CDP `Input.insertText`, producing real input events. Use it for SPA
  editors that ignore programmatic `.value` or concatenate texts (Telegram,
  Slack, draft.js). The password gate applies exactly as before; the value
  itself never enters the fixed clear function — it travels only through
  `Input.insertText`. Default `method: 'value'` is unchanged.
- **`screenshot` gains `maxWidth` and `region`.** `maxWidth` downscales the
  capture to at most that many CSS px wide; `region` crops to a
  viewport-relative rectangle (`getBoundingClientRect` coordinates),
  intersected with the viewport. Both map to `Page.captureScreenshot`'s
  `clip` (math in `extension/src/tools/clip.ts`, unit-tested).

### Changed

- **`screenshot` results are now a native MCP image content block** instead
  of base64 inside a JSON text blob — MCP clients (Claude Code) render the
  image directly, eliminating the save-to-file → decode → read-image detour.
  A short text line with format and approximate byte size accompanies the
  image. `sallyport-daemon exec screenshot` still prints the JSON shape with
  the blob truncated, as before.

## [0.3.3] — 2026-06-11

### Security

- **`navigate` now refuses to replace a non-allowlisted tab.** Reusing an
  existing tab destroys whatever it holds, but `navigate` only checked the
  *target* URL — so an agent that found a banking/email tab or an in-progress
  form via `list_tabs` could discard it behind the allowlist's back by
  navigating it to an allowlisted URL, the exact loss `close_tab` is gated
  against (invariant #12). It now refuses with `domain_not_allowed` when the
  tab being replaced is real content that isn't itself allowlisted. Blank
  tabs (`about:blank` / new-tab) and `chrome://` / `edge://` pages are
  unaffected (the latter still open the target in a fresh tab), and
  `newTab=true` remains the escape hatch. Regression tests added.
- **`fill`'s password gate now reads the `type` attribute from the browser
  DOM, not page JS.** The gate probed `this.type` via an in-page function; a
  hostile *allowlisted* page could shadow `type` with a throwing getter so the
  probe returned `undefined` and the gate passed — text was typed into the
  password field and (because `allowPassword` stayed false) written to the
  audit log in cleartext. `fill` now resolves the node and reads its `type`
  attribute via CDP `DOM.getAttributes`, which page JS cannot shadow with a
  throwing or lying accessor, and fails closed if the node can't be read.
  `SECURITY.md`'s incorrect claim that `fill` was already immune is corrected;
  `key_type` / `send_keys` retain the documented in-page-getter blind spot.
  Regression tests added.

### Fixed

- **The extension now rejects a fractional `ts` on the wire.** `crypto.ts`
  accepted any numeric `ts` while the daemon requires an integer
  (`isinstance(ts, int)` in `protocol.py`), so the two halves disagreed on
  which frames are well-formed. Both signers only ever emit integer seconds
  (`Math.floor` / `int(time.time())`), so this rejects no legitimate frame; it
  closes a latent cross-language conformance gap. Regression test added.
- **Remaining stale-guard races in the extension's connection state machine.**
  Same class as the `open`-handler race fixed in 0.3.2 (state checked before
  an `await`, mutated during it), now closed for every such window in
  `bridge-connection.ts` via a connection-lifecycle epoch counter plus a
  synchronous session-local `paused` flag:
  - `pause()` landing during `start()`'s storage reads no longer loses to the
    stale settings snapshot — the bridge can no longer end up `connected`
    while `settings.paused` is true;
  - `unpair()` landing during `start()` no longer lets the stale secret local
    be re-imported into the signer and reconnect as if still paired;
  - a scheduled backoff retry that resumes after a successful reconnect no
    longer stomps state to `disconnected` and opens a rival socket (which the
    daemon would reject with 1008 while the live one sat orphaned, stranding
    subsequent tool results);
  - an orphaned socket's late `error` event no longer overwrites the
    `lastError` of the attempt that replaced it.

  All internal-only (not reachable by a remote peer); four regression tests
  added.

## [0.3.2] — 2026-06-09

### Fixed

- **Reconnect race in the extension's WS `open` handler.** The orphan guard
  (`if (this.ws !== ws) return`) ran before the `await signer.sign('hello')`,
  but a user-triggered `reconnectNow()` during that await could swap in a
  fresh socket — and the stale handler would then flip state to `connected`
  on the dead socket and clear the *new* socket's reconnect timer. The handler
  now re-checks ownership after signing. Internal-only (not reachable by a
  remote peer); regression test added.

### Security

- **Nonce cache survives reconnects to the same daemon.** `Signer.setSecret`
  is now a no-op when the secret is unchanged, so a reconnect (daemon restart,
  network blip, popup Reconnect) no longer wipes the replay cache. Previously
  every `connect()` cleared it, briefly reopening the ±30 s replay window on
  the extension side. The window is now bounded by service-worker lifetime
  only. Exploitability was already "very low" (loopback capture needs local
  root; the daemon's process-lifetime cache catches the real replays) — see
  `SECURITY.md`. Regression test added.

## [0.3.1] — 2026-06-08

### Fixed

- **`list-tools` no longer creates the secret as a side effect.** The command
  is documented as an offline catalogue print, but `amain()` loaded/created
  `~/.config/sallyport/secret` before dispatching it — so a first-time
  `sallyport-daemon list-tools` silently generated an HMAC secret (chmod 600,
  never printed, no network — but an undocumented credential write). It now
  returns before touching the secret file. Regression test added.

### Packaging

- **sdist no longer ships the test suite.** `tests/` resolves the shared
  cross-language fixture at repo root (`fixtures/canonical-vectors.json`),
  which is outside the package, so the tests could never run from an sdist
  (`pip download` + `pytest` errored with `FileNotFoundError`). The sdist now
  ships `src` + metadata + docs only.

## [0.3.0] — 2026-06-08

### Packaging

- **Daemon published to PyPI as `sallyport`** (`pip install sallyport`; the
  package installs the `sallyport-daemon` command). `pyproject.toml` carries
  full metadata (SPDX `license = "MIT"` + `LICENSE`, readme, authors,
  keywords, classifiers, `[project.urls]`); a daemon-focused `daemon/README.md`
  is the PyPI long-description. Build (hatchling) + `twine check` pass for both
  sdist and wheel.
- **Publish via PyPI Trusted Publishing (OIDC)** — `.github/workflows/publish.yml`
  builds and uploads on a published GitHub Release (or manual dispatch) with
  no API token stored in the repo; the publish job is scoped to `id-token:
  write` and runs in a `pypi` environment. Actions are SHA-pinned.

### Security / CI

- **Repository supply-chain hardening.** GitHub Actions in `ci.yml` are now
  pinned to full commit SHAs (with `# vX.Y.Z` comments Dependabot keeps
  current) instead of mutable tags, `actions/checkout` runs with
  `persist-credentials: false`, the workflow has least-privilege
  `permissions: contents: read`, and a `concurrency` group cancels superseded
  runs.
- **Dependabot** (`.github/dependabot.yml`): weekly update PRs for the daemon
  (pip), extension (npm), and the workflow actions, plus GitHub's automatic
  security-update PRs (vulnerability alerts enabled).
- **CodeQL** (`.github/workflows/codeql.yml`): `security-extended` static
  analysis for Python and JavaScript/TypeScript on push, PR, and weekly.
- **Repo settings**: secret scanning + push protection on, private
  vulnerability reporting enabled, `main` protected against force-push and
  deletion, unused wiki/projects disabled.
- **Dev-dependency advisories cleared** (build/test tooling only — none ship
  in the daemon or extension artifact, and none is reachable in how the
  project uses the tools): `vitest` 2 → 4.1 (UI-server arbitrary-file-read,
  critical), `esbuild` → 0.27 (dev-server request advisory), `vite` → 8 via
  vitest (path traversal). Two new unit tests (nonce-cache eviction in
  `crypto.ts`, malformed-pattern path in `allowlist.ts`) restore the per-file
  coverage gates under vitest 4's stricter v8 remapping — thresholds were
  raised back, not lowered.

## [0.2.0] — 2026-06-08

### Added

- **`sallyport-daemon doctor` subcommand.** Runs the four checks that actually
  block a working bridge — Python ≥ 3.10, secret file present, secret-file
  permissions (0600), and port availability on the loopback host — prints a
  clear OK/FAIL line for each, then prints the pairing block and the next
  steps. Exits 0 when everything passes, 1 otherwise. It speaks no MCP and is
  non-interactive, so it's safe to run in any shell (even alongside a live
  Claude Code session). This is the recommended first stop when onboarding or
  when a connection won't come up — it turns "address already in use" and
  missed-the-stderr-banner into legible, actionable output. Covered by
  `test_main.py::test_doctor_*`.

### Fixed

- **Security hardening (from a thorough security review):** the review
  confirmed the trust boundary is sound — no cross-domain bypass, no
  secret-less escalation — and surfaced a handful of scope-narrowing and
  hygiene gaps, now closed:
  - **Shadow-DOM password gate.** `key_type` / `send_keys` probed
    `document.activeElement`, which retargets to the shadow *host*, so a
    focused `<input type=password>` inside an **open** shadow root slipped the
    gate (`fill` was already safe — it probes the node directly). The probe now
    descends `.shadowRoot.activeElement` through open roots. Closed shadow
    roots and cross-origin iframes remain documented blind spots
    (`SECURITY.md`). (`extension/src/tools/keyboard.ts`)
  - **Allowlist port-blindness.** The matcher compared only host, so an
    allowlisted hostname authorized *any* port, and `validatePattern` accepted
    a port qualifier it then silently ignored — a false sense of scoping. A URL
    pattern with an explicit port (`https://host:8443/*`) now matches only that
    port; a no-port URL pattern matches only the scheme's default port;
    host-only patterns still match any port by design (so `localhost` reaches
    `localhost:3000`), now documented. (`extension/src/allowlist.ts`)
  - **Typed passwords in the audit log.** `fill` / `key_type` / `send_keys`
    with `allowPassword=true` wrote the credential verbatim to
    `chrome.storage.local` (exportable from the popup). The typed value is now
    redacted to a length placeholder before the audit write — including a
    non-string credential (a numeric PIN; the tools `String()`-coerce before
    typing, so the audit must too) and a value from a *rejected* attempt into
    a password field. Values typed into non-password fields are still recorded
    (the point of a visible trail). (`extension/src/storage.ts`, `tools.ts`)
  - **Secret-directory hygiene.** `~/.config/sallyport` is now created `0700`
    under a tight umask, a symlink at the secret path is refused on load and
    create, and `check_perms` warns on a group/world-*writable* secret dir
    (a traversable `0755` dir holding a `0600` file is safe and does not nag).
    Matters only on a multi-user host (outside the stated model) but cheap.
    (`daemon/src/sallyport_daemon/secret.py`)
  - **Robustness against an authenticated-but-buggy extension.** A truthy
    non-dict `tool_result` body now surfaces as a clean
    `ToolError(bad_args)` instead of an `AttributeError` reaching the MCP
    caller (`bridge.py`); an `upload` path with a null byte *or a lone
    surrogate* is rejected as `unsafe_path` instead of escaping the
    validator's catch (`ValueError` / `UnicodeEncodeError`) and crashing the
    dispatch loop (`local_tools.py`).
  - **Dependency bounds.** The daemon's `mcp` / `websockets` deps are now
    upper-bounded at the next major (`mcp>=1.0.0,<2.0.0`,
    `websockets>=13.0,<17.0`) so a fresh install can't pull a future
    API-breaking release; a hash-pinned lockfile remains a follow-up.
    (`daemon/pyproject.toml`)
- **Security:** the single-client WS slot is now claimed only **after** the
  peer authenticates: the first frame must be a valid signed `hello`, must
  arrive within 10 s (`hello_timeout`), and browser-page `Origin` headers
  are refused at connect time. Previously `_handle_client` set
  `self._client = ws` on raw TCP/WS connect, before any HMAC check — any
  local process (or a malicious web page opening a cross-origin WebSocket
  to `127.0.0.1`) could silently occupy the slot without knowing the
  secret, denying service to the real extension and probing whether one
  was attached. This contradicted threat-model item 1 in `SECURITY.md`;
  both the doc and the code now state the stronger property. New e2e
  tests: silent-squatter doesn't block the real extension, hello-timeout
  close, browser-origin rejection, `chrome-extension://` origin accepted,
  wrong-secret hello rejected, signed-but-not-hello first frame rejected,
  garbage first frame doesn't claim the slot.
- **Security/wire format:** fixed canonical-JSON divergence between the two
  implementations that made certain MACs unverifiable cross-language —
  a frame whose payload contained an affected value was signed by one side
  and rejected (or never reproduced) by the other, surfacing as a baffling
  60 s timeout. The root cause is that each receiver recomputes the MAC
  from the *parsed wire text*, so the canonical form of every value must
  be byte-identical to what the peer's parser-then-canonicaliser
  reproduces. Divergence classes, all eliminated:
  1. *Float formatting.* Python `repr` and JS `Number.toString` disagree
     on exponent thresholds and padding (`1e-07` vs `1e-7`, `1e-06` vs
     `0.000001`). For non-integral (and ≥1e21) doubles CPython `repr` is
     now the cross-language reference; `protocol.ts` reimplements it
     (`pythonFloatRepr`).
  2. *Integral doubles and the wire.* JS transmits via `JSON.stringify`,
     which renders every integral double below 1e21 as a bare integer
     (`1e16` → `10000000000000000`, `2^60` → `1152921504606847000` —
     shortest digits, not exact digits). The canonical form for integral
     doubles with |x| < 1e21 is therefore exactly those wire bytes on
     both sides: the daemon got a hand-rolled canonical encoder
     (`protocol.py:_format_number`/`_encode_canonical`) that derives the
     same shortest-digit rendering from `repr`, folds `2.0` → `2` and
     `-0.0` → `0`, and accepts ints iff double-exact or already in
     shortest-rendering form — precision-losing ints (e.g. `2^53+1`,
     `10^16+1`) are rejected at signing time rather than silently
     corrupted in the peer's `JSON.parse`. (The first iteration of this
     fix canonicalised `1e16` as `'1e+16'` while the wire carried
     `10000000000000000` — caught in review before release;
     the e2e regression `test_large_integral_numbers_roundtrip` now pins
     the wire path.)
  3. *Key ordering.* `Object.keys().sort()` compares UTF-16 code units,
     putting astral-plane keys before U+E000..U+FFFF; Python `sort_keys`
     compares code points. The extension now sorts by code point
     (`compareCodePoints`).
  4. *Unrepresentable values.* NaN/±Infinity and lone surrogates raise
     `ProtocolError` (Python) / `Error` (TS) symmetrically; the TS side
     additionally matches `JSON.stringify` semantics for `undefined`
     values and `toJSON` (e.g. `Date`), because that is what actually
     goes on the wire. Fail-fast beats fail-weird: the daemon maps
     unserialisable tool *arguments* to `ToolError(code="bad_args")`, and
     the extension answers a tool *result* it cannot sign with
     `ok:false, code:"unserialisable_result"` instead of stranding the
     daemon until its request timeout.
  Verified by a 245k-case bidirectional fuzz (random IEEE-754 bit
  patterns, threshold-stratified magnitudes incl. dense [2^53, 1e21)
  coverage, random astral/BMP key sets) exercising both wire directions:
  zero mismatches. The fixture grows 25 → 49 vectors, pinning every
  divergence-prone case; all 25 pre-existing vectors are byte-identical,
  so the protocol version stays 1 — every frame that verified before
  still verifies.
- **Reliability:** malformed frames can no longer tear down the WS
  connection with a logged traceback; the read loop now skips them as
  documented and in-flight calls survive. Closed paths, each with an e2e
  regression test that asserts the next tool call still round-trips:
  non-JSON text (`json.JSONDecodeError` is a `ValueError`, was only
  half-caught), valid JSON that is not an object, deeply-nested JSON
  (`json.loads` raises `RecursionError` — NOT a `ValueError` — on a ~4 KB
  frame of nested arrays, found in review), a frame with
  valid envelope fields but no `body` key (raised `KeyError` inside
  `Signer.verify`), and a valid-MAC `tool_result` whose `id` is a
  dict/list (unhashable — `_pending.pop(env.id, None)` raises `TypeError`
  on a non-empty pending dict, killing the in-flight call; also found in
  review). `Signer.verify` now requires `body` to be present
  and `id`, when present, to be a string — on both sides (`crypto.ts`
  mirrors the guard). The same guards cover the hello gate and the
  signing path (`bad_args` instead of a hang for absurdly-nested
  arguments).
- **Reliability:** `save_to_file` now wraps `mkdir`/`write_bytes` in a guard
  that turns filesystem failures (read-only volume, permission denied, disk
  full) into a `ToolError` with the new `filesystem_error` code, instead of
  letting an uncaught `OSError` crash the MCP dispatch loop and hang the
  caller. The base64 decode was already guarded this way; this closes the
  matching gap on the write path. New tests mock `Path.mkdir`/`write_bytes`
  raising `OSError`.
- **Reliability:** `exec` mode now cancels its WS server task explicitly
  before awaiting it during shutdown, and suppresses only the expected
  `CancelledError`/`TimeoutError` rather than every exception. Honours the
  documented "never leave the WS task dangling" contract and stops a genuine
  WS-task error from vanishing silently.
- **Reliability:** the extension's WS message handler now `await`s
  `handleEnvelope` inside a try/catch, so a failure in tool dispatch or reply
  signing surfaces as `lastError` instead of an unhandled promise rejection
  (which pollutes the console and, in strict runtimes, can tear down the
  service worker). Mirrors the existing `open`-handler pattern. New
  regression test in `bridge-connection.test.ts`.
- **Correctness:** `fetch_in_page` now validates that every header value is a
  string up front and fails with `bad_args`, instead of JSON-baking a
  non-string into the fetch expression and surfacing a misleading
  `fetch_failed` from the browser's stricter `Headers` validation. Matches
  the tool's declared MCP schema (`headers` values are strings).
- **Build:** restored `ruff` to green — the `save_to_file` sandbox-escape
  branch raised a `ToolError` inside an `except` without `from`, tripping
  `B904` and failing the daemon CI lint step. Now chains with `from exc`,
  matching `validate_upload_paths`.
- **Security:** `save_to_file` sandbox check now uses `Path.relative_to()`
  instead of `str.startswith()`, matching the pattern `validate_upload_paths`
  already uses. The string-prefix approach was vulnerable to edge cases on
  case-insensitive filesystems and prefix-overlap paths (e.g.
  `/sandbox-evil/` matching `/sandbox/`).
- **Security:** `refuse_non_loopback` now uses `ipaddress.ip_address().is_loopback`
  instead of a fixed string set. Correctly handles the full `127.0.0.0/8`
  range, IPv4-mapped IPv6 (`::ffff:127.0.0.1`), and rejects non-IP hostnames
  other than `localhost`.
- **Security:** `_sanitise_filename` now explicitly rejects null bytes (`\x00`)
  instead of relying on Python's `ValueError` at the OS layer.

### Changed

- **CI:** the daemon job now regenerates `fixtures/canonical-vectors.json`
  and fails on any diff (`git diff --exit-code`). A protocol change that
  forgets to re-pin the vectors — or drifts from `protocol.ts` — is now
  caught in CI instead of on the wire. Guards security invariant #1.
- **CI:** added a non-blocking `audit` job that runs `npm audit` (extension
  build/test deps) and `pip-audit` (daemon deps) for visibility. Deliberately
  `continue-on-error` — every current advisory is in dev-only tooling or in
  transitive deps of `mcp` we don't pin directly, so gating merges on them
  would only train people to ignore red. Review the run log when it flags
  something new.
- **Docs:** README setup now states the Python ≥ 3.10 requirement up front,
  adds a `which sallyport-daemon` PATH check, documents `sallyport-daemon doctor`,
  explains that the first-run secret banner is invisible when Claude Code
  spawns the daemon (use `doctor`/`--show-secret`), and adds a troubleshooting
  row for a popup stuck on "Connecting…". The `vitest.config.ts` coverage
  comment now describes what the e2e harness actually exercises rather than
  overclaiming.
- A negative test pins that allowlist patterns reject embedded/mid-label
  wildcards (only a leading `*.` is permitted).
- Popup is now live: it subscribes to `chrome.storage.onChanged` and
  re-renders the panel you're looking at when the underlying audit log,
  allowlist, or settings change. Tool calls flow into the Audit tab as
  they happen; the context-menu "add this site" updates the Allowlist
  and the current-tab widget without a popup re-open. Manual **Refresh**
  becomes a fallback rather than a habit.
- Audit log gains a substring filter (`tool name / url / error text`) plus
  a header summary (`12 events, 2 errors`). The list re-renders live as
  you type. Pure `matchesAuditFilter` in `src/format.ts` with 5 unit
  tests.
- Toolbar icon now surfaces the connection state at-a-glance: red `!` when
  disconnected or unpaired, yellow `…` while connecting, grey `II` when
  paused, and no badge when healthy (silent by design so the user is
  trained to look only when something needs attention). Pure
  `badgeFromStatus` helper in `extension/src/badge.ts`, 5 unit tests.
- Popup Status tab now shows a "current tab" widget — picks up the active
  tab's host, indicates whether it matches the allowlist, and offers a
  one-click "Add `example.com` to allowlist" button when it doesn't. The
  most common pairing-aftermath step ("now let me actually allow the site
  I'm on") drops from 3 clicks + typing to 1 click.
- Settings tab removed entirely; its three pieces (daemon URL, available
  tools list, unpair) folded into the Status tab as a collapsible
  Advanced disclosure plus the already-present Actions row. Three tabs
  instead of four — less for a first-time user to scan.
- Audit log uses relative timestamps ("just now / 30s / 5m / 2h / 3d ago",
  with the exact wall-clock time as a tooltip on hover) so glancing at
  recency doesn't require parsing HH:MM:SS.mmm. Pure
  `formatRelativeTime` in `src/format.ts`, 10 unit tests across that and
  `extractHostname`.
- Inline "✓ added example.com" / "✓ saved — reconnecting" toasts under
  Status and Allowlist actions; auto-fade. Replaces silent state changes.
- Enter key now submits the allowlist quick-add inputs;
  Cmd/Ctrl+Enter submits the pairing textarea (plain Enter stays as
  newline because pasted banners are multi-line).
- Popup UX overhaul aimed at "paste once, it works":
  - Pairing no longer requires manually cutting the base64 line out of
    the daemon's onboarding banner — paste the whole `===`-framed block
    and the popup auto-detects the secret, shows "✓ secret detected
    (32 bytes)" inline, and enables Pair only when a valid candidate is
    found (`extension/src/pairing.ts` + 10 unit tests).
  - Pre-pairing view is now a single onboarding card with 3 numbered
    steps and a `<details>` "Advanced" disclosure for the daemon URL;
    tabs only appear after pairing so first-time users aren't faced
    with four sections of empty state.
  - Connected view replaces the small badge-only status with a
    prominent card (pulsing dot + state title + daemon URL), two
    at-a-glance stats (allowed sites, calls in the last hour) and a
    quick-add field for the allowlist right on the Status tab.
  - "paused" and connection errors no longer linger after a successful
    reconnect — the status card recomputes from the live state on every
    push from the service worker.

### Added

- Right-click → **Add this site to Sallyport allowlist** context menu on any
  http(s) page or link. Adds the host directly from the page without
  opening the popup. Requires `contextMenus` permission (new in
  `manifest.json`). No-op for hosts already in the list — won't duplicate.
- `fetch_in_page` tool — runs `fetch()` from the page's JS context (with
  cookies/auth), returns `{status, contentType, headers, mode, data}`
  where mode auto-selects text vs base64. Allowlist-gated by the page's
  host; does NOT require the per-domain evaluate flag (function body is
  fixed, only URL/method/headers/body are JSON-interpolated). The typical
  use case is "grab an image/binary URL the agent saw on the page".
- `save_to_file` daemon-local tool — writes a base64 blob to
  `~/Downloads/sallyport/<filename>` (override via `SALLYPORT_DOWNLOAD_DIR`),
  with a sandbox: rejects path separators, leading dots, `..` segments,
  >255-char names. Routed locally in `Sallyport.call_tool` — no extension
  round-trip. Pairs naturally with `fetch_in_page`.
- Cross-language canonical-JSON / HMAC fixture (`fixtures/canonical-vectors.json`,
  25 vectors) generated by `fixtures/generate.py`. Both `daemon/tests/test_vectors.py`
  and `extension/test/vectors.test.ts` read this single file and assert
  byte-identical output, locking in wire-format compatibility forever.
  Covers: primitives, empty containers, key ordering with reverse / numeric /
  unicode / emoji keys, three-deep nesting, unicode + emoji / quote /
  backslash / newline strings, edge numbers, full envelopes (`tool_call`,
  `tool_result` ok+error). Any drift on either side becomes a red test.
- `BridgeConnection` extracted into `src/bridge-connection.ts` with full
  dependency injection (storage, alarms, status callback, tool runner,
  WebSocket factory, backoff overrides). `background.ts` is now a thin
  wiring shim.
- 19 unit tests for the connection state machine (basics, lifecycle,
  backoff growth & reset, pair/unpair/pause/resume, regression coverage
  for both Reconnect bugs).
- 18 unit tests for the per-tab ref map (`refs.ts`) — isolation between
  tabs, counter independence, clear/reset semantics.
- 13 unit tests for `storage.ts` — secret/allowlist/settings round-trip,
  audit log rotation at `AUDIT_LIMIT` boundary (load-bearing for popup
  performance), defensive parsing of corrupted storage.
- 11 unit tests for `gates.ts` — allow / domain-reject / evaluate-reject
  / no-url paths with a real `BridgeError` instance check.
- Coverage gates wired into CI:
  - Daemon: `pytest-cov` with `--cov-fail-under=80` (branch coverage on).
    Current floor 80 %, baseline 81 %.
  - Extension: `@vitest/coverage-v8` with per-file thresholds on the units
    that have unit tests (`protocol.ts` 95 %, `crypto.ts` 90 %,
    `allowlist.ts` 95 %). The chrome-API-bound modules are covered via the
    daemon's e2e pytest harness on the wire and are deliberately not
    included in the gate.
- `sallyport-daemon serve` subcommand — long-running WS-only mode that doesn't
  require an MCP client on stdin. Drops the `bash -c 'cmd < <(sleep …)'`
  trick previously needed for local testing.
- `sallyport-daemon exec <tool> [k=v…]` — fire a single tool from the shell
  and print the JSON result, with structured exit codes:
  `0` ok, `2` bad args, `3` extension didn't connect, `5` tool error.
- `sallyport-daemon list-tools` — print the tool catalogue (no daemon start).
- `reload` tool — `chrome.tabs.reload(tabId, {bypassCache})`. Required to
  let the agent refresh its view of a page that updated server-side.
  Allowlist-gated; invalidates the tab's accessibility refs.

### Added

- `SECURITY.md` — explicit threat model, per-concern gates table, known
  limitations with exploitability notes (SW nonce-cache on restart,
  cross-origin password iframes, `host_permissions: <all_urls>`, secret
  plaintext-on-disk, tool-name shadowing), and a "Adding a new tool
  safely" checklist. The README links to it.
- `mouse_click` tool — dispatches real `Input.dispatchMouseEvent` press +
  release at the element's geometric center, instead of the synthetic
  `.click()` that the existing `click` tool uses. Required by sites whose
  pointer-event listeners ignore synthetic clicks (canvas-heavy UIs,
  react-dnd / drag-and-drop libraries, some game UIs). Args:
  `{selector, button?, clickCount?, tabId?}` where `button` is
  `left|middle|right` (default `left`) and `clickCount` is 1..3 for
  double/triple click. Allowlist-gated. Refuses zero-size targets with
  `not_visible` so silent CDP no-ops on offscreen elements become a clear
  error.
- `upload` tool — attach local files to `<input type=file>` via
  `DOM.setFileInputFiles`. Args: `{selector, paths[]}` plus optional `tabId`.
  Allowlist-gated like the rest of the DOM tools. Defensive checks: paths
  must be absolute (POSIX `/...` or Windows `X:\...`), no `..` segments,
  target must really be `<input type=file>` (otherwise `wrong_element`
  instead of CDP's silent no-op). The pure validator lives in
  `extension/src/tools/upload-path.ts` so it can be unit-tested without a
  chrome-tab harness — 7 vitest cases cover absolute / Windows-drive /
  relative / empty / non-string / `..`-traversal / segment-vs-substring
  cases. Pairs naturally with `save_to_file` (stage the bytes into
  `~/Downloads/sallyport/`, then upload from there).
- `mcp_server._dispatch_call` extracted from the inline `@server.call_tool()`
  handler so the success / `ExtensionNotConnected` / `ToolError` (with and
  without code) branches are directly unit-testable. Coverage on
  `mcp_server.py` rises 58 % → 89 %, project total 83 % → 85 %.

### Fixed

- **Security:** `upload` paths now enforced under a daemon-side sandbox
  (`~/Downloads/sallyport/` by default, the same dir `save_to_file` writes
  to; widen via `SALLYPORT_DOWNLOAD_DIR`). Previously the extension-side
  `validatePath` only checked syntax (absolute, no `..`) — an agent on
  an allowlisted domain could `upload({paths: ['/etc/passwd']})` or
  point at `~/.ssh/id_rsa`, `~/.aws/credentials`, even
  `~/.config/sallyport/secret` itself, and Chrome would attach them to a
  POST. The authoritative check is now `validate_upload_paths` in
  `local_tools.py`, wired into `Sallyport.call_tool` via a new
  `PRE_CALL_VALIDATORS` registry so it runs both for MCP calls and
  `sallyport-daemon exec upload`. `Path.resolve()` follows symlinks so
  links inside the sandbox pointing outside are still rejected. 10
  new pytest cases cover sandbox-ok / outside-sandbox / symlink-escape
  / relative / `..` / empty-list / non-list / non-string-entry / the
  Sallyport.call_tool integration path.
- **Robustness:** audit-log entries now truncate every string in `args` and
  the `error` field to `MAX_AUDIT_STRING = 1024` chars before persisting,
  with a `…<truncated, N chars total>` marker. Previously a single
  `save_to_file({data: <5 MiB base64>})` audit entry could blow the
  `chrome.storage.local` 10 MiB quota in a handful of calls — writes then
  fail silently and the audit log freezes from the user's view. Pure
  helpers `truncateAuditString` / `truncateAuditValue` are exported and
  covered by 6 new vitest cases (passthrough, exact-cap edge, nested
  object/array trim, primitive bypass, `appendAudit` end-to-end).
- **Security:** `key_type` and `send_keys` now share `fill`'s password-field
  gate. Previously `fill` blocked typing into `<input type=password>` but
  the keystroke-level tools dispatched to whatever was focused — an agent
  could `click('#password-input')` (no password check) then `key_type` /
  `send_keys` straight into the field. Now a fixed-expression
  `Runtime.evaluate` probes `document.activeElement.type` first and
  refuses with `password_field` unless `allowPassword=true`. Top-frame
  only — cross-origin password iframes are still a known blind spot.
  MCP schemas + README updated to reflect the new `allowPassword` arg.
- **Security:** `close_tab` now allowlist-gated. Previously the only
  unguarded DOM tool — an agent could enumerate every tab via `list_tabs`
  (which is intentionally allowlist-free) and `close_tab(tabId)` any
  non-allowlisted tab, losing user work (banking, in-progress forms,
  unsent emails). Now `close_tab` fetches the tab's URL first and calls
  `ensureAllowed` before `chrome.tabs.remove`, matching the gate on
  `click`/`fill`/`navigate`/etc. MCP description updated.
- MCP tool descriptions now match extension behaviour. `navigate` and
  `close_tab` previously claimed a "last-used tab" fallback that has never
  existed — `resolveTab` in `extension/src/tools/tabs.ts` is stateless
  (explicit `tabId`, otherwise the active tab in the current window).
  `close_tab` additionally throws `bad_args` without a `tabId`, but its
  schema marked the field as optional; now `required: ["tabId"]`. New
  pinning tests in `test_mcp_server.py` flag any future drift.
- `daemon/tests/test_cli_smoke.py` now passes `ruff check`. The new file
  tripped two real categories (E501 line length, S603/S104 security lints
  on subprocess + 0.0.0.0). Fix: wrap the long signatures, allow `S603`
  project-wide in `tests/**` (subprocess in tests with a controlled arg
  list is a safe, recurring pattern), and `# noqa: S104` on the single
  line that intentionally tests the non-loopback refusal.
- `reconnectNow()` was implicitly called by the backoff `setTimeout` and
  always reset `reconnectAttempt = 0`, so backoff never grew between
  failures. Split into public `reconnectNow()` (user-initiated; resets
  counter + tears down in-flight WS) and private `_scheduledRetry()`
  (preserves counter; bails when already connecting). Pinned by the
  ``resets reconnectAttempt to 0 on a successful connect`` regression.



## [0.1.0] — 2026-05-18

Initial release. A working secure bridge between Claude Code (or any MCP
client) and Chrome, end-to-end tested on a real page.

### Added

#### Extension (`extension/`, MV3 + TypeScript + esbuild)

- WebSocket client to a local daemon with HMAC-SHA256 on every frame, nonce
  cache (4096 entries) and ±30 s clock-skew check.
- Domain allowlist (`example.com` / `*.example.com` / `https://host/path/*`),
  enforced at the extension before any tool runs; bare `*` rejected.
- Per-domain `evaluate` opt-in flag (otherwise arbitrary JS is refused).
- Per-tab accessibility refs (`@e1`, `@e2`, …) so `snapshot` of tab A cannot
  invalidate refs for tab B.
- 12 tools: `list_tabs`, `navigate`, `reload`, `close_tab`, `snapshot`,
  `read_text`, `click`, `fill` (password fields refused unless
  `allowPassword=true`), `key_type`, `send_keys`, `screenshot`, `evaluate`.
- Audit log of every tool call (last 500), JSON-exportable from the popup.
- Pause / Resume / Reconnect / Unpair from the popup; exponential backoff
  (1 s → 30 s + jitter), reset on successful connection.
- 11 tool modules under `src/tools/` (one concern per file) + thin registry.

#### Daemon (`daemon/`, Python + `mcp` SDK + `websockets`)

- MCP server over stdio for Claude Code integration.
- WS server on `127.0.0.1:10086` (refuses any non-loopback host).
- 16 MiB frame cap; ping/pong keepalive every 20 s.
- Shared-secret file at `~/.config/sallyport/secret`, generated on first run
  (chmod 600); warns if perms relax. Cross-language MAC vector pinned in both
  test suites.
- Daemon-side `_call_lock` serialises MCP-side concurrent tool calls so the
  extension never sees two in flight.
- Graceful shutdown: SIGINT/SIGTERM and MCP stdin EOF all close the WS with
  1001 and drain pending requests within 2 s.
- Subcommands:
  - `exec <tool> [k=v ...]` — fire a single tool from the shell, prints JSON.
  - `serve` — WS-only mode, no MCP. Useful for pairing / smoke tests.
  - `list-tools` — print the catalogue.
  - `--show-secret` — re-print the pairing secret.

#### Tooling

- Daemon: `ruff`, `mypy` (strict), `pytest`, `pytest-asyncio` — wired in
  `pyproject.toml`.
- Extension: `eslint` (flat config) + `typescript-eslint`, `prettier`,
  `vitest`, `tsc --noEmit` — wired in `package.json`.
- `pre-commit` config for trailing whitespace / JSON / YAML / large-files +
  ruff/ruff-format/mypy on `daemon/` + prettier/eslint/typecheck on
  `extension/` via local hooks.
- GitHub Actions `ci.yml`: Python 3.10/3.11/3.12 × daemon + Node 20/22 ×
  extension; uploads `extension/dist` artefact on `main`.

### Tests

- **129 total, all green**:
  - Daemon: 72 (`test_protocol.py`, `test_secret.py`, `test_e2e.py`,
    `test_main.py`).
  - Extension: 57 (`protocol.test.ts`, `crypto.test.ts`,
    `allowlist.test.ts`).
- Cross-language HMAC vector pinned byte-for-byte in both test suites.
- End-to-end pytest harness: real WS handshake, full
  `tool_call → tool_result` round trip, unauthenticated-frame drop,
  single-client invariant, mid-request disconnect, request timeout, oversize
  frame rejection, graceful shutdown 1001, serialised concurrent calls.

### Fixed (during early shakedown)

- Nonce-cache eviction in `protocol.py` was popping the wrong end of the
  deque, so really-old nonces could be replayed. Caught by an eviction-
  scoped pytest.
- `BridgeConnection.reconnectNow()` bailed when state was `connecting`,
  making the popup's Reconnect button a no-op after a failed attempt.
  Now it tears down the in-flight WS, zeroes the backoff counter, and
  retries immediately.
- `'open'` handler used to fire on orphaned sockets after `reconnectNow`,
  producing `WebSocket already in CLOSING or CLOSED state`. Now ignores
  if `this.ws !== ws` and guards `ws.send` with `readyState === OPEN`.
- Popup showed stale `lastError = "connection error"` after a successful
  reconnect; now error line is only displayed when state is not connected.
- Popup's actions panel (`Pause/Reconnect/Unpair`) was hidden whenever the
  state wasn't exactly `connected`; now visible in any "paired & not paused"
  state, with dynamic helper text.

[Unreleased]: https://github.com/ginkida/sallyport/compare/v0.12.0...HEAD
[0.12.0]: https://github.com/ginkida/sallyport/compare/v0.11.2...v0.12.0
[0.11.2]: https://github.com/ginkida/sallyport/compare/v0.11.1...v0.11.2
[0.11.1]: https://github.com/ginkida/sallyport/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/ginkida/sallyport/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/ginkida/sallyport/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/ginkida/sallyport/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/ginkida/sallyport/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/ginkida/sallyport/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/ginkida/sallyport/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/ginkida/sallyport/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/ginkida/sallyport/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/ginkida/sallyport/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ginkida/sallyport/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/ginkida/sallyport/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/ginkida/sallyport/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/ginkida/sallyport/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ginkida/sallyport/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ginkida/sallyport/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ginkida/sallyport/releases/tag/v0.1.0
