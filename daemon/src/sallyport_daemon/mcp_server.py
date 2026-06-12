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

log = logging.getLogger("sallyport.mcp")


# Mirrors the tool registry in extension/src/tools.ts. Kept short and explicit
# so Claude knows the shape of every call without guessing.
TOOLS: list[Tool] = [
    Tool(
        name="list_tabs",
        description="List all open browser tabs (tabId, url, title, active, windowId).",
        inputSchema={"type": "object", "properties": {}, "additionalProperties": False},
    ),
    Tool(
        name="navigate",
        description=(
            "Open a URL. The destination domain must be in the extension's allowlist "
            "or the call fails with domain_not_allowed. Set newTab=true to open a "
            "new tab; otherwise updates the tab passed in tabId, or the active tab "
            "in the current window if tabId is omitted. Returns {tabId, url}."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "newTab": {"type": "boolean", "default": False},
                "tabId": {"type": "integer"},
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
            "elements ({ref, role, name, value?}) instead of the full tree — much "
            "smaller; use it when you need something to click, not the page text. "
            "Domain must be in allowlist."
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
            },
            "additionalProperties": False,
        },
    ),
    Tool(
        name="read_text",
        description=(
            "Read the text content of the page, or of a specific element if ref is given. "
            "No arbitrary JS — uses CDP's Runtime.callFunctionOn with a fixed function."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "ref": {"type": "string", "description": "Optional @eN ref from snapshot"},
                "tabId": {"type": "integer"},
            },
            "additionalProperties": False,
        },
    ),
    Tool(
        name="click",
        description=(
            "Click an element via DOM .click(). selector can be a CSS selector or a "
            "@eN ref from snapshot. Refs are more reliable on SPAs."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "selector": {"type": "string"},
                "tabId": {"type": "integer"},
            },
            "required": ["selector"],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="mouse_click",
        description=(
            "Click via real Input.dispatchMouseEvent at the element's geometric "
            "center, as a full pointer sequence — hover move, then press and "
            "release with human-ish delays — so pointer-event routers (React "
            "SPAs) that ignore a bare press+release accept it. Use this when "
            "the regular `click` (DOM .click()) doesn't trip pointer-event "
            "listeners — common on canvas-heavy UIs, drag-and-drop libraries "
            "(react-dnd), and games. button is 'left' (default), 'middle', or "
            "'right'. clickCount is 1..3 (double/triple click). "
            "Allowlist-gated. Refuses zero-size elements with `not_visible`. "
            "The result reports `covered: true` + `hitTarget` when a "
            "different element sits at the click point (overlay, wrapper) — "
            "the events were dispatched there, which is usually why a click "
            "'did nothing'; try clicking the hitTarget element instead."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "selector": {"type": "string"},
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
            },
            "required": ["selector"],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="fill",
        description=(
            "Type into an input/textarea/contenteditable. Refuses password fields "
            "unless allowPassword=true. method='value' (default) sets .value and "
            "dispatches input/change events; method='insertText' clears the field "
            "and types through CDP Input.insertText with real input events — use "
            "it when the app ignores programmatic values or concatenates text "
            "(SPA editors: Telegram, Slack, draft.js)."
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
            },
            "required": ["selector", "value"],
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
            "the user's tab/window focus, so only when intended). Prefer "
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
            "replacement for blind sleeps between actions. Polls every 250 ms "
            "up to timeoutMs (default 10000, capped at 30000). At least one of "
            "selector/text is required; if both are given, both must hold. "
            "Returns {found, elapsedMs}; a timeout returns found=false rather "
            "than an error. Domain must be in allowlist."
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
]


async def _dispatch_call(
    bridge: Bridge, name: str, arguments: dict[str, Any] | None
) -> list[TextContent | ImageContent]:
    """Run a tool through the bridge and wrap the outcome as MCP content.

    Extracted from `build_server` so the error/format branches can be unit-
    tested directly without standing up an MCP stdio server.
    """
    try:
        data = await bridge.call_tool(name, arguments or {})
    except ExtensionNotConnected as exc:
        return [TextContent(type="text", text=f"Error: {exc}")]
    except ToolError as exc:
        tag = f" [{exc.code}]" if exc.code else ""
        return [TextContent(type="text", text=f"Error{tag}: {exc}")]
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


def build_server(bridge: Bridge) -> Server:
    server: Server = Server("sallyport")

    @server.list_tools()  # type: ignore[no-untyped-call]
    async def _list_tools() -> list[Tool]:
        return TOOLS

    @server.call_tool()
    async def _call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent | ImageContent]:
        return await _dispatch_call(bridge, name, arguments)

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
