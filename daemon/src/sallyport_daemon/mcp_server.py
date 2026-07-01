"""MCP server: exposes the bridge tools to Claude Code over stdio.

Each tool here is a thin wrapper around :class:`Bridge.call_tool`. The MCP SDK
takes care of stdio framing and protocol details.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import ImageContent, TextContent, Tool

from .bridge import Bridge, ExtensionNotConnected, ToolError
from .error_taxonomy import format_error_hint

log = logging.getLogger("sallyport.mcp")

# Cap on the appended structured-detail JSON line. Producers cap their own
# detail (select_option bounds `available` to 50 options); this is a defensive
# ceiling so a future producer can't bloat the tool output — an oversized detail
# is dropped (the human message still carries the gist), never truncated into
# unparseable JSON.
MAX_DETAIL_JSON = 4000


# Embedded post-action wait, shared by navigate/click/mouse_click/fill.
_WAIT_FOR_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "selector": {"type": "string", "description": "CSS selector or @eN ref"},
        "text": {"type": "string", "description": "Substring of the page's visible text"},
        "timeoutMs": {"type": "integer", "minimum": 0, "maximum": 30000, "default": 10000},
        "absent": {
            "type": "boolean",
            "default": False,
            "description": "Wait until GONE instead of present",
        },
    },
    "additionalProperties": False,
    "description": (
        "Optional post-action wait (same engine as wait_for): after the action "
        "succeeds, poll until selector/text is present-and-visible (or gone, "
        "with absent=true). Saves the follow-up wait_for round-trip — prefer "
        "this over a separate wait_for call. The result gains "
        "wait:{found, elapsedMs, reason?}; a wait timeout or error never fails "
        "the action itself. On found=false, reason says why so you can branch: "
        "'timeout' (not true yet — retry/longer may help), 'bad_ref' (stale "
        "@eN after a re-render — re-snapshot), 'invalid_selector' (malformed "
        "CSS you passed — permanent, fix the selector), 'error' (other)."
    ),
}

# Mirrors the tool registry in extension/src/tools.ts. Kept short and explicit
# so Claude knows the shape of every call without guessing.
TOOLS: list[Tool] = [
    Tool(
        name="list_tabs",
        description=(
            "List open browser tabs (tabId, url, title, active, windowId). In broker "
            "mode (a shared broker daemon serving several sessions) this is owner-scoped: "
            "it returns only the tabs THIS session created, never the human's or another "
            "session's tabs."
        ),
        inputSchema={"type": "object", "properties": {}, "additionalProperties": False},
    ),
    Tool(
        name="navigate",
        description=(
            "Open a URL. The destination domain must be in the extension's allowlist "
            "or the call fails with domain_not_allowed. Set newTab=true to open a "
            "new tab; otherwise updates the tab passed in tabId, or the active tab "
            "in the current window if tabId is omitted. In broker mode (a shared "
            "broker daemon) there is no active-tab fallback: a navigate with no tabId "
            "opens a NEW tab you own, and a tabId must reference a tab you created "
            "(else tab_not_owned). waitFor polls after the "
            "load until a selector/text shows up — on SPAs 'loaded' rarely means "
            "'rendered', so prefer navigate+waitFor over navigate then wait_for. "
            "Returns {tabId, url, wait?}."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "newTab": {"type": "boolean", "default": False},
                "tabId": {"type": "integer"},
                "waitFor": _WAIT_FOR_SCHEMA,
            },
            "required": ["url"],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="close_tab",
        description=(
            "Close a tab by tabId. tabId is required — there is no implicit "
            "fallback because closing the wrong tab destroys user work. "
            "Allowlist-gated: the tab's URL must be in the extension's "
            "allowlist, otherwise the call fails with domain_not_allowed "
            "(prevents an agent from closing non-allowlisted tabs it can "
            "still see via list_tabs)."
        ),
        inputSchema={
            "type": "object",
            "properties": {"tabId": {"type": "integer"}},
            "required": ["tabId"],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="reload",
        description=(
            "Reload a tab. Pass bypassCache=true to force a hard reload that "
            "skips the HTTP cache (equivalent to Ctrl/Cmd+Shift+R). The "
            "destination must already be in the allowlist; refs from the "
            "previous snapshot are invalidated."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "tabId": {"type": "integer"},
                "bypassCache": {"type": "boolean", "default": False},
            },
            "additionalProperties": False,
        },
    ),
    Tool(
        name="snapshot",
        description=(
            "Return the accessibility tree of the current/target tab. Interactive "
            "elements get stable refs like @e1, @e2 which other tools accept in place "
            "of CSS selectors. If the a11y tree exposes suspiciously few "
            "interactive elements (canvas-style SPAs like Telegram Web render an "
            "empty or stale tree), a DOM walk runs as a cross-check and whichever "
            "side finds more actionable elements wins — visible text + "
            "interactive elements with the same @eN refs; the result's `source` "
            "field says which path won ('a11y' or 'dom'). mode forces a path: "
            "'auto' (default), 'a11y', 'dom'. "
            "compact=true returns a flat `elements` list of just the actionable "
            "elements ({ref, role, name, value?, type?}) instead of the full tree "
            "— much smaller; use it when you need something to click, not the page "
            "text. `type` (DOM-sourced snapshots) is the input's HTML type, so a "
            "field that reads as `textbox` but is actually `type=password` is "
            "visible before you fill it. "
            "selector (CSS or @eN) scopes the snapshot to one subtree (always a "
            "DOM walk, source='dom') — on big SPAs snapshot just the panel you "
            "work with (chat list, composer) instead of the whole page; combine "
            "with compact for the smallest result. Domain must be in allowlist."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "tabId": {"type": "integer"},
                "mode": {
                    "type": "string",
                    "enum": ["auto", "a11y", "dom"],
                    "default": "auto",
                },
                "compact": {
                    "type": "boolean",
                    "default": False,
                    "description": "Flat list of interactive elements only, no tree",
                },
                "selector": {
                    "type": "string",
                    "description": "Scope to this subtree (CSS selector or @eN ref)",
                },
            },
            "additionalProperties": False,
        },
    ),
    Tool(
        name="read_text",
        description=(
            "Read the text content of the page, or of a specific element if ref is given. "
            "No arbitrary JS — uses CDP's Runtime.callFunctionOn with a fixed function. "
            "Output is capped at 20000 chars by default (override with maxChars); a cut "
            "result carries truncated=true + totalChars. Prefer ref / a scoped target "
            "over whole-page reads on chat-style SPAs."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "ref": {"type": "string", "description": "Optional @eN ref from snapshot"},
                "maxChars": {
                    "type": "integer",
                    "minimum": 1,
                    "default": 20000,
                    "description": "Cap on returned characters",
                },
                "tabId": {"type": "integer"},
            },
            "additionalProperties": False,
        },
    ),
    Tool(
        name="get_state",
        description=(
            "Cheap single-element probe — answer 'is this still here / visible / "
            "where / what does it say' WITHOUT a full snapshot. selector is a CSS "
            "selector or an @eN ref. Use it to verify an action's effect or "
            "re-check a ref after navigation in one tiny round-trip instead of "
            "re-snapshotting the whole page. It NEVER errors on a missing element: "
            "a vanished node returns {exists:false, reason} (reason is "
            "'not_found' for a CSS miss, 'unknown_ref' for an @eN this tab never "
            "minted / lost on navigation, 'detached' for a ref whose node died) — "
            "so it is safe to poll. On a hit returns {exists:true, visible, tag, "
            "text, box?:{x,y,width,height}, inViewport?, ref?, role?, name?}: "
            "`visible` is true when the element has a laid-out box (matches "
            "wait_for); `box`/`inViewport` (viewport-relative CSS px, the same "
            "coordinates mouse_click's x/y take) appear only when visible; `text` "
            "is trimmed innerText capped at 2000 chars (override maxChars, max "
            "20000; truncated/textLen mark a cut). Does NOT read input .value (so "
            "it can't expose a password field's contents — use snapshot's `type` "
            "or fill's read-back for field state). Structured CDP only, no "
            "evaluate flag. Domain must be in allowlist."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "selector": {"type": "string", "description": "CSS selector or @eN ref"},
                "maxChars": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 20000,
                    "default": 2000,
                    "description": "Cap on returned text characters",
                },
                "tabId": {"type": "integer"},
            },
            "required": ["selector"],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="console_tail",
        description=(
            "Read the page's recent console errors/warnings and uncaught "
            "exceptions for a tab — so you can tell 'the click succeeded but the "
            "SPA's handler threw and the page is wedged' from a page that's "
            "merely slow. Returns {enabled, entries:[{ts, level, text, "
            "origin}], truncated?} (oldest→newest; level is 'error'|'warning'). "
            "OPT-IN: capture must be turned on in the extension popup "
            "(off by default) — when it's off you get {enabled:false, "
            "entries:[]}, NOT an error, so an empty result isn't misread as 'no "
            "errors'. Capture begins at the first bridge attach with the "
            "setting on — there is NO history replay, so errors thrown before "
            "then aren't captured. Entries are origin-filtered to the allowlist "
            "(a tab that navigated cross-origin won't leak a non-allowlisted "
            "origin's console). limit caps how many recent entries return "
            "(default 50, max 50). Structured CDP event capture only — no JS "
            "eval. Domain must be in allowlist."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 50,
                    "default": 50,
                    "description": "Max recent entries to return",
                },
                "tabId": {"type": "integer"},
            },
            "additionalProperties": False,
        },
    ),
    Tool(
        name="click",
        description=(
            "Click an element via DOM .click(). selector can be a CSS selector or a "
            "@eN ref from snapshot. Refs are more reliable on SPAs. waitFor "
            "polls for the click's effect (panel opened, item selected) in the "
            "same call."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "selector": {"type": "string"},
                "tabId": {"type": "integer"},
                "waitFor": _WAIT_FOR_SCHEMA,
            },
            "required": ["selector"],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="mouse_click",
        description=(
            "Click via real Input.dispatchMouseEvent as a full pointer "
            "sequence — hover move, then press and release with human-ish "
            "delays — so pointer-event routers (React SPAs) that ignore a "
            "bare press+release accept it. Use this when the regular `click` "
            "(DOM .click()) doesn't trip pointer-event listeners — common on "
            "canvas-heavy UIs, drag-and-drop libraries (react-dnd), and "
            "games. Target is EITHER selector (CSS or @eN ref) OR explicit "
            "viewport coordinates x+y (CSS px — manual aim from a screenshot "
            "or hit diagnostics; rejected if outside the viewport). With a "
            "selector, the click point is auto-aimed: center first, then "
            "four points toward the corners, picking one where the target "
            "is actually the topmost element. If every probe point is "
            "covered by another node (overlay), the click still fires at "
            "the center and the result reports `covered: true`, a "
            "`hitTarget` descriptor, and `hitTargetRef` — an @eN ref for "
            "the covering node, so the agent can click IT directly (the "
            "covering layer often owns the event handler). button is 'left' "
            "(default), 'middle', or 'right'. clickCount is 1..3 "
            "(double/triple click). Allowlist-gated. Refuses zero-size "
            "elements with `not_visible`."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "selector": {"type": "string", "description": "CSS selector or @eN ref"},
                "x": {
                    "type": "number",
                    "minimum": 0,
                    "description": "Viewport X in CSS px (use with y, instead of selector)",
                },
                "y": {
                    "type": "number",
                    "minimum": 0,
                    "description": "Viewport Y in CSS px (use with x, instead of selector)",
                },
                "button": {
                    "type": "string",
                    "enum": ["left", "middle", "right"],
                    "default": "left",
                },
                "clickCount": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 3,
                    "default": 1,
                },
                "tabId": {"type": "integer"},
                "waitFor": _WAIT_FOR_SCHEMA,
            },
            "additionalProperties": False,
        },
    ),
    Tool(
        name="hover",
        description=(
            "Hover the pointer over an element/point WITHOUT clicking — a real "
            "Input.dispatchMouseEvent mouseMoved (the hover step mouse_click "
            "sends before pressing). Use it for CSS :hover-only dropdown menus, "
            "tooltips and 'show actions on row hover' UIs that a click would "
            "dismiss or mis-activate. Target is EITHER selector (CSS or @eN, "
            "auto-aimed like mouse_click — reports covered/hitTarget/hitTargetRef "
            "when an overlay sits on top) OR explicit viewport x+y (CSS px, "
            "rejected if outside the viewport). Pair with waitFor to "
            "hover-then-wait-for-the-menu in one call, then click the item. "
            "Strictly weaker than mouse_click: no press/release, nothing is "
            "activated. NOTE: the :hover state is transient — a synthetic "
            "mouseMoved holds it only until the next mouse move, so do the "
            "follow-up action promptly. Allowlist-gated. Returns {ok, tag?, x, "
            "y, covered?, hitTarget?, hitTargetRef?, wait?}."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "selector": {"type": "string", "description": "CSS selector or @eN ref"},
                "x": {
                    "type": "number",
                    "minimum": 0,
                    "description": "Viewport X in CSS px (use with y, instead of selector)",
                },
                "y": {
                    "type": "number",
                    "minimum": 0,
                    "description": "Viewport Y in CSS px (use with x, instead of selector)",
                },
                "tabId": {"type": "integer"},
                "waitFor": _WAIT_FOR_SCHEMA,
            },
            "additionalProperties": False,
        },
    ),
    Tool(
        name="fill",
        description=(
            "Type into an input/textarea/contenteditable. Refuses password fields "
            "unless allowPassword=true. method='value' (default) sets .value and "
            "dispatches input/change events, then READS THE VALUE BACK and "
            "auto-falls-back to insertText if a framework (React-controlled "
            "inputs) reverted it — so it never silently returns ok:true on an "
            "empty field; the fallback result carries mode='insertText', "
            "fallbackFrom='value'. method='insertText' clears the field and types "
            "through CDP Input.insertText with real input events — force it when "
            "the app ignores programmatic values or concatenates text (SPA "
            "editors: Telegram, Slack, draft.js)."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "selector": {"type": "string"},
                "value": {"type": "string"},
                "method": {
                    "type": "string",
                    "enum": ["value", "insertText"],
                    "default": "value",
                },
                "allowPassword": {"type": "boolean", "default": False},
                "tabId": {"type": "integer"},
                "waitFor": _WAIT_FOR_SCHEMA,
            },
            "required": ["selector", "value"],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="select_option",
        description=(
            "Set the value of a NATIVE <select> dropdown (single or multiple) "
            "WITHOUT opening the OS popup — it sets the selection in the DOM and "
            "fires input+change. Use this for <select>: the OS dropdown popup is "
            "drawn by the operating system, not the page, so it cannot be driven "
            "via clicks/keys (keys are ignored, Escape just closes it); this is "
            "the reliable path. selector is a CSS selector or @eN ref. Give "
            "EXACTLY ONE of: value (option value), label (visible option text, "
            "trimmed), or index (0-based). Pass an array for <select multiple> "
            "(e.g. value=['a','c']); a single string/int selects one. Errors: "
            "wrong_element when the target is not a real <select> — custom JS "
            "comboboxes (react-select, MUI, Radix) live in the DOM, so open them "
            "with click/mouse_click and pick the option with click (find/reveal "
            "locate it) instead; not_found lists the available options; bad_args "
            "for a disabled option/select or an array against a single-select. "
            "waitFor polls after the change lands. Returns {ok, tag, multiple, "
            "selected:[{index,value,label}], wait?}."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "selector": {
                    "type": "string",
                    "description": "CSS selector or @eN ref of the <select>",
                },
                "value": {
                    "description": "option.value to select; array for <select multiple>",
                    "oneOf": [
                        {"type": "string"},
                        {"type": "array", "items": {"type": "string"}},
                    ],
                },
                "label": {
                    "description": "visible option text to select; array for <select multiple>",
                    "oneOf": [
                        {"type": "string"},
                        {"type": "array", "items": {"type": "string"}},
                    ],
                },
                "index": {
                    "description": "0-based option index; array for <select multiple>",
                    "oneOf": [
                        {"type": "integer", "minimum": 0},
                        {"type": "array", "items": {"type": "integer", "minimum": 0}},
                    ],
                },
                "tabId": {"type": "integer"},
                "waitFor": _WAIT_FOR_SCHEMA,
            },
            "required": ["selector"],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="key_type",
        description=(
            "Insert raw text via CDP Input.insertText (no key events). Refuses "
            "when focus is on <input type=password> — pass allowPassword=true "
            "to override (mirrors `fill`'s gate, since keystrokes would "
            "otherwise bypass it once the password field has focus)."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "allowPassword": {"type": "boolean", "default": False},
                "tabId": {"type": "integer"},
            },
            "required": ["text"],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="send_keys",
        description=(
            "Dispatch key events. Examples: 'Enter', 'Escape', 'Mod+A' (Cmd on macOS, "
            "Ctrl elsewhere), 'Shift+Tab', 'Enter Escape' (multiple, space-separated). "
            "Refuses when focus is on <input type=password> — pass "
            "allowPassword=true to override."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "keys": {"type": "string"},
                "allowPassword": {"type": "boolean", "default": False},
                "tabId": {"type": "integer"},
            },
            "required": ["keys"],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="screenshot",
        description=(
            "Take a screenshot of the viewport, returned as a native MCP image "
            "block (rendered directly — no base64 handling needed). format is "
            "'png' (default) or 'jpeg' (smaller; quality 1-100, default 80). "
            "maxWidth downscales the capture to at most that many CSS px wide "
            "(e.g. 800) to cut size. region={x,y,width,height} crops to a "
            "viewport-relative CSS-px rectangle (getBoundingClientRect "
            "coordinates); it is intersected with the viewport. Hidden tabs "
            "(background tab, occluded window) cannot render a frame — the "
            "call fails fast with `tab_not_visible` instead of hanging; pass "
            "bringToFront=true to activate the tab first (it visibly steals "
            "the user's tab/window focus, so only when intended). In broker "
            "mode bringToFront is refused (`bringtofront_forbidden`) and agent "
            "tabs open in the background, so only an already-active agent tab is "
            "captureable — use snapshot/read_text for any other tab. Prefer "
            "snapshot/read_text for understanding page structure."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "format": {"type": "string", "enum": ["png", "jpeg"], "default": "png"},
                "quality": {"type": "integer", "minimum": 1, "maximum": 100},
                "bringToFront": {
                    "type": "boolean",
                    "default": False,
                    "description": "Activate the tab before capturing (steals focus)",
                },
                "maxWidth": {
                    "type": "integer",
                    "minimum": 16,
                    "description": "Downscale so the image is at most this wide (CSS px)",
                },
                "region": {
                    "type": "object",
                    "properties": {
                        "x": {"type": "number"},
                        "y": {"type": "number"},
                        "width": {"type": "number"},
                        "height": {"type": "number"},
                    },
                    "required": ["x", "y", "width", "height"],
                    "additionalProperties": False,
                    "description": "Viewport-relative crop rectangle in CSS px",
                },
                "tabId": {"type": "integer"},
            },
            "additionalProperties": False,
        },
    ),
    Tool(
        name="wait_for",
        description=(
            "Wait until a CSS selector (or @eN ref) is present AND visible, "
            "and/or until the page's visible text contains a substring — the "
            "replacement for blind sleeps between actions. absent=true inverts "
            "both: wait until the selector/text is GONE (spinner finished, "
            "modal closed). Polls every 250 ms up to timeoutMs (default 10000, "
            "capped at 30000). At least one of selector/text is required; if "
            "both are given, both must hold. Returns {found, elapsedMs, "
            "reason?}; a timeout returns found=false (reason='timeout') rather "
            "than an error. NOTE: when the "
            "wait directly follows a navigate/click/mouse_click/fill, pass "
            "waitFor on that call instead — one round-trip less. Domain must "
            "be in allowlist."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "selector": {"type": "string", "description": "CSS selector or @eN ref"},
                "text": {"type": "string", "description": "Substring of the page's visible text"},
                "timeoutMs": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 30000,
                    "default": 10000,
                },
                "absent": {
                    "type": "boolean",
                    "default": False,
                    "description": "Wait until GONE instead of present",
                },
                "tabId": {"type": "integer"},
            },
            "additionalProperties": False,
        },
    ),
    Tool(
        name="reveal",
        description=(
            "Scroll a virtualized container and re-snapshot until a target "
            "element appears (gets an @eN), so off-screen list items become "
            "actionable. container is the scrollport (CSS selector — more "
            "robust than @eN across re-renders). The target predicate is the "
            "same as find (role/name/nameExact/value). Scrolls in direction "
            "('down' default / 'up') up to maxSteps (<=40) or timeoutMs "
            "(<=30000), whichever comes first. Terminates on: found, stall "
            "(reached the end), max_steps, or timeout. Returns {found, matches?, "
            "steps, reason?, source?} (source only on the found path). NOTE: this "
            "scrolls the page. Structured CDP only (fixed scroll probe), no "
            "evaluate flag. Domain must be in allowlist."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "container": {
                    "type": "string",
                    "description": "CSS selector or @eN of the scroll container",
                },
                "role": {
                    "oneOf": [
                        {"type": "string"},
                        {"type": "array", "items": {"type": "string"}},
                    ],
                    "description": "Target role (string) or list of roles (match any one)",
                },
                "name": {"type": "string", "description": "Target accessible name/label substring"},
                "nameExact": {"type": "boolean", "default": False},
                "value": {"type": "string", "description": "Substring of the target's value"},
                "direction": {
                    "type": "string",
                    "enum": ["down", "up"],
                    "default": "down",
                },
                "mode": {
                    "type": "string",
                    "enum": ["auto", "a11y", "dom"],
                    "default": "auto",
                },
                "maxSteps": {"type": "integer", "minimum": 1, "maximum": 40, "default": 20},
                "timeoutMs": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 30000,
                    "default": 10000,
                },
                "tabId": {"type": "integer"},
            },
            "required": ["container"],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="scroll",
        description=(
            "Deterministic scrolling — the predicate-less companion to reveal "
            "(which only scrolls while hunting a target and stops on match). Two "
            "modes. (1) Bring an element into view: pass selector (CSS or @eN) "
            "with no dx/dy/to — scrollIntoView({block:'center'}); returns "
            "{mode:'into_view', x, y}. (2) Scroll the page, or a container if "
            "selector is given, by a delta or to an edge: dx/dy are CSS-px "
            "deltas (negative = left/up), OR to='top'|'bottom' jumps to the "
            "edge (don't combine to with dx/dy). Use it to trigger lazy-load / "
            "infinite-scroll feeds (page down repeatedly) — the result "
            "{mode, x, y, scrollHeight, atBottom} tells you when you've "
            "bottomed out so the loop can stop. Structured CDP only (fixed "
            "scroll probe), no evaluate flag. Domain must be in allowlist."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "selector": {
                    "type": "string",
                    "description": "Element to bring into view, or the container to scroll",
                },
                "dx": {"type": "number", "description": "Horizontal scroll delta in CSS px (±)"},
                "dy": {"type": "number", "description": "Vertical scroll delta in CSS px (±)"},
                "to": {
                    "type": "string",
                    "enum": ["top", "bottom"],
                    "description": "Jump to an edge instead of a delta",
                },
                "tabId": {"type": "integer"},
            },
            "additionalProperties": False,
        },
    ),
    Tool(
        name="find",
        description=(
            "Semantic locator: snapshot the page and return @eN refs of "
            "interactive elements matching a predicate, instead of guessing CSS "
            "against hashed SPA classnames. Give any of: role (a string, or a "
            "list = match any one), name (substring; nameExact=true for an "
            "exact case-insensitive match), value (substring). Results are "
            "ranked (exact-name first) and capped by limit. Returns {source, "
            "matches:[{ref,role,name,value,type,score}], total, truncated?} "
            "(truncated set when the snapshot was capped). Empty matches is a "
            "normal not-found, not an error. The match runs in the extension "
            "over the snapshot — no page JS, no evaluate flag. Domain must be "
            "in allowlist."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "role": {
                    "oneOf": [
                        {"type": "string"},
                        {"type": "array", "items": {"type": "string"}},
                    ],
                    "description": "Role to match (string), or a list of roles (match any one)",
                },
                "name": {"type": "string", "description": "Accessible name/label substring"},
                "nameExact": {"type": "boolean", "default": False},
                "value": {"type": "string", "description": "Substring of the element's value"},
                "mode": {
                    "type": "string",
                    "enum": ["auto", "a11y", "dom"],
                    "default": "auto",
                },
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10},
                "tabId": {"type": "integer"},
            },
            "additionalProperties": False,
        },
    ),
    Tool(
        name="settle",
        description=(
            "Wait until the DOM stops changing for stableMs (element count AND "
            "body size both hold steady) — the adaptive replacement for a blind "
            "sleep after an action on a busy SPA. Polls every 250 ms up to "
            "timeoutMs (capped at 30000); stableMs is capped at 10000. Returns "
            "{settled, elapsedMs}. A page that never quiesces (live feed, "
            "animation loop), or whose probe never yields a reading, returns "
            "settled=false at the cap — not an error. Structured CDP only (fixed "
            "quiescence probe), no evaluate flag needed. Domain must be in "
            "allowlist."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "stableMs": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 10000,
                    "default": 500,
                    "description": "Window of no DOM change required to call it settled",
                },
                "timeoutMs": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 30000,
                    "default": 10000,
                },
                "tabId": {"type": "integer"},
            },
            "additionalProperties": False,
        },
    ),
    Tool(
        name="evaluate",
        description=(
            "Run arbitrary JavaScript in the page context. REQUIRES the domain to have "
            "evaluate explicitly enabled in the extension allowlist; otherwise fails "
            "with evaluate_not_allowed. Use sparingly — prefer click/fill/read_text."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "code": {"type": "string"},
                "tabId": {"type": "integer"},
            },
            "required": ["code"],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="fetch_in_page",
        description=(
            "Run fetch() from the page's JS context, with its cookies/auth. Use this "
            "to download image/binary URLs you found via snapshot or evaluate "
            "(e.g. card photos from a logged-in 2gis session). The page's host must "
            "be in the allowlist; does NOT require the per-domain evaluate flag "
            "because the function body is fixed (only URL/method/headers/body are "
            "interpolated). Returns {status, contentType, headers, mode, data} where "
            "mode is 'text' for text/json/html/xml content-types or 'base64' otherwise."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "method": {"type": "string", "default": "GET"},
                "headers": {"type": "object", "additionalProperties": {"type": "string"}},
                "body": {"type": "string"},
                "returnAs": {"type": "string", "enum": ["auto", "text", "base64"]},
                "tabId": {"type": "integer"},
            },
            "required": ["url"],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="upload",
        description=(
            "Attach local files to an <input type=file>. selector is a CSS "
            "selector or a @eN ref from snapshot. paths is a non-empty array "
            "of ABSOLUTE filesystem paths (no '..' segments) — Chrome reads "
            "them via the debugger from the user's disk. The page's domain "
            "must be in the allowlist AND each path must resolve to a "
            "location under the daemon sandbox (~/Downloads/sallyport by "
            "default, override via SALLYPORT_DOWNLOAD_DIR — same dir "
            "save_to_file writes to). Paths outside the sandbox fail with "
            "unsafe_path; symlink escapes are caught by Path.resolve(). "
            "Non-file-input targets fail with wrong_element. Typical flow: "
            "fetch_in_page → save_to_file → upload from ~/Downloads/sallyport/."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "selector": {"type": "string"},
                "paths": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                    "description": "Absolute paths to local files",
                },
                "tabId": {"type": "integer"},
            },
            "required": ["selector", "paths"],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="save_to_file",
        description=(
            "Save a base64-encoded blob to ~/Downloads/sallyport/<filename>. Runs "
            "entirely in the daemon (no extension round-trip), sandboxed: filename "
            "must be a single component with no path separators or leading dot. "
            "Override the download directory with SALLYPORT_DOWNLOAD_DIR. Returns "
            "{path, size}. Typical pairing: fetch_in_page → save_to_file."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "data": {"type": "string", "description": "base64-encoded bytes"},
                "filename": {
                    "type": "string",
                    "description": "Single filename component, no slashes or '..'",
                },
            },
            "required": ["data", "filename"],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="status",
        description=(
            "Instant daemon/extension health check — answered by the daemon "
            "itself, no browser round-trip, and it never queues behind a "
            "running tool call. Returns {connected, version, port, "
            "pendingCalls, uptimeS, lastCalls, lastError}. lastCalls is the "
            "last few tool OUTCOMES (oldest→newest) as {tool, ok, ms, code?} "
            "— outcomes only, never the args — and lastError is the most "
            "recent failure {tool, code, error} or null, so you can attribute "
            "'it just timed out' to a specific tool/code. Use it as "
            "loop-iteration preflight: if connected=false, skip the browser "
            "work instead of burning a 60 s timeout."
        ),
        inputSchema={"type": "object", "properties": {}, "additionalProperties": False},
    ),
]


async def _dispatch_call(
    bridge: Bridge, name: str, arguments: dict[str, Any] | None, client_id: str | None = None
) -> list[TextContent | ImageContent]:
    """Run a tool through the bridge and wrap the outcome as MCP content.

    Extracted from `build_server` so the error/format branches can be unit-
    tested directly without standing up an MCP stdio server.
    """
    try:
        data = await bridge.call_tool(name, arguments or {}, client_id)
    except ExtensionNotConnected as exc:
        return [TextContent(type="text", text=f"Error: {exc}")]
    except ToolError as exc:
        tag = f" [{exc.code}]" if exc.code else ""
        text = f"Error{tag}: {exc}"
        # Append a compact, machine-readable recovery hint on a NEW line when the
        # code has one — the human error line above stays byte-identical.
        hint = format_error_hint(exc.code)
        if hint:
            text = f"{text}\n{hint}"
        # Append structured failure detail (e.g. select_option's available
        # options) as a compact JSON line so the agent can branch on it without
        # parsing the prose. Skip an oversized blob rather than emit a truncated
        # (unparseable) one — the human message still carries the gist.
        detail = getattr(exc, "detail", None)
        if detail is not None:
            dumped = json.dumps(detail, ensure_ascii=False, separators=(",", ":"))
            if len(dumped) <= MAX_DETAIL_JSON:
                text = f"{text}\ndetail: {dumped}"
        return [TextContent(type="text", text=text)]
    image = _as_image_content(name, data)
    if image is not None:
        return image
    return [TextContent(type="text", text=_format_result(data))]


def _as_image_content(name: str, data: Any) -> list[TextContent | ImageContent] | None:
    """Screenshot results become a native MCP image block (the client renders
    it inline) instead of a wall of base64 text the model can't see. Anything
    that doesn't look like the extension's screenshot shape falls back to the
    text path — never crash a result we already paid a round-trip for."""
    if name != "screenshot" or not isinstance(data, dict):
        return None
    blob = data.get("data")
    fmt = data.get("format")
    if not isinstance(blob, str) or not blob or fmt not in ("png", "jpeg"):
        return None
    approx_bytes = len(blob) * 3 // 4
    return [
        ImageContent(type="image", data=blob, mimeType=f"image/{fmt}"),
        TextContent(type="text", text=f"screenshot: {fmt}, ~{approx_bytes} bytes"),
    ]


def build_server(bridge: Bridge, client_id: str | None = None) -> Server:
    """Build the MCP server. In broker mode `client_id` is the per-connection
    identity threaded into every tool call (tab ownership / audit scope); the
    stdio/standalone path leaves it None, unchanged."""
    server: Server = Server("sallyport")

    @server.list_tools()  # type: ignore[no-untyped-call]
    async def _list_tools() -> list[Tool]:
        return TOOLS

    @server.call_tool()
    async def _call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent | ImageContent]:
        return await _dispatch_call(bridge, name, arguments, client_id)

    return server


def _format_result(data: Any) -> str:
    if data is None:
        return "ok"
    if isinstance(data, str):
        return data
    try:
        return json.dumps(data, ensure_ascii=False, indent=2)
    except (TypeError, ValueError):
        return repr(data)


async def run_stdio(bridge: Bridge) -> None:
    server = build_server(bridge)
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())
