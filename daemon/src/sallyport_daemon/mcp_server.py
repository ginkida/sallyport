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
from mcp.types import TextContent, Tool

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
            "of CSS selectors. Domain must be in allowlist."
        ),
        inputSchema={
            "type": "object",
            "properties": {"tabId": {"type": "integer"}},
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
            "center. Use this when the regular `click` (DOM .click()) doesn't "
            "trip pointer-event listeners — common on canvas-heavy UIs, "
            "drag-and-drop libraries (react-dnd), and games. button is "
            "'left' (default), 'middle', or 'right'. clickCount is 1..3 "
            "(double/triple click). Allowlist-gated. Refuses zero-size "
            "elements with `not_visible`."
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
            "unless allowPassword=true."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "selector": {"type": "string"},
                "value": {"type": "string"},
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
            "Take a screenshot of the viewport. format is 'png' (default) or 'jpeg'. "
            "Returns base64 data; large — prefer snapshot/read_text for understanding."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "format": {"type": "string", "enum": ["png", "jpeg"], "default": "png"},
                "quality": {"type": "integer", "minimum": 1, "maximum": 100},
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
) -> list[TextContent]:
    """Run a tool through the bridge and wrap the outcome as MCP TextContent.

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
    return [TextContent(type="text", text=_format_result(data))]


def build_server(bridge: Bridge) -> Server:
    server: Server = Server("sallyport")

    @server.list_tools()  # type: ignore[no-untyped-call]
    async def _list_tools() -> list[Tool]:
        return TOOLS

    @server.call_tool()
    async def _call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
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
