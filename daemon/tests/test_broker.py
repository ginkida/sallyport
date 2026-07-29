"""Broker mode: per-connection MCP-client authentication (invariant #14)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import shutil
import socket
import tempfile
from collections.abc import Iterator
from pathlib import Path

import anyio
import pytest
from mcp.shared.message import SessionMessage
from mcp.types import JSONRPCMessage

from sallyport_daemon.broker import (
    BrokerError,
    _claim_socket_path,
    _dump_json,
    _parse_json,
    _prepare_socket_dir,
    _unserialisable_error,
    authenticate_connection,
    broker_is_available,
    broker_socket_path,
    mcp_socket_streams,
    run_shim,
    start_broker_server,
)
from sallyport_daemon.framing import FramingError, read_frame, write_frame
from sallyport_daemon.protocol import Envelope, ProtocolError, Signer

SECRET = bytes(range(32))


@pytest.fixture
def sock_path() -> Iterator[Path]:
    """A short AF_UNIX socket path (macOS caps sun_path at ~104 bytes, so the
    long pytest tmp_path won't bind)."""
    d = tempfile.mkdtemp(prefix="sp", dir="/tmp")  # noqa: S108 - short path needed for AF_UNIX
    try:
        yield Path(d) / "b.sock"
    finally:
        shutil.rmtree(d, ignore_errors=True)


async def _status_text_over(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter, client_signer: Signer
) -> str:
    """Authenticate then run a real MCP ClientSession to call `status`, tearing
    the framed socket down so both adapter pumps unblock. Returns the result."""
    from mcp.client.session import ClientSession
    from mcp.types import TextContent

    await write_frame(writer, _dump_json(client_signer.sign(Envelope(type="hello", body={}))))
    ack = await read_frame(reader)
    assert ack is not None
    assert client_signer.verify(_parse_json(ack)).type == "hello_ack"
    async with mcp_socket_streams(reader, writer, client_signer) as (crs, cws):
        async with ClientSession(crs, cws) as session:
            await session.initialize()
            result = await session.call_tool("status", {})
            block = result.content[0]
            assert isinstance(block, TextContent)
            text = block.text
        await cws.aclose()
        writer.close()
    return text


async def _stream_pair() -> tuple[
    tuple[asyncio.StreamReader, asyncio.StreamWriter],
    tuple[asyncio.StreamReader, asyncio.StreamWriter],
]:
    """A connected AF_UNIX socketpair, each end wrapped as asyncio streams.
    Returns (server_side, client_side)."""
    s1, s2 = socket.socketpair()
    server = await asyncio.open_connection(sock=s1)
    client = await asyncio.open_connection(sock=s2)
    return server, client


async def _drain_close(*writers: asyncio.StreamWriter) -> None:
    for w in writers:
        w.close()
    for w in writers:
        try:
            await w.wait_closed()
        except OSError:
            pass


@pytest.mark.asyncio
async def test_valid_hello_returns_client_id_and_acks() -> None:
    (sr, sw), (cr, cw) = await _stream_pair()
    client_signer = Signer(SECRET)
    await write_frame(cw, _dump_json(client_signer.sign(Envelope(type="hello", body={}))))

    identity = await authenticate_connection(sr, sw, Signer(SECRET))
    assert identity is not None
    assert isinstance(identity.id, str)
    assert len(identity.id) == 32
    assert identity.label is None  # none declared

    # The client receives a verifiable hello_ack.
    ack_raw = await read_frame(cr)
    assert ack_raw is not None
    ack = client_signer.verify(_parse_json(ack_raw))
    assert ack.type == "hello_ack"
    # The ack carries the broker's build so a shim can warn about version skew —
    # and nothing identifying: the clientId never travels to the peer (#14).
    assert isinstance(ack.body["version"], str)
    assert identity.id not in json.dumps(ack.body)
    await _drain_close(sw, cw)


@pytest.mark.asyncio
async def test_hello_label_is_sanitised_and_capped() -> None:
    """A session may declare a cosmetic label. It is peer-supplied text that
    ends up in the extension's persisted audit log, so it is normalised and
    bounded — and it is never an identity (ownership keys on the minted id)."""
    (sr, sw), (_cr, cw) = await _stream_pair()
    signer = Signer(SECRET)
    await write_frame(
        cw,
        _dump_json(signer.sign(Envelope(type="hello", body={"label": "my repo/../<x>"}))),
    )
    identity = await authenticate_connection(sr, sw, Signer(SECRET))
    assert identity is not None
    assert identity.label == "my-repo-..--x"
    await _drain_close(sw, cw)


def test_sanitise_label_rules() -> None:
    from sallyport_daemon.broker import MAX_LABEL_CHARS, sanitise_label

    assert sanitise_label("bridge") == "bridge"
    assert sanitise_label("  spaced  ") == "spaced"
    assert sanitise_label("a" * 100) == "a" * MAX_LABEL_CHARS
    assert sanitise_label("...") == "..."  # dots are kept, only edges trimmed
    assert sanitise_label("///") is None  # nothing printable survives
    assert sanitise_label("") is None
    assert sanitise_label(42) is None
    assert sanitise_label(None) is None


@pytest.mark.asyncio
async def test_wrong_secret_hello_is_rejected_without_reason() -> None:
    (sr, sw), (cr, cw) = await _stream_pair()
    await write_frame(cw, _dump_json(Signer(b"x" * 32).sign(Envelope(type="hello", body={}))))

    client_id = await authenticate_connection(sr, sw, Signer(SECRET))
    assert client_id is None
    # No reason frame is echoed — the server just closed.
    assert await read_frame(cr) is None
    await _drain_close(sw, cw)


@pytest.mark.asyncio
async def test_signed_non_hello_first_frame_is_rejected() -> None:
    (sr, sw), (_cr, cw) = await _stream_pair()
    await write_frame(cw, _dump_json(Signer(SECRET).sign(Envelope(type="ping", body={}))))

    assert await authenticate_connection(sr, sw, Signer(SECRET)) is None
    await _drain_close(sw, cw)


@pytest.mark.asyncio
async def test_no_hello_within_timeout_is_rejected() -> None:
    (sr, sw), (_cr, cw) = await _stream_pair()
    # Send nothing; the handshake must time out and refuse.
    assert await authenticate_connection(sr, sw, Signer(SECRET), hello_timeout=0.05) is None
    await _drain_close(sw, cw)


@pytest.mark.asyncio
async def test_clean_eof_before_hello_is_rejected() -> None:
    (sr, sw), (_cr, cw) = await _stream_pair()
    cw.close()  # client hangs up before sending anything
    assert await authenticate_connection(sr, sw, Signer(SECRET)) is None
    await _drain_close(sw)


@pytest.mark.asyncio
async def test_malformed_json_frame_is_rejected() -> None:
    (sr, sw), (_cr, cw) = await _stream_pair()
    await write_frame(cw, b"not json at all {")
    assert await authenticate_connection(sr, sw, Signer(SECRET)) is None
    await _drain_close(sw, cw)


def test_parse_json_rejects_non_object() -> None:
    with pytest.raises(ProtocolError):
        _parse_json(b"[1, 2, 3]")
    with pytest.raises(ProtocolError):
        _parse_json(b"\xff\xfe")


# --- mcp_socket_streams: framed HMAC socket <-> Server.run stream pair ---


@pytest.mark.asyncio
async def test_mcp_streams_inbound_frame_becomes_session_message() -> None:
    (sr, sw), (_cr, cw) = await _stream_pair()
    client_signer = Signer(SECRET)
    req = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
    async with mcp_socket_streams(sr, sw, Signer(SECRET)) as (read_stream, write_stream):
        await write_frame(cw, _dump_json(client_signer.sign(Envelope(type="mcp", body=req))))
        received = await read_stream.receive()
        assert isinstance(received, SessionMessage)
        assert received.message.model_dump(by_alias=True, exclude_none=True, mode="json") == req
        await write_stream.aclose()
        cw.close()
    await _drain_close(sw, cw)


@pytest.mark.asyncio
async def test_mcp_streams_outbound_message_becomes_signed_frame() -> None:
    (sr, sw), (cr, cw) = await _stream_pair()
    client_signer = Signer(SECRET)
    msg = JSONRPCMessage.model_validate({"jsonrpc": "2.0", "id": 2, "result": {}})
    async with mcp_socket_streams(sr, sw, Signer(SECRET)) as (read_stream, write_stream):
        await write_stream.send(SessionMessage(msg))
        frame = await read_frame(cr)
        assert frame is not None
        env = client_signer.verify(_parse_json(frame))
        assert env.type == "mcp"
        assert env.body == msg.model_dump(by_alias=True, exclude_none=True, mode="json")
        await write_stream.aclose()
        cw.close()
    await _drain_close(sw, cw)


@pytest.mark.asyncio
async def test_mcp_streams_malformed_inner_message_surfaces_exception() -> None:
    (sr, sw), (_cr, cw) = await _stream_pair()
    client_signer = Signer(SECRET)
    async with mcp_socket_streams(sr, sw, Signer(SECRET)) as (read_stream, write_stream):
        await write_frame(
            cw, _dump_json(client_signer.sign(Envelope(type="mcp", body={"nope": 1})))
        )
        received = await read_stream.receive()
        assert isinstance(received, Exception)
        await write_stream.aclose()
        cw.close()
    await _drain_close(sw, cw)


@pytest.mark.asyncio
async def test_mcp_streams_skips_forged_frame_then_delivers_valid() -> None:
    (sr, sw), (_cr, cw) = await _stream_pair()
    client_signer = Signer(SECRET)
    req = {"jsonrpc": "2.0", "id": 7, "method": "ping"}
    async with mcp_socket_streams(sr, sw, Signer(SECRET)) as (read_stream, write_stream):
        await write_frame(cw, _dump_json(Signer(b"z" * 32).sign(Envelope(type="mcp", body=req))))
        await write_frame(cw, _dump_json(client_signer.sign(Envelope(type="mcp", body=req))))
        received = await read_stream.receive()
        assert isinstance(received, SessionMessage)
        assert received.message.model_dump(by_alias=True, exclude_none=True, mode="json") == req
        await write_stream.aclose()
        cw.close()
    await _drain_close(sw, cw)


@pytest.mark.asyncio
async def test_mcp_streams_skips_non_mcp_control_frame() -> None:
    (sr, sw), (_cr, cw) = await _stream_pair()
    client_signer = Signer(SECRET)
    req = {"jsonrpc": "2.0", "id": 9, "method": "ping"}
    async with mcp_socket_streams(sr, sw, Signer(SECRET)) as (read_stream, write_stream):
        await write_frame(cw, _dump_json(client_signer.sign(Envelope(type="ping", body={}))))
        await write_frame(cw, _dump_json(client_signer.sign(Envelope(type="mcp", body=req))))
        received = await read_stream.receive()
        assert isinstance(received, SessionMessage)
        await write_stream.aclose()
        cw.close()
    await _drain_close(sw, cw)


@pytest.mark.asyncio
async def test_mcp_streams_read_ends_on_eof() -> None:
    (sr, sw), (_cr, cw) = await _stream_pair()
    async with mcp_socket_streams(sr, sw, Signer(SECRET)) as (read_stream, write_stream):
        cw.close()  # client hangs up before sending anything
        with pytest.raises(anyio.EndOfStream):
            await read_stream.receive()
        await write_stream.aclose()
    await _drain_close(sw, cw)


@pytest.mark.asyncio
async def test_mcp_streams_rejects_replayed_frame() -> None:
    """A byte-identical signed `mcp` frame sent twice is dropped the second time
    (per-frame nonce replay defence, invariant #1) — proven by showing the NEXT
    delivered message is a fresh frame, not the redelivered replay."""
    (sr, sw), (_cr, cw) = await _stream_pair()
    client_signer = Signer(SECRET)
    frame = _dump_json(
        client_signer.sign(
            Envelope(type="mcp", body={"jsonrpc": "2.0", "id": 11, "method": "ping"})
        )
    )
    async with mcp_socket_streams(sr, sw, Signer(SECRET)) as (read_stream, write_stream):
        await write_frame(cw, frame)
        first = await read_stream.receive()
        assert isinstance(first, SessionMessage)
        await write_frame(cw, frame)  # replay — must be skipped, not redelivered
        req2 = {"jsonrpc": "2.0", "id": 12, "method": "ping"}
        await write_frame(cw, _dump_json(client_signer.sign(Envelope(type="mcp", body=req2))))
        nxt = await read_stream.receive()
        assert nxt.message.model_dump(by_alias=True, exclude_none=True, mode="json") == req2
        await write_stream.aclose()
        cw.close()
    await _drain_close(sw, cw)


@pytest.mark.asyncio
async def test_mcp_streams_nonce_cache_is_per_connection() -> None:
    """gap-11: each connection gets its OWN nonce window, so the SAME signed frame
    is accepted independently on two connections (no shared cache one client could
    churn for another)."""
    frame = _dump_json(
        Signer(SECRET).sign(
            Envelope(type="mcp", body={"jsonrpc": "2.0", "id": 21, "method": "ping"})
        )
    )
    (sr1, sw1), (_c1r, c1w) = await _stream_pair()
    (sr2, sw2), (_c2r, c2w) = await _stream_pair()
    async with mcp_socket_streams(sr1, sw1, Signer(SECRET)) as (rs1, ws1):
        async with mcp_socket_streams(sr2, sw2, Signer(SECRET)) as (rs2, ws2):
            await write_frame(c1w, frame)
            await write_frame(c2w, frame)  # same bytes, different connection
            assert isinstance(await rs1.receive(), SessionMessage)
            assert isinstance(await rs2.receive(), SessionMessage)  # both accepted
            await ws1.aclose()
            await ws2.aclose()
            c1w.close()
            c2w.close()
    await _drain_close(sw1, c1w, sw2, c2w)


def test_unserialisable_error_shape_and_notification_skip() -> None:
    # A notification (no id) has nothing to answer → None.
    assert _unserialisable_error({"jsonrpc": "2.0", "method": "x"}) is None
    # A request gets a minimal, always-signable JSON-RPC error echoing its id.
    assert _unserialisable_error({"jsonrpc": "2.0", "id": 7, "method": "x"}) == {
        "jsonrpc": "2.0",
        "id": 7,
        "error": {"code": -32603, "message": "unserialisable_result"},
    }


@pytest.mark.asyncio
async def test_release_client_fires_on_real_disconnect() -> None:
    """serve_connection must release the client's ownership in its finally when
    the MCP connection drops — not only when release_client is called directly."""
    from sallyport_daemon.bridge import Bridge
    from sallyport_daemon.broker import serve_connection

    released: list[str | None] = []

    class _SpyBridge(Bridge):
        def release_client(self, client_id: str | None) -> None:
            released.append(client_id)
            super().release_client(client_id)

    (sr, sw), (cr, cw) = await _stream_pair()
    bridge = _SpyBridge(secret=SECRET, host="127.0.0.1", port=10086)
    server_task = asyncio.create_task(serve_connection(sr, sw, bridge, Signer(SECRET)))
    try:
        # _status_text_over drives initialize+status then closes the client end,
        # so the broker sees EOF and serve_connection runs its release finally.
        await asyncio.wait_for(_status_text_over(cr, cw, Signer(SECRET)), timeout=10)
        await asyncio.wait_for(server_task, timeout=10)
        assert len(released) == 1
        assert isinstance(released[0], str)  # the server-minted clientId
    finally:
        if not server_task.done():
            server_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await server_task
        await _drain_close(sw, cw)


# --- serve_connection: full stack at single-client parity ---


@pytest.mark.asyncio
async def test_broker_serves_status_over_socket_e2e() -> None:
    """End-to-end: a real MCP ClientSession drives initialize + call_tool over
    the framed HMAC socket and the broker answers `status` (which needs no
    extension), proving framing + auth + adapter + Server.run + clientId
    threading all line up at single-client parity."""
    import contextlib

    from mcp.client.session import ClientSession
    from mcp.types import TextContent

    from sallyport_daemon.bridge import Bridge
    from sallyport_daemon.broker import serve_connection

    (sr, sw), (cr, cw) = await _stream_pair()
    bridge = Bridge(secret=SECRET, host="127.0.0.1", port=10086)
    server_task = asyncio.create_task(serve_connection(sr, sw, bridge, Signer(SECRET)))
    client_signer = Signer(SECRET)

    async def _drive() -> str:
        await write_frame(cw, _dump_json(client_signer.sign(Envelope(type="hello", body={}))))
        ack = await read_frame(cr)
        assert ack is not None
        assert client_signer.verify(_parse_json(ack)).type == "hello_ack"
        async with mcp_socket_streams(cr, cw, client_signer) as (crs, cws):
            async with ClientSession(crs, cws) as session:
                await session.initialize()
                result = await session.call_tool("status", {})
                block = result.content[0]
                assert isinstance(block, TextContent)
                text = block.text
            # Tear down so BOTH adapter pumps unblock: end the writer, close the
            # transport (EOFs the broker and our own reader).
            await cws.aclose()
            cw.close()
        return text

    try:
        text = await asyncio.wait_for(_drive(), timeout=10)
        assert '"connected": false' in text
    finally:
        cw.close()
        server_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await server_task
        await _drain_close(sw, cw)


# --- broker socket: path, hygiene, accept loop ---


def test_broker_socket_path_uses_config_dir(tmp_path: Path) -> None:
    assert broker_socket_path(10086, config_dir=tmp_path) == tmp_path / "broker-10086.sock"


@pytest.mark.asyncio
async def test_claim_unlinks_stale_socket(sock_path: Path) -> None:
    _prepare_socket_dir(sock_path)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(str(sock_path))  # leaves a socket file with no listener
    s.close()
    assert sock_path.exists()
    await _claim_socket_path(sock_path)
    assert not sock_path.exists()


@pytest.mark.asyncio
async def test_claim_raises_on_live_socket(sock_path: Path) -> None:
    _prepare_socket_dir(sock_path)

    async def _noop(_r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
        w.close()

    server = await asyncio.start_unix_server(_noop, path=str(sock_path))
    try:
        with pytest.raises(BrokerError):
            await _claim_socket_path(sock_path)
    finally:
        server.close()
        with contextlib.suppress(Exception):
            await server.wait_closed()


@pytest.mark.asyncio
async def test_claim_refuses_non_socket(sock_path: Path) -> None:
    _prepare_socket_dir(sock_path)
    sock_path.write_text("not a socket")
    with pytest.raises(BrokerError):
        await _claim_socket_path(sock_path)


@pytest.mark.asyncio
async def test_claim_noop_when_absent(sock_path: Path) -> None:
    _prepare_socket_dir(sock_path)
    await _claim_socket_path(sock_path)  # nothing there → returns cleanly


@pytest.mark.asyncio
async def test_start_broker_server_e2e_over_socket_file(sock_path: Path) -> None:
    from sallyport_daemon.bridge import Bridge

    bridge = Bridge(secret=SECRET, host="127.0.0.1", port=10086)
    server = await start_broker_server(bridge, SECRET, sock_path)
    try:
        assert sock_path.stat().st_mode & 0o777 == 0o600
        reader, writer = await asyncio.open_unix_connection(str(sock_path))
        text = await asyncio.wait_for(_status_text_over(reader, writer, Signer(SECRET)), timeout=10)
        assert '"connected": false' in text
    finally:
        server.close()
        with contextlib.suppress(Exception):
            await server.wait_closed()


async def _open_authed(
    sock_path: Path, *, tries: int = 1
) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    """Open a connection and complete the signed hello, returning it held OPEN
    (so it keeps occupying a broker slot). Retries up to `tries` times — used
    after freeing a slot, where the broker's decrement lands asynchronously."""
    for _ in range(tries):
        reader, writer = await asyncio.open_unix_connection(str(sock_path))
        signer = Signer(SECRET)
        try:
            await write_frame(writer, _dump_json(signer.sign(Envelope(type="hello", body={}))))
            ack = await asyncio.wait_for(read_frame(reader), timeout=2)
        except (OSError, FramingError):
            # Refused before the cap decrement landed. On Linux a
            # refuse-before-read close arrives as an RST (ConnectionResetError),
            # not the clean EOF macOS gives — treat both as "not accepted, retry".
            ack = None
        if ack is not None and signer.verify(_parse_json(ack)).type == "hello_ack":
            return reader, writer
        await _drain_close(writer)
        await asyncio.sleep(0.05)
    raise AssertionError("connection was not accepted within the retry budget")


@pytest.mark.asyncio
async def test_silent_peers_do_not_block_authenticated_client(sock_path: Path) -> None:
    """Earned-not-grabbed (invariant #14): a peer that connects but never sends a
    hello occupies only a pending-handshake slot, NOT one of the authenticated
    client slots — so it cannot lock a real client out of the cap."""
    from sallyport_daemon.bridge import Bridge

    bridge = Bridge(secret=SECRET, host="127.0.0.1", port=10086)
    server = await start_broker_server(bridge, SECRET, sock_path, max_clients=2)
    silent: list[tuple[asyncio.StreamReader, asyncio.StreamWriter]] = []
    try:
        # Two peers that connect and stay silent (parked in the handshake).
        for _ in range(2):
            silent.append(await asyncio.open_unix_connection(str(sock_path)))
        await asyncio.sleep(0.05)  # let their handlers reach the pending state
        # A real client still authenticates — under the old grab-before-auth
        # design the two silent peers would have filled the cap and blocked it.
        _r, w = await _open_authed(sock_path, tries=20)
        await _drain_close(w)
    finally:
        for _r, w in silent:
            await _drain_close(w)
        server.close()
        with contextlib.suppress(Exception):
            await server.wait_closed()


@pytest.mark.asyncio
async def test_connection_cap_rejects_excess_then_frees_on_disconnect(sock_path: Path) -> None:
    """The broker caps concurrently-served clients: a connection over the cap is
    closed before auth (clean EOF, no reason), and a freed slot is reusable."""
    from sallyport_daemon.bridge import Bridge

    bridge = Bridge(secret=SECRET, host="127.0.0.1", port=10086)
    server = await start_broker_server(bridge, SECRET, sock_path, max_clients=1)
    try:
        r1, w1 = await _open_authed(sock_path)  # fills the single slot
        # A second connection is refused outright — the read sees a clean EOF
        # (macOS) or an RST (Linux refuse-before-read); both mean "refused".
        r2, w2 = await asyncio.open_unix_connection(str(sock_path))
        try:
            refused = await asyncio.wait_for(read_frame(r2), timeout=5)
        except (OSError, FramingError):
            refused = None
        assert refused is None
        await _drain_close(w2)
        # Free the slot; the broker's decrement lets a fresh client in again.
        await _drain_close(w1)
        _r3, w3 = await _open_authed(sock_path, tries=50)
        await _drain_close(w3)
    finally:
        server.close()
        with contextlib.suppress(Exception):
            await server.wait_closed()


# --- role detection + shim relay ---


@pytest.mark.asyncio
async def test_broker_is_available_absent_then_live(sock_path: Path) -> None:
    _prepare_socket_dir(sock_path)
    assert await broker_is_available(sock_path) is False  # nothing there

    async def _noop(_r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
        w.close()

    server = await asyncio.start_unix_server(_noop, path=str(sock_path))
    try:
        assert await broker_is_available(sock_path) is True
    finally:
        server.close()
        with contextlib.suppress(Exception):
            await server.wait_closed()


@pytest.mark.asyncio
async def test_broker_is_available_false_for_stale_socket(sock_path: Path) -> None:
    _prepare_socket_dir(sock_path)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(str(sock_path))  # socket file, no listener
    s.close()
    assert await broker_is_available(sock_path) is False


@pytest.mark.asyncio
async def test_shim_relays_both_directions() -> None:
    # Two transports: (Claude Code <-> shim) and (shim <-> broker).
    (shim_cc_r, shim_cc_w), (cc_r, cc_w) = await _stream_pair()
    (shim_sk_r, shim_sk_w), (brk_r, brk_w) = await _stream_pair()
    broker_signer = Signer(SECRET)

    shim_task = asyncio.create_task(
        run_shim(shim_cc_r, shim_cc_w, shim_sk_r, shim_sk_w, Signer(SECRET))
    )
    try:
        # Broker side: accept the shim's hello, send the ack.
        hello = await asyncio.wait_for(read_frame(brk_r), timeout=5)
        assert hello is not None
        assert broker_signer.verify(_parse_json(hello)).type == "hello"
        await write_frame(
            brk_w, _dump_json(broker_signer.sign(Envelope(type="hello_ack", body={})))
        )

        # Claude Code -> broker: a JSON line becomes a signed `mcp` frame.
        req = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
        cc_w.write(_dump_json(req) + b"\n")
        await cc_w.drain()
        frame = await asyncio.wait_for(read_frame(brk_r), timeout=5)
        assert frame is not None
        env = broker_signer.verify(_parse_json(frame))
        assert env.type == "mcp"
        assert env.body == req

        # broker -> Claude Code: a signed `mcp` frame becomes a JSON line.
        resp = {"jsonrpc": "2.0", "id": 1, "result": {}}
        await write_frame(brk_w, _dump_json(broker_signer.sign(Envelope(type="mcp", body=resp))))
        line = await asyncio.wait_for(cc_r.readline(), timeout=5)
        assert json.loads(line) == resp
    finally:
        cc_w.close()
        brk_w.close()
        shim_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await shim_task
        await _drain_close(shim_cc_w, shim_sk_w, cc_w, brk_w)


@pytest.mark.asyncio
async def test_shim_raises_when_broker_rejects_hello() -> None:
    (shim_cc_r, shim_cc_w), (_cc_r, cc_w) = await _stream_pair()
    (shim_sk_r, shim_sk_w), (brk_r, brk_w) = await _stream_pair()
    try:
        task = asyncio.create_task(
            run_shim(shim_cc_r, shim_cc_w, shim_sk_r, shim_sk_w, Signer(SECRET), hello_timeout=0.5)
        )
        # Broker reads the hello but closes without acking.
        assert await asyncio.wait_for(read_frame(brk_r), timeout=5) is not None
        brk_w.close()
        with pytest.raises(BrokerError):
            await asyncio.wait_for(task, timeout=5)
    finally:
        await _drain_close(shim_cc_w, shim_sk_w, cc_w, brk_w)


# --- socket claim: the flock is the real exclusion, not _claim_socket_path ---


def test_file_lock_is_exclusive(tmp_path: Path) -> None:
    """`asyncio.start_unix_server` unlinks whatever socket file is at the path
    before binding — live or not — so two brokers racing one path would BOTH
    'succeed'. The flock is what actually prevents that."""
    from sallyport_daemon.broker import acquire_file_lock, release_broker_lock

    lock = tmp_path / "claim"
    first = acquire_file_lock(lock)
    assert first is not None
    # A second acquire in the SAME process still sees its own lock as held only
    # across processes, so assert via the documented API on a second path plus
    # the release round-trip (cross-process exclusion is covered by the broker
    # e2e below, which really does start two).
    release_broker_lock(first)
    again = acquire_file_lock(lock)
    assert again is not None
    release_broker_lock(again)


def test_broker_lock_path_sits_beside_the_socket(tmp_path: Path) -> None:
    from sallyport_daemon.broker import broker_lock_path

    sock = tmp_path / "broker-10086.sock"
    assert broker_lock_path(sock) == tmp_path / "broker-10086.sock.lock"


def test_socket_path_length_is_checked_before_binding(tmp_path: Path) -> None:
    """A path over the kernel's sun_path limit fails at bind() with a bare
    'AF_UNIX path too long' from inside asyncio — check it up front instead."""
    from sallyport_daemon.broker import socket_path_is_bindable

    assert socket_path_is_bindable(Path("/tmp/sp/broker-10086.sock"))  # noqa: S108 - a path string
    assert not socket_path_is_bindable(Path("/" + "x" * 120 + "/broker-10086.sock"))


def test_unlink_socket_only_removes_our_own_inode(tmp_path: Path) -> None:
    """After a racing broker rebinds the path, the NAME points at somebody
    else's live socket — a bare unlink() at shutdown would delete it."""
    from sallyport_daemon.broker import socket_identity, unlink_socket_if_ours

    path = tmp_path / "broker.sock"
    path.write_text("first")
    ours = socket_identity(path)
    assert ours is not None

    # Someone replaced the file under the same name. Built via rename-over, NOT
    # unlink-then-create: Linux filesystems hand a just-freed inode number
    # straight back, so recreating at the same path can reuse the very number we
    # recorded (this test failed on ext4 CI for exactly that reason). A
    # replacement allocated while the original still exists is guaranteed to
    # differ — which is also what a racing broker's fresh socket would be.
    successor = tmp_path / "successor"
    successor.write_text("theirs")
    successor.replace(path)
    assert socket_identity(path) != ours
    assert unlink_socket_if_ours(path, ours) is False
    assert path.exists()

    # Our own inode is removed.
    theirs = socket_identity(path)
    assert unlink_socket_if_ours(path, theirs) is True
    assert not path.exists()
    # And a vanished socket is simply not ours to remove.
    assert unlink_socket_if_ours(path, theirs) is False


@pytest.mark.asyncio
async def test_second_broker_cannot_bind_a_claimed_socket(sock_path: Path) -> None:
    from sallyport_daemon.bridge import Bridge
    from sallyport_daemon.broker import BrokerError, acquire_broker_lock, release_broker_lock

    bridge = Bridge(secret=SECRET, host="127.0.0.1", port=10086)
    server = await start_broker_server(bridge, SECRET, sock_path)
    try:
        # A second broker on the same path must be refused, not silently steal it.
        with pytest.raises(BrokerError):
            await start_broker_server(bridge, SECRET, sock_path)
        assert sock_path.exists()
    finally:
        server.close()
        with contextlib.suppress(Exception):
            await server.wait_closed()
        release_broker_lock(acquire_broker_lock(sock_path))


@pytest.mark.asyncio
async def test_broker_state_tracks_clients_and_idle_time(sock_path: Path) -> None:
    """The idle-exit watcher and the shutdown path both read these counters, so
    they must move with the accept loop rather than live in its closure."""
    from sallyport_daemon.bridge import Bridge
    from sallyport_daemon.broker import BrokerState, close_broker_clients

    state = BrokerState()
    assert state.idle_for() >= 0.0
    state.active = 1
    assert state.idle_for() == 0.0  # never counts down while a session is attached

    bridge = Bridge(secret=SECRET, host="127.0.0.1", port=10086)
    server = await start_broker_server(bridge, SECRET, sock_path, state=state)
    try:
        state.active = 0
        state.pending = 0
        reader, writer = await asyncio.open_unix_connection(str(sock_path))
        signer = Signer(SECRET)
        await write_frame(writer, _dump_json(signer.sign(Envelope(type="hello", body={}))))
        assert await asyncio.wait_for(read_frame(reader), timeout=5) is not None
        await asyncio.sleep(0.05)
        assert state.active == 1
        assert state.served_total == 1
        assert len(state.writers) == 1

        # Shutdown must close attached connections BEFORE wait_closed(), or a
        # broker with a shim attached hangs there forever on Python 3.12+.
        await close_broker_clients(state)
        assert state.writers == set()
        writer.close()
        with contextlib.suppress(Exception):
            await writer.wait_closed()
    finally:
        server.close()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(server.wait_closed(), timeout=2)


@pytest.mark.asyncio
async def test_call_tool_via_broker_maps_a_silent_broker_to_brokererror(sock_path: Path) -> None:
    """`exec` catches (BrokerError, OSError, ProtocolError). A bare
    `asyncio.TimeoutError` would slip through that on Python 3.10, where it is
    `concurrent.futures.TimeoutError` and NOT an OSError — it only became the
    builtin `TimeoutError` (an OSError subclass) in 3.11. Version-independent
    regression: a broker that acks and then goes silent must surface as
    BrokerError, not a raw traceback."""
    from sallyport_daemon.broker import call_tool_via_broker

    async def _ack_then_silence(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        signer = Signer(SECRET)
        raw = await read_frame(reader)
        assert raw is not None
        await write_frame(writer, _dump_json(signer.sign(Envelope(type="hello_ack", body={}))))
        await asyncio.sleep(30)  # never answers the initialize

    server = await asyncio.start_unix_server(_ack_then_silence, path=str(sock_path))
    try:
        with pytest.raises(BrokerError, match="did not answer"):
            await call_tool_via_broker(sock_path, SECRET, "status", {}, call_timeout=0.1)
    finally:
        server.close()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(server.wait_closed(), timeout=2)


def test_broker_supported_reflects_the_platform() -> None:
    """`__main__` imports this module unconditionally, so the POSIX-only pieces
    (flock, AF_UNIX) must not be able to take the whole CLI down on a platform
    the package claims to support — auto-broker just turns itself off there."""
    from sallyport_daemon import broker as broker_mod

    assert broker_mod.broker_supported() is True  # this test runs on POSIX CI

    original = broker_mod.fcntl
    broker_mod.fcntl = None  # type: ignore[assignment]
    try:
        assert broker_mod.broker_supported() is False
        # And the claim degrades to "not ours" rather than raising.
        assert broker_mod.acquire_file_lock(Path("/tmp/sp-nonexistent.lock")) is None  # noqa: S108
        broker_mod.release_broker_lock(3)  # must not touch a real fd
    finally:
        broker_mod.fcntl = original
