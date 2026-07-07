# Sallyport

[![CI](https://github.com/ginkida/sallyport/actions/workflows/ci.yml/badge.svg)](https://github.com/ginkida/sallyport/actions/workflows/ci.yml)
[![CodeQL](https://github.com/ginkida/sallyport/actions/workflows/codeql.yml/badge.svg)](https://github.com/ginkida/sallyport/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/ginkida/sallyport)](https://github.com/ginkida/sallyport/releases/latest)

A secure browser-automation bridge between Claude Code (or any MCP client) and
your Chrome. An alternative to Kimi WebBridge with explicit security
boundaries instead of implicit ones.

```
Claude Code ── MCP/stdio ──▶ daemon ── WS+HMAC ──▶ extension ── CDP ──▶ Chrome
```

| Status | Number |
|---|---|
| Daemon tests (pytest) | 458 |
| Extension tests (vitest) | 647 |
| Lint / typecheck (ruff, mypy, eslint, prettier, tsc) | all green |

## What's in the box

| Path | What it is |
|---|---|
| `extension/` | MV3 Chrome extension (TypeScript, esbuild, vitest). Loads as an unpacked extension. |
| `daemon/` | Python MCP server. Speaks MCP on stdio to Claude Code, hosts a WS server on `127.0.0.1:10086` for the extension. |
| `fixtures/` | Cross-language canonical-JSON / HMAC vectors shared by both test suites. |
| `.pre-commit-config.yaml` | Fast lint/format checks before commit. |
| `.github/workflows/ci.yml` | Same checks plus full tests on push/PR. |

## Security model

A deeper threat model + known limitations lives in [`SECURITY.md`](SECURITY.md).
The short version: the original Kimi extension trusts any process that can
reach `127.0.0.1:10086`, which on a shared/compromised machine means
everything. Sallyport changes the default in five places:

1. **HMAC-SHA256 on every frame.** A 32-byte random secret lives in
   `~/.config/sallyport/secret` (chmod 600) and is generated on first run. Both
   sides sign every WS frame and verify timestamp drift (≤ 30 s) and nonce
   freshness (rolling cache of 4096 nonces — replay-protected). A
   cross-language test pin in pytest + vitest guarantees the canonical-JSON
   and MAC bytes stay byte-for-byte compatible.
2. **Domain allowlist enforced in the extension.** Tools refuse to run on any
   URL whose host isn't in `chrome.storage.local.sallyport_allowlist`. Patterns
   are `example.com`, `*.example.com`, or `https://x.com/path/*`. Bare `*` is
   rejected by the validator.
3. **`evaluate` is opt-in per domain.** Even on an allow-listed domain,
   arbitrary JS is refused unless that entry has `allowEvaluate: true`. Other
   tools (`click`, `fill`, `read_text`, …) use structured CDP calls only.
4. **Defense-in-depth on inputs.** `fill` refuses `<input type=password>`
   unless `allowPassword=true`. The daemon refuses to bind to anything that
   isn't a loopback address. WS frames over 16 MiB are dropped (1009).
5. **Operational visibility.** Every tool call (and its outcome — `ok` or
   `error`) is appended to `chrome.storage.local.sallyport_audit` (last 500
   entries), browsable and JSON-exportable from the popup. One-click **Pause**
   in the popup stops the WS connection and rejects all tool calls.

Other deliberate choices:

- No content-script injection, no `<all_urls>` content scripts. Permissions
  are only what the debugger API (and a popup-pin context-menu entry) need
  (`tabs`, `activeTab`, `debugger`, `storage`, `alarms`, `contextMenus`).
- Per-tab accessibility refs (`@e1`, `@e2`). Snapshotting tab A cannot
  invalidate refs for tab B, and a ref scoped to A cannot resolve to a node
  in B.
- MCP-side tool calls are serialised by a daemon-side lock so Claude can't
  accidentally race state on the extension.
- The daemon shuts down cleanly on stdin EOF (Claude Code closing) or
  SIGINT/SIGTERM: pending calls fail with `ExtensionNotConnected`, the
  client gets a 1001 close, no orphan tasks.

What the extension still trusts: anyone with read access to
`~/.config/sallyport/secret`. The browser debugger is, ultimately, the browser
debugger — this bridge limits *which* domains it operates on and *who* can
drive it.

## Setup

### 1. Build the extension

The extension is **not** on PyPI — `pip install sallyport` (step 2) gives you
only the daemon. The extension lives in this repo's `extension/` directory, so
you need a checkout to build it:

```sh
git clone https://github.com/ginkida/sallyport
cd sallyport/extension
npm install
npm run build
```

The output lands in `extension/dist/`. Load it as an unpacked extension:

1. `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → pick `extension/dist`

Pin the toolbar icon.

### 2. Install the daemon

Sallyport needs **Python ≥ 3.10** (it uses match statements and `X | Y` type
syntax). Check with `python --version` first.

```sh
pip install --user sallyport
```

Or from source (for development): `cd daemon && pip install --user -e .`

This installs the `sallyport-daemon` command on your `PATH`. Verify it landed there:

```sh
which sallyport-daemon   # should print a path; if not, add your Python
                      # user-scripts dir (e.g. ~/.local/bin) to PATH
```

The first time something runs it, the daemon will:

- Generate a 32-byte secret in `~/.config/sallyport/secret` (chmod 600).
- Print the base64 secret to stderr — paste it into the extension popup.
- Start listening on `127.0.0.1:10086` and speak MCP on stdio.

Then run the built-in setup check, which validates the install and prints the
exact block to paste into the popup:

```sh
sallyport-daemon doctor
```

It checks your Python version, the secret file and its permissions, and that
the port is free — then prints the pairing secret and the remaining steps.
Run it any time a connection won't come up. To just re-print the secret:

```sh
sallyport-daemon --show-secret
```

### 3. Register with Claude Code

Add an MCP server entry — either edit `~/.claude/mcp.json` directly, or:

```sh
# Use the ABSOLUTE path. A GUI-launched Claude Code often doesn't inherit your
# shell PATH, so a bare "sallyport-daemon" command silently fails to spawn.
claude mcp add sallyport "$(which sallyport-daemon)"
```

`sallyport-daemon doctor` prints this exact line with the path already resolved
(and falls back to `python -m sallyport_daemon` if the console script isn't on
PATH) — copy it from there if you're unsure. The result:

```json
{
  "mcpServers": {
    "sallyport": {
      "command": "/Users/you/.local/bin/sallyport-daemon",
      "args": []
    }
  }
}
```

Restart Claude Code. The tools appear as `mcp__sallyport__navigate`,
`mcp__sallyport__click`, etc.

### 4. Pair the extension

1. Open the popup. It will show a one-card **Pair** onboarding view.
2. Get the secret. Run `sallyport-daemon doctor` (or `--show-secret`) in a
   terminal and copy the printed block. **Note:** when Claude Code spawns the
   daemon for you (step 3), the first-run banner goes to the daemon's stderr,
   which Claude Code does not display — so `doctor`/`--show-secret` is the
   reliable way to see it.
3. Paste into the popup textarea — you can paste the whole banner; the
   popup auto-extracts the base64 secret and shows
   "✓ secret detected (32 bytes)".
4. Click **Pair**. Status flips to **connected** with a pulsing green
   indicator and an at-a-glance summary of allowed sites / recent calls.

### 5. Add the first domain to the allowlist

The allowlist starts empty — every tool rejects every URL by default. In the
popup's **Allowlist** tab, add an entry like `example.com` or
`*.github.com`. Tick **allow evaluate()** only if you actually need
arbitrary JS on that host.

## Running a shared broker (multiple sessions)

By default each Claude Code session spawns its own daemon, and only one can own
the browser at a time (they'd fight over `127.0.0.1:10086`). **Broker mode** lets
several sessions — and you, working in the same browser — share one extension:

```sh
# Start one long-lived broker (owns the extension; stays up until Ctrl-C).
sallyport-daemon broker
```

Now register and use Sallyport exactly as above (absolute-path
`claude mcp add`, step 3) from **as many project folders as you like**. Each plain
`sallyport-daemon` session **auto-detects** the running broker and attaches to it
as a thin relay over a `0600` Unix-domain socket (`broker-10086.sock`, next to
the secret); with no broker running, a session falls back to standalone, exactly
as before. Pair the extension once, against the broker.

You can leave the broker running in the background (`sallyport-daemon broker &`,
`nohup`, or your own service manager); it's meant to be long-lived. `doctor`
recognises it as an intentional broker rather than a stale daemon: its port check
reports the busy port as **OK** (a broker holding it is the intended setup, not a
conflict), and `sallyport-daemon doctor --kill-stale` reports it and leaves it
running — stop it explicitly with `kill <pid>` (or Ctrl-C) when you're done.

What you get:

- **Many sessions at once.** N agents drive the one browser concurrently; calls
  are serialised so they never corrupt each other's state.
- **Each agent stays in its own tabs.** An agent can only see and act on tabs it
  created (`navigate` with no tab opens a fresh one); it cannot touch — or even
  list — your tabs or another agent's. `list_tabs` shows a session only its own
  tabs.
- **It won't steal your focus.** Agent tabs open in a separate, un-focused window
  and never foreground themselves, so you can keep working while agents do.
- **You're logged in.** It's your real browser profile, so agents operate on the
  sites you're already signed into — scoped, as always, to the allowlist.

Broker mode is a *software partition* of one shared profile, not an OS-level
sandbox: the security floor is still "any process running as you" (it can read
the secret and drive the browser within the allowlist). See
[`SECURITY.md`](SECURITY.md) for the full model, including the new tab-ownership
and MCP-client-auth invariants.

## Tools

| Name | Notes |
|---|---|
| `list_tabs` | No allowlist check — listing is free. |
| `navigate` | Checks the *destination* URL against allowlist. `waitFor={selector?,text?,absent?,timeoutMs?}` polls after the load until the page is actually usable (SPAs render long after "loaded"). |
| `reload` | Hard reload via `bypassCache=true`. Allowlist-gated; refs invalidate. |
| `close_tab` | `tabId` required — no implicit fallback (closing the wrong tab loses work). |
| `snapshot` | Accessibility tree with stable `@eN` refs (per-tab), pruned of layout noise. Cross-checks against a DOM walk (same refs) when the a11y tree looks suspiciously sparse — Telegram Web K and similar SPAs. `mode=auto\|a11y\|dom`; `compact=true` → flat list of actionable elements only; `selector` scopes to one subtree. |
| `read_text` | Whole-page or by ref. No raw JS. Capped at 20 000 chars by default (`maxChars` overrides; cut results carry `truncated`/`totalChars`). |
| `get_state` | Cheap one-element probe (CSS or `@eN`) — `{exists, visible, tag, text, box?, inViewport?}` without a full snapshot. Verify an action's effect or re-check a ref in one round-trip. Never errors on a missing node: returns `{exists:false, reason}` (`not_found`/`unknown_ref`/`detached`), so it is safe to poll. Does **not** read input `.value` (no password readback). Structured CDP only. |
| `console_tail` | Recent page console errors/warnings + uncaught exceptions for a tab (`{enabled, entries:[{ts,level,text,origin}]}`) — tell "the handler threw and the page is wedged" from "merely slow". **Opt-in** (popup setting, off by default; returns `{enabled:false}` when off). Capture starts at first attach (no replay); entries are **origin-filtered to the allowlist**. Pure CDP event capture, no `evaluate`. |
| `network_tail` | Recent XHR/fetch responses for a tab (`{enabled, entries:[{ts,method,url,status,type,contentType,size,body?}]}`) — **the data behind canvas dashboards** (Metrika, Chart.js, WebGL) that have no readable DOM. Pull exact JSON instead of screenshot + vision. **Opt-in** (popup "capture API responses", off by default). Bodies only for textual content-types, capped; no auth headers captured; entries **origin-filtered to the allowlist**; `filter` narrows by URL substring. Pure CDP event capture, no `evaluate`. |
| `click` | DOM `.click()`. CSS selector or `@eN` ref. Optional `waitFor` polls for the click's effect in the same call. |
| `mouse_click` | Real `Input.dispatchMouseEvent` as a full hover→press→release sequence. Auto-aims around partial overlays; a fully covered target reports `covered`/`hitTarget`/`hitTargetRef`. Explicit `x`/`y` (viewport CSS px) as manual aim. `button` left/middle/right, `clickCount` 1–3, optional `waitFor`. |
| `hover` | Hover the pointer over an element/point without clicking (the `mouseMoved` preamble only). For CSS `:hover`-only menus, tooltips, row-action UIs. `selector`/`@eN` (auto-aimed, reports `covered`/`hitTargetRef`) or viewport `x`/`y`; optional `waitFor` to hover→wait-for-menu. Strictly weaker than `mouse_click`; the `:hover` state is transient. |
| `fill` | Blocks password fields without `allowPassword=true`. `method=insertText` clears the field and types via CDP with real input events (for SPA editors that ignore programmatic values). Optional `waitFor`. |
| `select_option` | Choose an option in a native `<select>` (the OS popup can't be driven via CDP). Sets the value in the DOM and fires `input`/`change` instead of opening the menu. One of `value`/`label`/`index`; array for `<select multiple>`. `wrong_element` for non-`<select>` targets — custom JS comboboxes (react-select, MUI) stay on `click`/`find`/`reveal`. Optional `waitFor`. |
| `key_type` | Raw text input via CDP. Blocks when focus is on a password field without `allowPassword=true`. |
| `send_keys` | `Mod+A`, `Shift+Tab`, etc. `Mod` = `Cmd` on macOS, `Ctrl` elsewhere. Same password-field gate as `key_type`. |
| `screenshot` | PNG/JPEG as a native MCP image block. `maxWidth` downscales, `region={x,y,width,height}` crops (viewport-relative CSS px). Hidden tabs fail fast with `tab_not_visible`; `bringToFront=true` activates the tab first (steals focus). |
| `wait_for` | Poll (250 ms) until a selector/`@eN` ref is visible and/or page text contains a substring; `absent=true` waits until it is GONE. `timeoutMs` ≤ 30 s; timeout returns `{found:false}`, not an error. Replaces blind sleeps. Prefer the embedded `waitFor` on the preceding action when there is one. |
| `settle` | Wait for the DOM to stop changing (element count + page size steady for `stableMs`, default 500 ms) — for "the page just did *something*" moments with no single element to `wait_for`. Poll (250 ms), ≤ 30 s; a never-settling page returns `{settled:false}`, not an error. |
| `find` | Semantic element locator — match by `role`/`name`/`nameExact`/`value` over the accessibility tree instead of a CSS selector, ranked exact-match-first (`limit`, ≤ 50). No `evaluate`, no probe. |
| `reveal` | Scroll a virtualized list/container and re-`snapshot` until an element matching `find`'s predicate appears — for infinite-scroll feeds and lazy-rendered tables. Stops on found/stall/`maxSteps` (≤ 40)/timeout. |
| `scroll` | Deterministic scrolling — the predicate-less companion to `reveal`. `selector` → `scrollIntoView`; or scroll the page (or a `selector` container) by `dx`/`dy` (negatives = up/left) or `to='top'\|'bottom'`. Returns `{x, y, scrollHeight, atBottom}` so a lazy-load loop knows when to stop. Fixed scroll probe, no `evaluate`. |
| `evaluate` | Per-domain opt-in. Returns `{type, value}`. |
| `fetch_in_page` | `fetch()` with page cookies/auth. Returns `{status, contentType, headers, mode, data}`. Allowlist-gated. |
| `upload` | Attach local files to `<input type=file>` via `DOM.setFileInputFiles`. Paths must be absolute, `..`-free, **and resolve under `~/Downloads/sallyport/`** (override via `SALLYPORT_DOWNLOAD_DIR`) — same sandbox as `save_to_file`, with symlink escapes blocked by `Path.resolve()`. Target must really be a file input. Allowlist-gated. |
| `save_to_file` | **Daemon-local** — writes base64 to `~/Downloads/sallyport/<filename>` (override via `SALLYPORT_DOWNLOAD_DIR`). Sandboxed: no path separators or `..`. |
| `status` | **Daemon-answered** health check: `{connected, mode, version, port, pendingCalls, uptimeS, lastCalls, lastError, lastHandshakeError}`. `mode` is `broker` (explicit owned `tabId` required per call) or `standalone` (active-tab fallback). `lastCalls` is a ring of recent tool **outcomes** (`{tool, ok, ms, code?}` — never the args) and `lastError` the latest failure, so a loop can attribute a stall to a specific tool/code; when `connected` is false, `lastHandshakeError` says why the extension leg failed to attach (wrong secret, clock skew, no hello). No browser round-trip and never queues behind a running call — use it as preflight before browser work. |

All tools accept `tabId` to target a specific tab; otherwise they use the
active tab in the current window. There is no implicit "last touched tab"
memo — explicit IDs win, the active tab is the only fallback.

For agents running on a schedule, the cheap iteration shape is: `status`
(skip everything if the extension is detached) → scoped reads
(`snapshot selector=… compact=true`, `read_text ref=…`) → actions with
embedded `waitFor` instead of separate `wait_for` calls → verify with
`get_state ref=…` (one element) instead of re-snapshotting the whole page.
Driven tabs are
kept awake automatically, so the loop keeps working while the browser
window sits in the background (see Troubleshooting for the trade-offs).

## Compared to Kimi WebBridge

Sallyport implements the everyday Kimi tools (`navigate`, `click`, `fill`,
`snapshot`, `screenshot`, `evaluate`, `mouse_click`, `upload`, …) and adds
a few of its own (`fetch_in_page`, `save_to_file`, `reload`). Three Kimi
features are deliberately *not* here:

| Kimi feature | Why Sallyport omits it | If you need the behaviour |
|---|---|---|
| `network` (start/stop/list/detail HTTP capture via `Network.enable`) | Kimi's version captures auth headers, cookies, and every request body with no per-domain gate — that ungated shape is what Sallyport omits. | Use `network_tail`: a gated subset — opt-in per popup, **response bodies only** (no headers/cookies), origin-filtered to the allowlist. Or `fetch_in_page` against a specific URL. |
| `save_as_pdf` (`Page.printToPDF`) | Niche — `screenshot` (full-page PNG/JPEG) already covers "preserve what's on screen" for the agent tasks we've seen. | Speak up if you hit a case where selectable PDF text matters; trivial to add. |
| `_session` (per-agent Chrome tab groups, coloured) | Cosmetic flair that complicates tab handling without solving a real problem at current scale. | Use `list_tabs` to find what you opened. |

`find_tab` is also intentionally absent: Sallyport's `list_tabs` returns the
full set and the agent filters client-side — one round trip instead of two.

## Testing it locally

Three layers, from fastest to most realistic:

### A. Wire only — no MCP, no Claude Code

Confirms HMAC pairing, allowlist, audit log without any tools firing.

```sh
# terminal: run the daemon in WS-only mode. Stays up until Ctrl-C —
# no stdin / no MCP client needed.
sallyport-daemon serve
```

Default `sallyport-daemon` (no subcommand) expects an MCP client on stdin and
exits immediately on EOF — fine for Claude Code, awkward for local testing.
Use `serve` whenever you want a stable long-running daemon.

Open the popup → **Pair** → paste secret → status flips to **connected**.
That alone proves: WS reach, HMAC handshake, perms.

### B. Fire individual tools from the shell — no Claude Code

`sallyport-daemon exec <tool> key=value...` spins up the daemon, waits for the
extension, calls one tool, prints JSON, exits. Values are JSON when
parseable, otherwise strings.

```sh
# Catalogue of tools (works offline, no extension needed):
sallyport-daemon list-tools

# Open a tab (the host must already be in the popup's allowlist):
sallyport-daemon exec navigate url=https://example.com newTab=true

# Read the page:
sallyport-daemon exec read_text

# Get the accessibility tree + refs:
sallyport-daemon exec snapshot

# Click something from snapshot (use a ref):
sallyport-daemon exec click selector=@e3

# Targeted screenshot:
sallyport-daemon exec screenshot format=jpeg quality=70
```

Notes:
- `exec` mode is mutually exclusive with the Claude Code MCP session
  (single-client invariant in the WS server). Stop Claude Code first, or
  pass a different `--port` here and update the popup's daemon URL.
- The first `exec` waits up to 10s (`--wait 30` to bump it) for the popup
  to connect. Once paired, the extension reconnects on its own.
- Screenshot blobs are truncated in the printout — they're still passed
  in full to a real MCP client.

### C. End-to-end with Claude Code

Once A and B work, register the MCP server (see Setup → step 3), restart
Claude Code, and ask it to do anything web-shaped. Watch the popup's
**Audit** tab — every call lands there with `ok`/`error` and target URL.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Anything in setup feels off | Run `sallyport-daemon doctor` — it checks Python version, secret + perms, and port, and reprints the pairing block. |
| Popup stuck on **"Connecting to daemon…"** | The daemon isn't reachable at the popup's URL. Confirm it's running (`sallyport-daemon serve` in another shell), that the **Advanced → daemon URL** matches (default `ws://127.0.0.1:10086/ws`), and that the port is free (`sallyport-daemon doctor`). The single-client rule means a live Claude Code session already holds the port — that's expected; the extension connects to *it*. |
| Popup says **"extension is not connected"** | Daemon isn't running, or the popup says **paused** — open and hit **Resume**/**Reconnect**. |
| `domain_not_allowed` | Add the host to the **Allowlist** tab. |
| `evaluate_not_allowed` | Edit the allowlist entry and re-add with **allow evaluate()** checked. |
| `password_field` (from `fill`) | `fill` refuses `<input type=password>` by default. Pass `allowPassword=true` if you really mean it. |
| `wrong_element` (from `upload`) | Selector resolved to something other than `<input type=file>`. Re-`snapshot` and pick a real file-input ref. |
| `wrong_element` (from `select_option`) | Target isn't a native `<select>` — it's a custom JS combobox (react-select, MUI, Radix). Those live in the DOM: `click`/`mouse_click` to open, then `click` the option (use `find`/`reveal` to locate it). |
| `unsafe_path` (from `upload`) | Path contains `..`, isn't absolute, or resolves outside the sandbox (default `~/Downloads/sallyport/`). Stage the file via `save_to_file` first (writes to the sandbox), then upload. Widen the sandbox via `SALLYPORT_DOWNLOAD_DIR` if you really need to upload from elsewhere. |
| `not_visible` (from `mouse_click`) | Element has zero size — likely `display:none` or detached. Snapshot again; if it's hidden by design, drive the toggle that reveals it. |
| `mouse_click` reports `covered: true` | Another node sits on top of the target at every probe point. The result includes `hitTarget` (what ate the click) and `hitTargetRef` — an `@eN` for that node; click it directly, or aim manually with `mouse_click x= y=`. |
| Automation stalls when the browser window is in the background | Chrome freezes background tabs and fully-occluded windows. The bridge keeps driven tabs awake automatically (popup → **Advanced → keep automated tabs awake**, default on; note the page then believes it is focused — e.g. Telegram sends read receipts). If a page must stay alive *before* the bridge attaches, add its site under `chrome://settings/performance` → "Always keep these sites active", or run a dedicated automation profile with `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`. |
| `tab_not_visible` (from `screenshot`) | Hidden tabs render no frames — keep-awake can't help with pixels. Pass `bringToFront=true` (steals focus), activate the tab yourself, or keep a sliver of the window visible: macOS occlusion only kicks in when it's *fully* covered. |
| `bad_ref` | An `@eN` ref is stale (snapshot expired) or addressed at the wrong tab. Re-`snapshot` the right tab. Refs are per-tab and per-snapshot. |
| `mac mismatch` (in popup) | Secret in `~/.config/sallyport/secret` no longer matches the one paired in the popup. Run `sallyport-daemon --show-secret`, copy, **Unpair** → paste → **Pair**. |
| `timestamp skew` | Clocks are >30 s apart. Check NTP. |
| Daemon warns about **loose permissions** on startup | `chmod 600 ~/.config/sallyport/secret`. |
| WS frame >16 MiB | The extension is silently dropped with a 1009 close. Lower screenshot quality or take a region screenshot. |

### Rotating the secret

1. `rm ~/.config/sallyport/secret`
2. Restart whatever runs `sallyport-daemon` (Claude Code will respawn it on next call). A new secret prints to stderr.
3. In the popup: **Unpair** → paste new secret → **Pair**.

## Development

```sh
# Extension
cd extension
npm install
npm run watch         # esbuild rebuild on save — reload extension in chrome://extensions to pick up
npm run typecheck     # tsc --noEmit
npm test              # vitest run
npm run lint          # eslint
npm run format        # prettier --write
npm run format:check  # prettier --check (CI gate)

# Daemon
cd daemon
pip install -e '.[dev]'
ruff check .
mypy
pytest -q
sallyport-daemon --verbose < <(sleep 99999)   # smoke-test a long-running daemon
```

### Pre-commit

```sh
pip install --user pre-commit
pre-commit install
```

This runs trailing-whitespace/json/yaml/merge-conflict checks plus ruff, mypy,
prettier, eslint, and tsc on each commit. Heavy test suites stay in CI
because they're too slow for a commit gate.

### CI

`.github/workflows/ci.yml` matrices over Python 3.10/3.11/3.12 (daemon) and
Node 20/22 (extension), runs lint + typecheck + tests + build for both, and
uploads `extension/dist` as an artefact on `main`.

### Adding a new tool

Five files, same order both for an extension-side tool and a daemon-local
one — keep tool names byte-identical on both sides since routing is a dict
lookup.

1. **Implement.** Extension-side: a new `extension/src/tools/<name>.ts`
   exporting a `Tool`. Pure validators (path / arg shape) belong in a
   chrome-free sibling module like `upload-path.ts` so vitest can cover
   them without a chrome harness. Daemon-only: a coroutine in
   `daemon/src/sallyport_daemon/local_tools.py` registered in `LOCAL_TOOLS`.
2. **Register on the extension side.** Add an import + entry to the `tools`
   map in `extension/src/tools.ts`.
3. **Declare the MCP schema.** Append a `Tool(name=..., description=...,
   inputSchema=...)` to `TOOLS` in `daemon/src/sallyport_daemon/mcp_server.py`.
   Mark fields `required` whenever the implementation throws without them —
   schema and behaviour should agree (see the `close_tab` regression
   captured by `test_close_tab_requires_tab_id`).
4. **Pin the catalogue.** Add the new name to the expected set in
   `daemon/tests/test_mcp_server.py::test_tools_catalogue_covers_extension`.
   Mismatches between the daemon and extension registries fail the build
   immediately rather than at the wire.
5. **Document.** A row in the Tools table in `README.md`, and an entry in
   `CHANGELOG.md` under `[Unreleased] / Added` describing the user-visible
   shape (args, gates, error codes worth knowing).

Then `cd extension && npm test && npm run lint && npm run typecheck`
and `cd daemon && ruff check . && mypy && pytest -q` — all green before
calling it done.

## Versioning & releases

`CHANGELOG.md` tracks every notable change; the project uses
[Semantic Versioning](https://semver.org/). The wire protocol version is
**1** — bump only on incompatible changes and update the cross-language
vector tests in the same commit.

## License

MIT — see `LICENSE`.

## Wire protocol

Documented in `extension/src/protocol.ts` and
`daemon/src/sallyport_daemon/protocol.py`. Envelope shape:

```
{ v, ts, nonce, type, id?, body, mac }
```

`mac = HMAC-SHA256(secret, canonical_json({v, ts, nonce, type, id?, body}))`,
base64. Canonical JSON: keys sorted by Unicode code point, no whitespace,
unicode passthrough, cross-language number formatting.

The exact bytes are pinned to **49 cross-language vectors** in
`fixtures/canonical-vectors.json` — both `daemon/tests/test_vectors.py`
and `extension/test/vectors.test.ts` read that file and assert byte-by-byte
agreement. If you change the canonicalisation rules, regenerate via
`python3 fixtures/generate.py` and update both implementations in the
same commit.

There is no version negotiation — both sides expect `v: 1`. Bump it on
breaking changes and update both vector tests in the same commit.
