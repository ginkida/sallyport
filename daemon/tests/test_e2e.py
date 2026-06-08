"""End-to-end tests for the daemon's WS server.

We spin up :class:`Bridge` on an ephemeral port, connect a real websockets
client speaking the same signed protocol the extension would, and exercise:

  * hello / hello_ack handshake
  * tool_call → tool_result round trip
  * unauthenticated frame rejection (silent drop, no echo to attacker)
  * single-client invariant (second connection is rejected)
  * disconnect-mid-request raises ExtensionNotConnected to the MCP caller
  * timeout when the extension never replies
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import socket
from collections.abc import AsyncIterator
from typing import Any

import pytest
import websockets
from websockets.asyncio.client import ClientConnection

from sallyport_daemon.bridge import Bridge, ExtensionNotConnected, ToolError
from sallyport_daemon.protocol import Envelope, Signer

pytestmark = pytest.mark.asyncio

SECRET = bytes(32)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class BridgeHarness:
    """Owns a Bridge instance bound to an ephemeral port plus its serve task."""

    def __init__(self, request_timeout: float = 2.0, hello_timeout: float = 10.0) -> None:
        self.port = _free_port()
        self.bridge = Bridge(
            secret=SECRET,
            host="127.0.0.1",
            port=self.port,
            request_timeout=request_timeout,
            hello_timeout=hello_timeout,
        )
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        self._task = asyncio.create_task(self.bridge.serve_forever(), name="harness-ws")
        # Wait until the port actually accepts connections.
        for _ in range(50):
            try:
                async with websockets.connect(self.url):
                    return
            except (OSError, websockets.InvalidHandshake):
                await asyncio.sleep(0.02)
        raise RuntimeError("bridge did not come up")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/ws"


@pytest.fixture
async def harness() -> AsyncIterator[BridgeHarness]:
    h = BridgeHarness()
    await h.start()
    try:
        yield h
    finally:
        await h.stop()


class FakeExtension:
    """A WS client that signs and verifies exactly like the real extension."""

    def __init__(self, ws: ClientConnection, signer: Signer) -> None:
        self.ws = ws
        self.signer = signer

    @classmethod
    async def connect(cls, url: str) -> FakeExtension:
        ws = await websockets.connect(url)
        return cls(ws, Signer(SECRET))

    async def close(self) -> None:
        await self.ws.close()

    async def send(self, type: str, body: Any, id: str | None = None) -> None:
        env = self.signer.sign(Envelope(type=type, body=body, id=id))
        await self.ws.send(json.dumps(env, separators=(",", ":")))

    async def send_raw(self, text: str) -> None:
        await self.ws.send(text)

    async def recv(self) -> Envelope:
        raw = await self.ws.recv()
        if isinstance(raw, bytes):
            raw = raw.decode()
        return self.signer.verify(json.loads(raw))

    async def handshake(self) -> None:
        await self.send("hello", {"extensionVersion": "test"})
        ack = await self.recv()
        assert ack.type == "hello_ack"


async def test_hello_handshake(harness: BridgeHarness) -> None:
    ext = await FakeExtension.connect(harness.url)
    try:
        await ext.handshake()
    finally:
        await ext.close()


async def test_tool_call_roundtrip(harness: BridgeHarness) -> None:
    ext = await FakeExtension.connect(harness.url)
    try:
        await ext.handshake()

        # MCP side wants to call a tool. Run that in the background so we can
        # play the extension on this side.
        call_task = asyncio.create_task(
            harness.bridge.call_tool("snapshot", {"tabId": 7}),
        )

        # Daemon should send us a tool_call.
        req = await ext.recv()
        assert req.type == "tool_call"
        assert req.id is not None
        assert req.body == {"name": "snapshot", "args": {"tabId": 7}}

        await ext.send("tool_result", {"ok": True, "data": {"tree": "fake"}}, id=req.id)

        result = await call_task
        assert result == {"tree": "fake"}
    finally:
        await ext.close()


async def test_tool_call_error_propagates(harness: BridgeHarness) -> None:
    ext = await FakeExtension.connect(harness.url)
    try:
        await ext.handshake()
        call_task = asyncio.create_task(
            harness.bridge.call_tool("click", {"selector": "#x"}),
        )
        req = await ext.recv()
        await ext.send(
            "tool_result",
            {"ok": False, "error": "domain_not_allowed: foo", "code": "domain_not_allowed"},
            id=req.id,
        )
        with pytest.raises(ToolError) as exc_info:
            await call_task
        assert exc_info.value.code == "domain_not_allowed"
        assert "foo" in str(exc_info.value)
    finally:
        await ext.close()


async def test_unauthenticated_frame_is_dropped(harness: BridgeHarness) -> None:
    """Frames with bad MAC must not crash the server nor be replied to."""
    ext = await FakeExtension.connect(harness.url)
    try:
        await ext.handshake()
        # Send a bogus signed envelope (right shape, wrong mac).
        bogus = {
            "v": 1,
            "ts": 1700000000,
            "nonce": "x" * 22 + "==",
            "type": "tool_call",
            "id": "evil",
            "body": {"name": "snapshot", "args": {}},
            "mac": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0=",
        }
        await ext.send_raw(json.dumps(bogus))

        # The server should NOT send anything in response. Wait a short
        # window and prove silence.
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(ext.ws.recv(), timeout=0.3)
        # Connection is still alive — a real hello/ack still works.
        await ext.send("tool_result", {"ok": True, "data": None}, id="orphan")
        # No error from the server side.
    finally:
        await ext.close()


async def test_unauthenticated_client_does_not_claim_slot(harness: BridgeHarness) -> None:
    """The single-client slot is claimed only after a verified signed hello
    (threat-model item 1): a peer that connects and sits silent must not
    deny service to the real extension."""
    squatter = await websockets.connect(harness.url)
    try:
        # While the squatter idles unauthenticated, the real extension
        # attaches and works.
        ext = await FakeExtension.connect(harness.url)
        try:
            await ext.handshake()
        finally:
            await ext.close()
    finally:
        await squatter.close()


async def test_silent_client_is_closed_after_hello_timeout() -> None:
    h = BridgeHarness(hello_timeout=0.2)
    await h.start()
    try:
        ws = await websockets.connect(h.url)
        # Never send hello — the server must hang up, not wait forever.
        with pytest.raises(websockets.ConnectionClosed) as exc_info:
            await asyncio.wait_for(ws.recv(), timeout=2.0)
        rcvd = exc_info.value.rcvd
        assert rcvd is not None
        assert rcvd.code == 1008
    finally:
        await h.stop()


async def test_browser_page_origin_is_rejected(harness: BridgeHarness) -> None:
    """A web page can open a cross-origin WebSocket to 127.0.0.1; the daemon
    must refuse browser-page Origins before they can even attempt a hello."""
    from websockets.typing import Origin

    ws = await websockets.connect(harness.url, origin=Origin("https://evil.example"))
    with pytest.raises(websockets.ConnectionClosed) as exc_info:
        await ws.recv()
    rcvd = exc_info.value.rcvd
    assert rcvd is not None
    assert rcvd.code == 1008
    # The slot stays free for the real extension.
    ext = await FakeExtension.connect(harness.url)
    try:
        await ext.handshake()
    finally:
        await ext.close()


async def test_chrome_extension_origin_is_accepted(harness: BridgeHarness) -> None:
    from websockets.typing import Origin

    ws = await websockets.connect(
        harness.url, origin=Origin("chrome-extension://abcdefghijklmnopabcdefghijklmnop")
    )
    ext = FakeExtension(ws, Signer(SECRET))
    try:
        await ext.handshake()
    finally:
        await ext.close()


async def test_wrong_secret_hello_is_rejected(harness: BridgeHarness) -> None:
    ws = await websockets.connect(harness.url)
    bad_signer = Signer(b"\x11" * 32)
    env = bad_signer.sign(Envelope(type="hello", body={"extensionVersion": "evil"}))
    await ws.send(json.dumps(env, separators=(",", ":")))
    with pytest.raises(websockets.ConnectionClosed) as exc_info:
        await ws.recv()
    rcvd = exc_info.value.rcvd
    assert rcvd is not None
    assert rcvd.code == 1008


async def test_first_frame_must_be_hello(harness: BridgeHarness) -> None:
    """Even a correctly signed non-hello first frame must not attach."""
    ext = await FakeExtension.connect(harness.url)
    await ext.send("pong", {})
    with pytest.raises(websockets.ConnectionClosed) as exc_info:
        await ext.ws.recv()
    rcvd = exc_info.value.rcvd
    assert rcvd is not None
    assert rcvd.code == 1008


async def test_garbage_first_frame_does_not_claim_slot(harness: BridgeHarness) -> None:
    ws = await websockets.connect(harness.url)
    await ws.send("definitely not json")
    with pytest.raises(websockets.ConnectionClosed):
        await ws.recv()
    # Server survived and the slot is free.
    ext = await FakeExtension.connect(harness.url)
    try:
        await ext.handshake()
    finally:
        await ext.close()


async def test_second_client_is_rejected(harness: BridgeHarness) -> None:
    first = await FakeExtension.connect(harness.url)
    try:
        await first.handshake()

        second = await FakeExtension.connect(harness.url)
        # The server closes the second connection cleanly.
        with pytest.raises(websockets.ConnectionClosed):
            await second.handshake()
    finally:
        await first.close()


async def test_call_tool_without_client_raises(harness: BridgeHarness) -> None:
    with pytest.raises(ExtensionNotConnected):
        await harness.bridge.call_tool("snapshot", {})


async def test_disconnect_mid_request_unblocks_caller(harness: BridgeHarness) -> None:
    ext = await FakeExtension.connect(harness.url)
    await ext.handshake()
    call_task = asyncio.create_task(harness.bridge.call_tool("snapshot", {}))
    # Wait until the server has sent us the request before closing.
    await ext.recv()
    await ext.close()
    with pytest.raises(ExtensionNotConnected):
        await call_task


async def test_request_timeout_fires() -> None:
    h = BridgeHarness(request_timeout=0.2)
    await h.start()
    try:
        ext = await FakeExtension.connect(h.url)
        await ext.handshake()
        call_task = asyncio.create_task(h.bridge.call_tool("snapshot", {}))
        await ext.recv()  # drain the request — never reply
        with pytest.raises(ToolError, match="timeout"):
            await call_task
        await ext.close()
    finally:
        await h.stop()


async def test_concurrent_call_tool_is_serialised(harness: BridgeHarness) -> None:
    """Two parallel MCP-side calls must be serialised: the daemon sends the
    second tool_call only after the first one has been answered.

    This is the contract that lets the extension keep per-tab state without
    cross-call interference."""
    ext = await FakeExtension.connect(harness.url)
    try:
        await ext.handshake()

        first = asyncio.create_task(harness.bridge.call_tool("a", {}))
        second = asyncio.create_task(harness.bridge.call_tool("b", {}))

        req1 = await ext.recv()
        assert req1.body == {"name": "a", "args": {}}

        # Even though the second call is already awaiting, the daemon must
        # not have sent it yet.
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(ext.ws.recv(), timeout=0.1)
        assert not first.done()
        assert not second.done()

        # Reply to first; only then does the second tool_call appear.
        await ext.send("tool_result", {"ok": True, "data": "A"}, id=req1.id)
        await first

        req2 = await ext.recv()
        assert req2.body == {"name": "b", "args": {}}
        await ext.send("tool_result", {"ok": True, "data": "B"}, id=req2.id)
        assert await second == "B"
    finally:
        await ext.close()


async def test_after_disconnect_new_client_can_attach(harness: BridgeHarness) -> None:
    first = await FakeExtension.connect(harness.url)
    await first.handshake()
    await first.close()
    # Give the server's cleanup a moment to release the slot.
    await asyncio.sleep(0.05)
    second = await FakeExtension.connect(harness.url)
    try:
        await second.handshake()
    finally:
        await second.close()


async def test_oversize_frame_is_rejected(harness: BridgeHarness) -> None:
    """A frame above MAX_FRAME_BYTES must be rejected, the offending client
    disconnected, and the server must not crash or OOM."""
    ext = await FakeExtension.connect(harness.url)
    try:
        await ext.handshake()
        # Send a frame larger than the cap. The server drops the connection
        # with a 1009 (message too big).
        oversize = "X" * (Bridge.MAX_FRAME_BYTES + 1)
        with pytest.raises(websockets.ConnectionClosed):  # noqa: PT012 - need to drain to observe close
            await ext.send_raw(oversize)
            while True:
                await ext.ws.recv()
    finally:
        await ext.close()
    # A new client can still attach: the server survived the abuse.
    await asyncio.sleep(0.05)
    survivor = await FakeExtension.connect(harness.url)
    try:
        await survivor.handshake()
    finally:
        await survivor.close()


async def test_shutdown_event_stops_serve_forever() -> None:
    """Setting the shutdown event must let serve_forever return so the
    process can exit cleanly when MCP closes stdin."""
    h = BridgeHarness()
    shutdown = asyncio.Event()
    # Replace the started task with one that takes the shutdown event.
    await h.stop()
    h._task = asyncio.create_task(h.bridge.serve_forever(shutdown=shutdown))
    # Wait for the server to actually bind.
    for _ in range(50):
        try:
            async with websockets.connect(h.url):
                break
        except (OSError, websockets.InvalidHandshake):
            await asyncio.sleep(0.02)
    try:
        shutdown.set()
        await asyncio.wait_for(h._task, timeout=2.0)
    finally:
        if not h._task.done():
            h._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await h._task


async def test_shutdown_closes_attached_client_with_1001() -> None:
    """When shutdown fires, the connected client gets a clean 1001 close
    instead of a TCP reset."""
    h = BridgeHarness()
    shutdown = asyncio.Event()
    await h.stop()
    h._task = asyncio.create_task(h.bridge.serve_forever(shutdown=shutdown))
    for _ in range(50):
        try:
            async with websockets.connect(h.url):
                break
        except (OSError, websockets.InvalidHandshake):
            await asyncio.sleep(0.02)
    ext = await FakeExtension.connect(h.url)
    try:
        await ext.handshake()
        shutdown.set()
        with pytest.raises(websockets.ConnectionClosed) as exc_info:  # noqa: PT012 - drain
            while True:
                await ext.ws.recv()
        rcvd = exc_info.value.rcvd
        assert rcvd is not None
        assert rcvd.code == 1001
    finally:
        await ext.close()
        if not h._task.done():
            h._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await h._task


async def test_binary_frame_is_silently_dropped(harness: BridgeHarness) -> None:
    """The protocol is JSON text only. A binary frame must not crash the read
    loop nor be replied to — the agent (or a buggy client) shouldn't be able
    to take the bridge down by sending bytes."""
    ext = await FakeExtension.connect(harness.url)
    try:
        await ext.handshake()
        await ext.ws.send(b"\x00\x01\x02not-json-at-all")
        # No response, connection still healthy.
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(ext.ws.recv(), timeout=0.3)
        # A real tool_call still round-trips through.
        call_task = asyncio.create_task(harness.bridge.call_tool("list_tabs", {}))
        req = await ext.recv()
        await ext.send("tool_result", {"ok": True, "data": {"tabs": []}}, id=req.id)
        assert await call_task == {"tabs": []}
    finally:
        await ext.close()


async def test_malformed_json_frame_after_attach_is_skipped(harness: BridgeHarness) -> None:
    """Regression: a non-JSON text frame used to escape the ProtocolError
    catch (json.JSONDecodeError is a ValueError) and tear down the connection
    with a traceback. It must be skipped like any other bad frame."""
    ext = await FakeExtension.connect(harness.url)
    try:
        await ext.handshake()
        await ext.send_raw("{not valid json")
        # No response, no disconnect.
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(ext.ws.recv(), timeout=0.3)
        # A real tool_call still round-trips through.
        call_task = asyncio.create_task(harness.bridge.call_tool("list_tabs", {}))
        req = await ext.recv()
        await ext.send("tool_result", {"ok": True, "data": {"tabs": []}}, id=req.id)
        assert await call_task == {"tabs": []}
    finally:
        await ext.close()


async def test_non_object_json_frame_is_skipped(harness: BridgeHarness) -> None:
    """Valid JSON that is not an envelope object (array, string, number)
    must be skipped, not crash the read loop."""
    ext = await FakeExtension.connect(harness.url)
    try:
        await ext.handshake()
        for frame in ("[1,2,3]", '"just a string"', "42"):
            await ext.send_raw(frame)
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(ext.ws.recv(), timeout=0.3)
        call_task = asyncio.create_task(harness.bridge.call_tool("list_tabs", {}))
        req = await ext.recv()
        await ext.send("tool_result", {"ok": True, "data": {"tabs": []}}, id=req.id)
        assert await call_task == {"tabs": []}
    finally:
        await ext.close()


async def test_deeply_nested_frame_is_skipped(harness: BridgeHarness) -> None:
    """Regression: json.loads raises RecursionError (NOT a ValueError) on
    deeply-nested JSON, so a ~4 KB frame of nested arrays used to escape the
    ProtocolError catch and tear down the connection."""
    ext = await FakeExtension.connect(harness.url)
    try:
        await ext.handshake()
        await ext.send_raw("[" * 3000 + "]" * 3000)
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(ext.ws.recv(), timeout=0.3)
        # Connection survived — a real call still round-trips.
        call_task = asyncio.create_task(harness.bridge.call_tool("list_tabs", {}))
        req = await ext.recv()
        await ext.send("tool_result", {"ok": True, "data": {"tabs": []}}, id=req.id)
        assert await call_task == {"tabs": []}
    finally:
        await ext.close()


async def test_deeply_nested_first_frame_is_rejected_cleanly(harness: BridgeHarness) -> None:
    ws = await websockets.connect(harness.url)
    await ws.send("[" * 3000 + "]" * 3000)
    with pytest.raises(websockets.ConnectionClosed):
        await ws.recv()
    # Slot is free; server survived.
    ext = await FakeExtension.connect(harness.url)
    try:
        await ext.handshake()
    finally:
        await ext.close()


async def test_frame_without_body_is_skipped(harness: BridgeHarness) -> None:
    """A frame with valid ts/nonce/type/mac fields but no `body` key used to
    raise KeyError inside Signer.verify and tear down the connection."""
    import time as _time

    ext = await FakeExtension.connect(harness.url)
    try:
        await ext.handshake()
        bodyless = {
            "v": 1,
            "ts": int(_time.time()),
            "nonce": "bodyless-nonce",
            "type": "tool_result",
            "id": "x",
            "mac": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0=",
        }
        await ext.send_raw(json.dumps(bodyless))
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(ext.ws.recv(), timeout=0.3)
        call_task = asyncio.create_task(harness.bridge.call_tool("list_tabs", {}))
        req = await ext.recv()
        await ext.send("tool_result", {"ok": True, "data": {"tabs": []}}, id=req.id)
        assert await call_task == {"tabs": []}
    finally:
        await ext.close()


async def test_non_dict_result_body_becomes_tool_error(harness: BridgeHarness) -> None:
    """A verified tool_result whose body is a truthy non-dict (e.g. a bare
    string) must surface as a clean ToolError, not an AttributeError on
    result.get(...) that reaches the MCP caller as an opaque crash."""
    ext = await FakeExtension.connect(harness.url)
    try:
        await ext.handshake()
        call_task = asyncio.create_task(harness.bridge.call_tool("snapshot", {}))
        req = await ext.recv()
        # Body is a bare string, not the expected {ok, data|error} object.
        await ext.send("tool_result", "i am not a dict", id=req.id)
        with pytest.raises(ToolError, match="non-object tool_result body") as exc_info:
            await call_task
        assert exc_info.value.code == "bad_args"
        # Connection survives for the next call.
        call2 = asyncio.create_task(harness.bridge.call_tool("list_tabs", {}))
        req2 = await ext.recv()
        await ext.send("tool_result", {"ok": True, "data": {"tabs": []}}, id=req2.id)
        assert await call2 == {"tabs": []}
    finally:
        await ext.close()


async def test_unhashable_id_with_pending_call_is_skipped(harness: BridgeHarness) -> None:
    """Regression: a valid-MAC tool_result whose `id` is a dict/list passed
    verify and reached `self._pending.pop(env.id, None)`, which raises
    TypeError on a NON-EMPTY pending dict — tearing down the connection and
    killing the in-flight call. Must be skipped like any malformed frame."""
    ext = await FakeExtension.connect(harness.url)
    try:
        await ext.handshake()
        # Put a call in flight so _pending is non-empty (the trigger).
        call_task = asyncio.create_task(harness.bridge.call_tool("snapshot", {}))
        req = await ext.recv()
        # Build a frame with a VALID mac but id as a dict.
        env = ext.signer.sign(Envelope(type="tool_result", body={"ok": True, "data": None}))
        env["id"] = {"a": 1}
        env_no_mac = {k: v for k, v in env.items() if k != "mac"}
        import base64 as _b64
        import hashlib as _hashlib
        import hmac as _hmac

        from sallyport_daemon.protocol import canonical_json

        mac = _hmac.new(SECRET, canonical_json(env_no_mac).encode(), _hashlib.sha256).digest()
        env["mac"] = _b64.b64encode(mac).decode()
        await ext.send_raw(json.dumps(env, separators=(",", ":")))
        # The frame is skipped; the connection and the in-flight call survive.
        await ext.send("tool_result", {"ok": True, "data": {"tree": "fake"}}, id=req.id)
        assert await call_task == {"tree": "fake"}
    finally:
        await ext.close()


async def test_large_integral_numbers_roundtrip(harness: BridgeHarness) -> None:
    """Integral values in [2^53, 1e21) go on the JS wire as bare integers;
    the daemon must verify and return them. Mimics the extension by sending
    bare-digit ints (json.dumps of a Python int emits exactly the digits
    JSON.stringify would)."""
    ext = await FakeExtension.connect(harness.url)
    try:
        await ext.handshake()
        for value in (10**16, 1152921504606847000, 1700000000000000000):
            call_task = asyncio.create_task(harness.bridge.call_tool("evaluate", {"e": "x"}))
            req = await ext.recv()
            await ext.send("tool_result", {"ok": True, "data": {"value": value}}, id=req.id)
            result = await call_task
            assert result == {"value": value}
    finally:
        await ext.close()


async def test_unserialisable_tool_args_fail_fast(harness: BridgeHarness) -> None:
    """Arguments the canonical encoding rejects (NaN, huge ints) must fail
    with a legible ToolError at call time — not a 60 s timeout."""
    ext = await FakeExtension.connect(harness.url)
    try:
        await ext.handshake()
        with pytest.raises(ToolError, match="not wire-serialisable") as exc_info:
            await harness.bridge.call_tool("evaluate", {"weird": float("nan")})
        assert exc_info.value.code == "bad_args"
        # The connection is unaffected.
        call_task = asyncio.create_task(harness.bridge.call_tool("list_tabs", {}))
        req = await ext.recv()
        await ext.send("tool_result", {"ok": True, "data": {"tabs": []}}, id=req.id)
        assert await call_task == {"tabs": []}
    finally:
        await ext.close()


async def test_tool_result_without_id_is_silently_dropped(
    harness: BridgeHarness,
) -> None:
    """Defensive: an extension that sends `tool_result` without an `id` field
    has no way to be matched to a pending future. The bridge must skip it
    quietly, never raise, and never leave a future hanging."""
    ext = await FakeExtension.connect(harness.url)
    try:
        await ext.handshake()
        # Envelope with id=None → Signer.sign omits the `id` field entirely.
        await ext.send("tool_result", {"ok": True, "data": "ghost"}, id=None)
        # Bridge should not respond and connection stays alive.
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(ext.ws.recv(), timeout=0.3)
        # And a normal in-flight call still works after.
        call_task = asyncio.create_task(harness.bridge.call_tool("list_tabs", {}))
        req = await ext.recv()
        await ext.send("tool_result", {"ok": True, "data": {"tabs": []}}, id=req.id)
        assert await call_task == {"tabs": []}
    finally:
        await ext.close()
