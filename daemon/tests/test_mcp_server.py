"""Tests for the MCP server glue. Heavy MCP-framing paths are exercised
through the daemon as a whole; these unit tests pin the pure helpers."""

from __future__ import annotations

from typing import Any

import pytest

from sallyport_daemon.bridge import ExtensionNotConnected, ToolError
from sallyport_daemon.mcp_server import TOOLS, _dispatch_call, _format_result, build_server


def test_format_result_none() -> None:
    assert _format_result(None) == "ok"


def test_format_result_string_passthrough() -> None:
    assert _format_result("hello") == "hello"


def test_format_result_dict_is_pretty_json() -> None:
    out = _format_result({"a": 1, "b": [2, 3]})
    # Pretty-printed JSON with 2-space indent.
    assert '"a": 1' in out
    assert "\n" in out  # multi-line


def test_format_result_unicode_passthrough() -> None:
    out = _format_result({"k": "тест"})
    assert "тест" in out


def test_format_result_falls_back_to_repr_for_unserialisable() -> None:
    class NotJsonable:
        def __repr__(self) -> str:
            return "<NotJsonable instance>"

    out = _format_result(NotJsonable())
    assert "NotJsonable" in out


def test_tools_catalogue_covers_extension() -> None:
    """The daemon's tool catalogue must list every tool the extension knows.
    If a tool is added on one side without the other, MCP either advertises
    a tool that fails at the wire or misses one the extension can run."""
    daemon_names = {t.name for t in TOOLS}
    expected = {
        "list_tabs",
        "navigate",
        "reload",
        "close_tab",
        "snapshot",
        "read_text",
        "click",
        "mouse_click",
        "fill",
        "select_option",
        "key_type",
        "send_keys",
        "screenshot",
        "wait_for",
        "settle",
        "find",
        "reveal",
        "evaluate",
        "fetch_in_page",
        "upload",
        "save_to_file",
        "status",
    }
    assert daemon_names == expected


def test_no_local_tool_shadowing() -> None:
    """Ensure that local tools do not shadow any extension tools.

    Local tools run entirely in the daemon process and skip sending commands to the extension.
    If a tool exists in both LOCAL_TOOLS and the extension's tools, the local tool will
    silently shadow the extension tool. We assert that the set of LOCAL_TOOLS is completely
    disjoint from the set of extension tools.
    """
    import re
    from pathlib import Path

    from sallyport_daemon.local_tools import LOCAL_TOOLS

    tools_ts_path = Path(__file__).resolve().parents[2] / "extension" / "src" / "tools.ts"
    assert tools_ts_path.exists(), f"Could not find extension tools.ts at {tools_ts_path}"

    content = tools_ts_path.read_text(encoding="utf-8")
    # Extract the keys inside 'const tools: Record<string, Tool> = { ... }'
    match = re.search(r"const\s+tools:\s+Record<string,\s*Tool>\s*=\s*\{([^}]+)\};", content)
    assert match, "Could not find 'tools' Record definition in extension's tools.ts"

    tools_block = match.group(1)
    # Extract keys: they are either 'key: value' or just 'key' (if shorthand).
    # We match word characters at the start of a line or after commas/whitespace,
    # followed optionally by a colon.
    extension_tool_names = set()
    for line in tools_block.splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        key_match = re.match(r"^([a-zA-Z0-9_]+)", line)
        if key_match:
            extension_tool_names.add(key_match.group(1))

    # Assert that no local tool name is in the extension tools
    shadowed = set(LOCAL_TOOLS.keys()) & extension_tool_names
    assert not shadowed, f"Local tools shadow extension tools: {shadowed}"

    # Daemon built-ins (answered before any routing — see Bridge.call_tool)
    # would shadow extension tools even harder than LOCAL_TOOLS.
    from sallyport_daemon.bridge import BUILTIN_TOOLS

    shadowed_builtin = set(BUILTIN_TOOLS) & extension_tool_names
    assert not shadowed_builtin, f"Builtin tools shadow extension tools: {shadowed_builtin}"


async def test_status_answers_without_extension() -> None:
    """`status` is the loop-preflight tool: it must answer instantly with
    connected=false when no extension is attached, instead of raising
    ExtensionNotConnected like extension-bound tools do."""
    from sallyport_daemon.bridge import Bridge

    bridge = Bridge(secret=bytes(32), host="127.0.0.1", port=10086)
    out = await bridge.call_tool("status", {})
    assert out["connected"] is False
    assert out["port"] == 10086
    assert out["pendingCalls"] == 0
    assert isinstance(out["version"], str)
    assert out["uptimeS"] >= 0


async def test_status_does_not_queue_behind_call_lock() -> None:
    """status must answer while another tool call holds the call lock —
    that's the whole point of answering before lock acquisition."""
    import asyncio

    from sallyport_daemon.bridge import Bridge

    bridge = Bridge(secret=bytes(32), host="127.0.0.1", port=10086)
    async with bridge._call_lock:  # noqa: SLF001 - simulating a slow in-flight call
        out = await asyncio.wait_for(bridge.call_tool("status", {}), timeout=1.0)
    assert out["connected"] is False


def test_status_connected_reflects_ws_state() -> None:
    """`connected` must mirror the WebSocket's real protocol state, not just a
    non-None client reference: a CLOSING/CLOSED socket lingering in the slot
    must report connected:false so `status` doesn't lie just before a tool call
    fails with ExtensionNotConnected."""
    from sallyport_daemon.bridge import Bridge

    bridge = Bridge(secret=bytes(32), host="127.0.0.1", port=10086)

    class _FakeWS:
        def __init__(self, state_name: str | None) -> None:
            if state_name is not None:
                self.state = type("S", (), {"name": state_name})()

    bridge._client = _FakeWS("OPEN")  # type: ignore[assignment]  # noqa: SLF001
    assert bridge.connected is True
    assert bridge._status()["connected"] is True  # noqa: SLF001
    bridge._client = _FakeWS("CLOSING")  # type: ignore[assignment]  # noqa: SLF001
    assert bridge.connected is False
    bridge._client = _FakeWS("CLOSED")  # type: ignore[assignment]  # noqa: SLF001
    assert bridge.connected is False
    assert bridge._status()["connected"] is False  # noqa: SLF001
    # No introspectable state → trust the reference (don't regress to false).
    bridge._client = _FakeWS(None)  # type: ignore[assignment]  # noqa: SLF001
    assert bridge.connected is True


def test_tool_schemas_are_well_formed() -> None:
    """Every Tool has a non-empty description and a valid object inputSchema."""
    for tool in TOOLS:
        assert tool.description, f"{tool.name} missing description"
        schema = tool.inputSchema
        assert schema.get("type") == "object", tool.name
        # additionalProperties: False so the agent can't sneak unknown args past us.
        assert schema.get("additionalProperties") is False, tool.name


def test_close_tab_requires_tab_id() -> None:
    """close_tab has no fallback in the extension — passing no tabId throws
    bad_args at the wire. The schema must mirror that so MCP rejects the call
    before it ever reaches the extension."""
    close_tab = next(t for t in TOOLS if t.name == "close_tab")
    assert close_tab.inputSchema.get("required") == ["tabId"]


def test_no_tool_description_claims_last_used_fallback() -> None:
    """resolveTab() in extension/src/tools/tabs.ts is stateless: explicit tabId,
    or the active tab in the current window. Any description that promises a
    'last-used' or 'last touched' tab is lying to the agent."""
    for tool in TOOLS:
        desc = (tool.description or "").lower()
        for needle in ("last-used", "last used", "last-touched", "last touched"):
            assert needle not in desc, f"{tool.name}: stale wording {needle!r}"


# ---------------------------------------------------------------------------
# _dispatch_call: error / format branches
# ---------------------------------------------------------------------------


class _FakeBridge:
    """Stub `Bridge` exposing only `call_tool`. The dispatcher doesn't touch
    anything else, so we don't simulate the rest."""

    def __init__(
        self,
        *,
        result: Any = None,
        raises: BaseException | None = None,
    ) -> None:
        self._result = result
        self._raises = raises
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def call_tool(self, name: str, args: dict[str, Any]) -> Any:
        self.calls.append((name, args))
        if self._raises is not None:
            raise self._raises
        return self._result


@pytest.mark.asyncio
async def test_dispatch_call_happy_path_formats_result() -> None:
    bridge: Any = _FakeBridge(result={"hello": "world"})
    out = await _dispatch_call(bridge, "snapshot", {"tabId": 7})
    assert len(out) == 1
    assert out[0].type == "text"
    assert '"hello": "world"' in out[0].text
    assert bridge.calls == [("snapshot", {"tabId": 7})]


@pytest.mark.asyncio
async def test_dispatch_call_normalises_none_arguments_to_empty_dict() -> None:
    """MCP can hand us `arguments=None` for parameterless tools; the bridge
    contract is `dict`. The dispatcher must not propagate the None."""
    bridge: Any = _FakeBridge(result=None)
    await _dispatch_call(bridge, "list_tabs", None)
    assert bridge.calls == [("list_tabs", {})]


@pytest.mark.asyncio
async def test_dispatch_call_extension_not_connected_returns_error_text() -> None:
    bridge: Any = _FakeBridge(raises=ExtensionNotConnected("extension is not connected"))
    out = await _dispatch_call(bridge, "snapshot", {})
    assert len(out) == 1
    assert out[0].text == "Error: extension is not connected"


@pytest.mark.asyncio
async def test_dispatch_call_tool_error_with_code_tags_the_code() -> None:
    bridge: Any = _FakeBridge(
        raises=ToolError("foo.example not allowed", code="domain_not_allowed")
    )
    out = await _dispatch_call(bridge, "navigate", {"url": "https://foo.example"})
    assert out[0].text == "Error [domain_not_allowed]: foo.example not allowed"


@pytest.mark.asyncio
async def test_dispatch_call_tool_error_without_code_omits_brackets() -> None:
    bridge: Any = _FakeBridge(raises=ToolError("something went wrong"))
    out = await _dispatch_call(bridge, "click", {"selector": "@e1"})
    assert out[0].text == "Error: something went wrong"


@pytest.mark.asyncio
async def test_dispatch_call_screenshot_returns_native_image_block() -> None:
    """A screenshot result becomes ImageContent (the client renders it inline)
    plus a short text line with format/size — never a wall of base64 text."""
    bridge: Any = _FakeBridge(result={"format": "png", "data": "aGVsbG8=", "dataLength": 8})
    out = await _dispatch_call(bridge, "screenshot", {})
    assert len(out) == 2
    assert out[0].type == "image"
    assert out[0].data == "aGVsbG8="
    assert out[0].mimeType == "image/png"
    assert out[1].type == "text"
    assert "png" in out[1].text


@pytest.mark.asyncio
async def test_dispatch_call_screenshot_jpeg_mime_type() -> None:
    bridge: Any = _FakeBridge(result={"format": "jpeg", "data": "aGk=", "dataLength": 4})
    out = await _dispatch_call(bridge, "screenshot", {"format": "jpeg"})
    assert out[0].type == "image"
    assert out[0].mimeType == "image/jpeg"


@pytest.mark.asyncio
async def test_dispatch_call_screenshot_malformed_falls_back_to_text() -> None:
    """A screenshot result that doesn't carry {format, data:str} must not
    crash the dispatcher — it degrades to the ordinary text formatting."""
    for weird in ("not a dict", {"format": "png"}, {"format": "bmp", "data": "x"}, {"data": 5}):
        bridge: Any = _FakeBridge(result=weird)
        out = await _dispatch_call(bridge, "screenshot", {})
        assert len(out) == 1
        assert out[0].type == "text"


@pytest.mark.asyncio
async def test_dispatch_call_non_screenshot_dict_with_data_stays_text() -> None:
    """Only `screenshot` gets the image treatment — another tool returning a
    {format, data} shaped dict (e.g. fetch_in_page base64 mode) must remain
    text so its metadata isn't silently swallowed."""
    bridge: Any = _FakeBridge(result={"format": "png", "data": "aGk=", "status": 200})
    out = await _dispatch_call(bridge, "fetch_in_page", {"url": "https://x.example/i.png"})
    assert len(out) == 1
    assert out[0].type == "text"


def test_wait_for_timeout_is_capped_in_schema() -> None:
    """wait_for runs inside the daemon's 60 s request timeout; the schema must
    advertise a cap (extension clamps at 30 s) so an agent can't request a
    wait that would surface as an opaque wire timeout."""
    wait_for = next(t for t in TOOLS if t.name == "wait_for")
    timeout = wait_for.inputSchema["properties"]["timeoutMs"]
    assert timeout["maximum"] == 30000


def test_build_server_wires_a_named_server() -> None:
    """Smoke test: instantiating with a stub bridge runs the decorator
    registration. Catches type-signature regressions in the mcp SDK glue."""
    server = build_server(_FakeBridge())  # type: ignore[arg-type]
    assert server.name == "sallyport"
