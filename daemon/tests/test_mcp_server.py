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
        "history_go",
        "close_tab",
        "snapshot",
        "read_text",
        "get_state",
        "console_tail",
        "network_tail",
        "handle_dialog",
        "click",
        "mouse_click",
        "hover",
        "fill",
        "select_option",
        "key_type",
        "send_keys",
        "screenshot",
        "set_viewport",
        "print_to_pdf",
        "wait_for",
        "settle",
        "find",
        "reveal",
        "scroll",
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
    # Introspection fields: run mode + why the extension leg last failed (none
    # yet on a fresh standalone daemon).
    assert out["mode"] == "standalone"
    assert out["lastHandshakeError"] is None
    assert out["lastHandshakeErrorAt"] is None


async def test_status_reports_broker_mode() -> None:
    """status.mode tells an agent whether it's in broker mode — so the tabId
    requirement and create-own navigate aren't surprises. It's a broker-global
    property, identical for every caller (never a per-client oracle)."""
    from sallyport_daemon.bridge import Bridge

    standalone = Bridge(secret=bytes(32), host="127.0.0.1", port=10086)
    assert standalone._status()["mode"] == "standalone"  # noqa: SLF001
    broker = Bridge(secret=bytes(32), host="127.0.0.1", port=10086, broker_mode=True)
    assert broker._status()["mode"] == "broker"  # noqa: SLF001
    assert broker._status(client_id="c1")["mode"] == "broker"  # noqa: SLF001


async def test_status_answers_while_the_caller_s_lane_is_busy() -> None:
    """status must answer while another tool call holds this caller's lane —
    that's the whole point of answering before admission control."""
    import asyncio

    from sallyport_daemon.bridge import Bridge

    bridge = Bridge(secret=bytes(32), host="127.0.0.1", port=10086)
    async with bridge._lanes.lane(None):  # noqa: SLF001 - simulate a slow in-flight call
        out = await asyncio.wait_for(bridge.call_tool("status", {}), timeout=1.0)
    assert out["connected"] is False


async def test_status_answers_while_every_browser_permit_is_taken() -> None:
    """The global cap must never become a cross-client DoS on the one tool
    designed to always answer: `status` takes no permit at all."""
    import asyncio

    from sallyport_daemon.bridge import Bridge

    bridge = Bridge(secret=bytes(32), host="127.0.0.1", port=10086, max_concurrent_calls=2)
    for _ in range(2):
        await bridge._permits.acquire()  # noqa: SLF001 - saturate the pool
    out = await asyncio.wait_for(bridge.call_tool("status", {}, client_id="B"), timeout=1.0)
    assert out["connected"] is False
    assert out["maxConcurrentCalls"] == 2


async def test_status_carries_empty_call_ring_initially() -> None:
    """A fresh daemon reports an empty ring and no last error — and `status`
    itself is never recorded (it's the introspection, not a tracked call)."""
    from sallyport_daemon.bridge import Bridge

    bridge = Bridge(secret=bytes(32), host="127.0.0.1", port=10086)
    await bridge.call_tool("status", {})
    out = bridge._status()  # noqa: SLF001
    assert out["lastCalls"] == []
    assert out["lastError"] is None


async def test_call_ring_records_failure_without_args() -> None:
    """A failing tool call lands in the ring + lastError as an OUTCOME, and the
    args (which may carry credentials) never appear anywhere in the snapshot."""
    from sallyport_daemon.bridge import Bridge, ExtensionNotConnected

    bridge = Bridge(secret=bytes(32), host="127.0.0.1", port=10086)
    with pytest.raises(ExtensionNotConnected):
        await bridge.call_tool("fill", {"selector": "#pw", "value": "hunter2-topsecret"})
    out = bridge._status()  # noqa: SLF001
    assert len(out["lastCalls"]) == 1
    entry = out["lastCalls"][0]
    assert entry["tool"] == "fill"
    assert entry["ok"] is False
    assert isinstance(entry["ms"], int)
    assert out["lastError"]["tool"] == "fill"
    # The credential in args must not leak into the diagnostic anywhere.
    assert "hunter2-topsecret" not in repr(out["lastCalls"])
    assert "hunter2-topsecret" not in repr(out["lastError"])


def test_record_call_ring_caps_and_evicts_oldest() -> None:
    from sallyport_daemon.bridge import LAST_CALLS_MAXLEN, Bridge

    bridge = Bridge(secret=bytes(32), host="127.0.0.1", port=10086)
    for i in range(LAST_CALLS_MAXLEN + 5):
        bridge._record_call(f"t{i}", ok=True, ms=i, code=None, error=None)  # noqa: SLF001
    calls = bridge._status()["lastCalls"]  # noqa: SLF001
    assert len(calls) == LAST_CALLS_MAXLEN
    assert calls[0]["tool"] == "t5"  # oldest five evicted
    assert calls[-1]["tool"] == f"t{LAST_CALLS_MAXLEN + 4}"
    assert all(isinstance(c["ms"], int) for c in calls)
    assert all("args" not in c for c in calls)


def test_record_call_failure_caps_error_and_tags_code() -> None:
    from sallyport_daemon.bridge import MAX_CALL_ERROR, Bridge

    bridge = Bridge(secret=bytes(32), host="127.0.0.1", port=10086)
    bridge._record_call("fill", ok=False, ms=3, code="password_field", error="x" * 500)  # noqa: SLF001
    out = bridge._status()  # noqa: SLF001
    err = out["lastError"]
    assert err["code"] == "password_field"
    assert len(err["error"]) <= MAX_CALL_ERROR
    entry = out["lastCalls"][-1]
    assert entry["code"] == "password_field"
    # The compact ring entry omits the (potentially long) error string.
    assert "error" not in entry


async def test_successful_local_tool_records_ok_outcome(tmp_path: Any) -> None:
    """A successful call records ok=True with an integer ms — and still no
    args. save_to_file is the no-extension success path."""
    import os

    from sallyport_daemon.bridge import Bridge

    os.environ["SALLYPORT_DOWNLOAD_DIR"] = str(tmp_path)
    try:
        bridge = Bridge(secret=bytes(32), host="127.0.0.1", port=10086)
        await bridge.call_tool("save_to_file", {"data": "aGk=", "filename": "note.txt"})
        calls = bridge._status()["lastCalls"]  # noqa: SLF001
        assert calls[-1] == {"tool": "save_to_file", "ok": True, "ms": calls[-1]["ms"]}
        assert isinstance(calls[-1]["ms"], int)
        assert bridge._status()["lastError"] is None  # noqa: SLF001
    finally:
        del os.environ["SALLYPORT_DOWNLOAD_DIR"]


async def test_call_ring_is_per_client_not_a_shared_ring(tmp_path: Any) -> None:
    """Each client gets its OWN outcome ring: a chatty session can never evict a
    quiet session's diagnostics, and no entry carries another client's identity
    (invariants #13/#14 — nothing to filter, because nothing is shared)."""
    import os

    from sallyport_daemon.bridge import LAST_CALLS_MAXLEN, Bridge

    os.environ["SALLYPORT_DOWNLOAD_DIR"] = str(tmp_path)
    try:
        bridge = Bridge(secret=bytes(32), host="127.0.0.1", port=10086)
        await bridge.call_tool("save_to_file", {"data": "aGk=", "filename": "a.txt"}, "A")
        # B floods well past the ring size; A's single entry must survive.
        for i in range(LAST_CALLS_MAXLEN + 5):
            await bridge.call_tool("save_to_file", {"data": "aGk=", "filename": f"b{i}.txt"}, "B")

        a_calls = bridge._status(client_id="A")["lastCalls"]  # noqa: SLF001
        b_calls = bridge._status(client_id="B")["lastCalls"]  # noqa: SLF001
        assert len(a_calls) == 1
        assert len(b_calls) == LAST_CALLS_MAXLEN
        # No client identity is echoed in either view.
        assert all("client" not in entry for entry in a_calls + b_calls)
        # A third client (and standalone) see nothing at all.
        assert bridge._status(client_id="C")["lastCalls"] == []  # noqa: SLF001
        assert bridge._status()["lastCalls"] == []  # noqa: SLF001
    finally:
        del os.environ["SALLYPORT_DOWNLOAD_DIR"]


async def test_last_error_is_per_client(tmp_path: Any) -> None:
    """One client's failure must not surface as another client's lastError."""
    from sallyport_daemon.bridge import Bridge, ToolError

    bridge = Bridge(secret=bytes(32), host="127.0.0.1", port=10086)
    with pytest.raises(ToolError):
        await bridge.call_tool("snapshot", {"tabId": 1}, "A")
    a_error = bridge._status(client_id="A")["lastError"]  # noqa: SLF001
    assert a_error["tool"] == "snapshot"
    assert a_error["code"] == "tab_not_owned"
    assert bridge._status(client_id="B")["lastError"] is None  # noqa: SLF001


async def test_release_client_drops_lane_ring_and_returns_owned_tabs(tmp_path: Any) -> None:
    """A disconnected client leaves nothing behind in the broker: no lane, no
    ring, no ownership rows — and the caller learns which tabs to stop driving."""
    import time as _time

    from sallyport_daemon.bridge import Bridge, ExtensionNotConnected

    bridge = Bridge(secret=bytes(32), host="127.0.0.1", port=10086, broker_mode=True)
    bridge._ownership.record_create("A", 11, "e1", opened_at=_time.time())  # noqa: SLF001
    bridge._ownership.record_create("A", 12, "e2", opened_at=_time.time())  # noqa: SLF001
    with pytest.raises(ExtensionNotConnected):
        await bridge.call_tool("snapshot", {"tabId": 11}, "A")
    assert len(bridge._lanes) == 1  # noqa: SLF001

    # Returns {tabId: epoch}: the epoch is what lets the extension tell "the tab
    # this client created" from "some tab that now has the same id".
    assert bridge.release_client("A") == {11: "e1", 12: "e2"}
    assert len(bridge._lanes) == 0  # noqa: SLF001
    assert bridge._status(client_id="A")["lastCalls"] == []  # noqa: SLF001
    assert bridge._status(client_id="A")["lastError"] is None  # noqa: SLF001
    # Standalone has no per-client anything and is a no-op.
    assert bridge.release_client(None) == {}


def test_status_pending_calls_owner_scoped_in_broker_mode() -> None:
    """status.pendingCalls must not leak another client's in-flight call. Now
    that lanes let several calls be in flight at once, an unscoped count would
    be a live read on how busy the other sessions are — each client sees only
    its own (invariants #13/#14)."""
    from sallyport_daemon.bridge import Bridge

    bridge = Bridge(secret=bytes(32), host="127.0.0.1", port=10086)
    # Clients "A" and "B" each have a call in flight (as if mid-round-trip),
    # plus one standalone-tagged call.
    bridge._pending_clients.update({"r1": "A", "r2": "B", "r3": "B", "r4": None})  # noqa: SLF001

    assert bridge._status(client_id="A")["pendingCalls"] == 1  # noqa: SLF001
    assert bridge._status(client_id="B")["pendingCalls"] == 2  # noqa: SLF001
    assert bridge._status(client_id="C")["pendingCalls"] == 0  # noqa: SLF001
    # Standalone is just another key: it sees its own, not the whole process.
    assert bridge._status()["pendingCalls"] == 1  # noqa: SLF001


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
        self.client_ids: list[str | None] = []
        self.client_labels: list[str | None] = []

    async def call_tool(
        self,
        name: str,
        args: dict[str, Any],
        client_id: str | None = None,
        client_label: str | None = None,
    ) -> Any:
        self.calls.append((name, args))
        self.client_ids.append(client_id)
        self.client_labels.append(client_label)
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
async def test_dispatch_call_threads_client_id() -> None:
    """In broker mode the dispatcher forwards the per-connection client_id to
    the bridge; single-client/standalone passes None (the default)."""
    bridge: Any = _FakeBridge(result=None)
    await _dispatch_call(bridge, "snapshot", {"tabId": 1}, "client-abc")
    await _dispatch_call(bridge, "snapshot", {"tabId": 1})
    assert bridge.client_ids == ["client-abc", None]


@pytest.mark.asyncio
async def test_dispatch_call_threads_client_label() -> None:
    """The cosmetic session label rides alongside the id (it is what the
    extension writes into the audit log); absent by default."""
    bridge: Any = _FakeBridge(result=None)
    await _dispatch_call(bridge, "snapshot", {"tabId": 1}, "client-abc", "checkout")
    await _dispatch_call(bridge, "snapshot", {"tabId": 1})
    assert bridge.client_labels == ["checkout", None]


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
    # Tagged with the stable [not_connected] code and carrying a retryable hint,
    # so a looping agent can poll status instead of burning the tool timeout.
    assert out[0].text.startswith("Error [not_connected]: extension is not connected")
    assert "\nhint: retryable=yes;" in out[0].text


@pytest.mark.asyncio
async def test_dispatch_call_tool_error_with_code_tags_the_code() -> None:
    bridge: Any = _FakeBridge(
        raises=ToolError("foo.example not allowed", code="domain_not_allowed")
    )
    out = await _dispatch_call(bridge, "navigate", {"url": "https://foo.example"})
    # The human error line is byte-identical; a recovery hint is appended below.
    lines = out[0].text.split("\n")
    assert lines[0] == "Error [domain_not_allowed]: foo.example not allowed"
    assert lines[1].startswith("hint: ")


@pytest.mark.asyncio
async def test_dispatch_call_unknown_code_appends_no_hint() -> None:
    """A code with no taxonomy entry leaves the error a single line — the hint
    is strictly additive, never invented."""
    bridge: Any = _FakeBridge(raises=ToolError("weird", code="some_unmapped_code"))
    out = await _dispatch_call(bridge, "click", {"selector": "@e1"})
    assert out[0].text == "Error [some_unmapped_code]: weird"
    assert "\n" not in out[0].text


@pytest.mark.asyncio
async def test_dispatch_call_tool_error_without_code_omits_brackets() -> None:
    bridge: Any = _FakeBridge(raises=ToolError("something went wrong"))
    out = await _dispatch_call(bridge, "click", {"selector": "@e1"})
    assert out[0].text == "Error: something went wrong"


@pytest.mark.asyncio
async def test_dispatch_call_appends_structured_detail_json() -> None:
    """A ToolError carrying structured detail (select_option's available
    options) gets a compact, parseable `detail:` line under the error — the
    human line + recovery hint stay intact above it."""
    import json as _json

    bridge: Any = _FakeBridge(
        raises=ToolError(
            "no <option> matched",
            code="not_found",
            detail={"missing": ["x"], "available": [{"value": "a", "label": "A"}]},
        )
    )
    out = await _dispatch_call(bridge, "select_option", {"selector": "#s", "value": "x"})
    lines = out[0].text.split("\n")
    assert lines[0] == "Error [not_found]: no <option> matched"
    detail_lines = [ln for ln in lines if ln.startswith("detail: ")]
    assert len(detail_lines) == 1
    parsed = _json.loads(detail_lines[0][len("detail: ") :])
    assert parsed["available"][0]["value"] == "a"
    assert parsed["missing"] == ["x"]


@pytest.mark.asyncio
async def test_dispatch_call_omits_detail_line_when_absent() -> None:
    """No detail → no detail line. The feature is strictly additive."""
    bridge: Any = _FakeBridge(raises=ToolError("no <option> matched", code="not_found"))
    out = await _dispatch_call(bridge, "select_option", {"selector": "#s"})
    assert "detail:" not in out[0].text


@pytest.mark.asyncio
async def test_dispatch_call_drops_oversized_detail_rather_than_truncating() -> None:
    """An oversized detail is dropped (the prose still carries the gist), never
    truncated into unparseable JSON."""
    bridge: Any = _FakeBridge(
        raises=ToolError(
            "huge",
            code="not_found",
            detail={"available": [{"value": str(i), "label": "x" * 50} for i in range(500)]},
        )
    )
    out = await _dispatch_call(bridge, "select_option", {"selector": "#s"})
    assert "detail:" not in out[0].text


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


async def test_internal_tools_are_not_callable_by_a_client() -> None:
    """`_release_tabs` is daemon-initiated housekeeping. Absence from the MCP
    catalogue is NOT a gate — the SDK forwards an unlisted name to our handler
    unvalidated and `call_tool` routes anything that isn't a builtin or a local
    tool straight to the extension. Worse, it acts on a `tabIds` ARRAY that the
    ownership gate (which only ever inspects `args["tabId"]`) never sees, so a
    client owning one tab could name it with `tabIds:[1..N]` and deregister
    every tab in the profile, including other sessions' and the human's."""
    from sallyport_daemon.bridge import RELEASE_TABS_TOOL, Bridge, ToolError

    bridge = Bridge(secret=bytes(32), host="127.0.0.1", port=10086, broker_mode=True)
    # Own a tab, so the ownership gate would have been satisfied.
    bridge._ownership.record_create("A", 42, "e1", opened_at=0.0)  # noqa: SLF001

    with pytest.raises(ToolError) as excinfo:
        await bridge.call_tool(RELEASE_TABS_TOOL, {"tabId": 42, "tabIds": [1, 2, 3]}, "A")
    assert excinfo.value.code == "unknown_tool"
    # Standalone can't reach it either — this is a name gate, not an ownership one.
    with pytest.raises(ToolError) as excinfo:
        await bridge.call_tool(RELEASE_TABS_TOOL, {"tabIds": [1, 2, 3]})
    assert excinfo.value.code == "unknown_tool"


async def test_release_tabs_in_browser_still_reaches_the_wire() -> None:
    """The daemon's own housekeeping path bypasses `call_tool` (which now
    refuses the name), and swallows failures — a disconnect path must never
    raise into the accept loop."""
    from sallyport_daemon.bridge import RELEASE_TABS_TOOL, Bridge

    sent: list[tuple[str, dict[str, Any]]] = []

    class _SpyBridge(Bridge):
        async def _call_tool_locked(self, name, args, client_id=None):  # type: ignore[no-untyped-def]
            sent.append((name, args))
            raise RuntimeError("extension went away mid-release")

    bridge = _SpyBridge(secret=bytes(32), host="127.0.0.1", port=10086, broker_mode=True)
    await bridge.release_tabs_in_browser({11: "e1", 12: None})  # must not raise
    # Each id carries the recorded epoch so the extension can refuse to CLOSE a
    # recycled id; a tab with no epoch on record simply travels without one
    # (fail-closed extension-side: no epoch means hand back, never close).
    assert sent == [(RELEASE_TABS_TOOL, {"tabs": [{"tabId": 11, "epoch": "e1"}, {"tabId": 12}]})]
    # An empty release is a no-op, not a wasted round-trip.
    sent.clear()
    await bridge.release_tabs_in_browser({})
    assert sent == []
