# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/ginkida/sallyport/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/ginkida/sallyport/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/ginkida/sallyport/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/ginkida/sallyport/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ginkida/sallyport/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ginkida/sallyport/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ginkida/sallyport/releases/tag/v0.1.0
