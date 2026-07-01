"""Broker mode: one long-lived process serving N authenticated MCP clients.

Where standalone mode is one stdio MCP daemon owning one Bridge, broker mode
owns the single extension WS leg once and multiplexes it across many Claude
Code sessions. Each session connects as a separate MCP client over a framed
AF_UNIX socket; this module holds the per-connection machinery.

This first slice is the **authentication handshake** (security invariant #14,
"MCP-client auth, earned-not-grabbed"): a connecting client must prove a valid
signed `hello` — reusing the same HMAC `Signer` the extension authenticates
with — before anything is disclosed or done, and the broker assigns it a
server-minted, connection-bound `clientId` (never client-supplied) that later
scopes tab ownership and audit. There is no `Origin` check as on the WS leg:
the socket's `0600` kernel uid gate is the network-surface equivalent, and the
HMAC hello is the capability gate on top.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import secrets as _secrets
import stat
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any

import anyio
from anyio.streams.memory import MemoryObjectReceiveStream, MemoryObjectSendStream
from mcp.shared.message import SessionMessage
from mcp.types import JSONRPCMessage

from .framing import FramingError, read_frame, write_frame
from .protocol import Envelope, ProtocolError, Signer
from .secret import DEFAULT_PATH

if TYPE_CHECKING:
    from .bridge import Bridge

# Server-minted clientId width (hex chars). 16 bytes → 128 bits, unguessable;
# connection-bound and ephemeral, the multi-slot analogue of `self._client`.
_CLIENT_ID_BYTES = 16

# Cap on concurrently-served MCP clients. All connections are same-uid (the
# 0600 socket), so this is a flat total rather than a true per-uid quota — it
# bounds resource use against a runaway/buggy trusted client (DoS within the
# trusted set, the same-uid floor), not an attacker. Generous: 16 simultaneous
# Claude Code sessions driving one browser is already far past normal use.
MAX_BROKER_CLIENTS = 16

# Bound on connections still in the (≤ hello_timeout) handshake at once. Kept
# SEPARATE from MAX_BROKER_CLIENTS so a never-hello peer can occupy only a
# short-lived pending slot, never one of the authenticated client slots — i.e.
# slots are earned, not grabbed (invariant #14). Generous headroom over the
# client cap so a legitimate burst of concurrent sign-ons is never refused.
MAX_PENDING_HANDSHAKES = MAX_BROKER_CLIENTS * 4


def _parse_json(raw: bytes) -> dict[str, Any]:
    """Parse a frame payload into the envelope dict, mapping any malformed
    input to ProtocolError (a skipped/rejected frame, never a teardown)."""
    try:
        parsed = json.loads(raw)
    except (ValueError, RecursionError) as exc:
        raise ProtocolError(f"invalid JSON frame: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ProtocolError("frame is not a JSON object")
    return parsed


def _dump_json(obj: dict[str, Any]) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


# JSON-RPC 2.0 "internal error" code, used when an outbound message body can't be
# canonically signed and we answer with a minimal, always-signable error instead.
_JSONRPC_INTERNAL_ERROR = -32603


def _unserialisable_error(body: dict[str, Any]) -> dict[str, Any] | None:
    """A minimal JSON-RPC error response echoing ``body``'s id, for when the real
    response can't be canonically signed — so the client gets an error instead of
    a dropped connection. None when ``body`` carries no id (a notification: there
    is nothing to answer, just skip it)."""
    request_id = body.get("id")
    if request_id is None:
        return None
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": _JSONRPC_INTERNAL_ERROR, "message": "unserialisable_result"},
    }


async def _close_quietly(writer: asyncio.StreamWriter) -> None:
    writer.close()
    try:
        await writer.wait_closed()
    except OSError:
        pass


async def authenticate_connection(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    signer: Signer,
    *,
    hello_timeout: float = 10.0,
) -> str | None:
    """Run the broker-side MCP-client handshake over a framed AF_UNIX stream.

    Mirrors ``Bridge._handle_client``'s hello gate: the first frame must be a
    valid signed ``hello`` within ``hello_timeout``. On success, mint a
    server-assigned connection-bound ``clientId``, ack it, and return it. On any
    failure close the writer WITHOUT echoing a reason — a same-uid prober learns
    nothing (not even whether an extension is attached) — and return None.
    """
    try:
        raw = await asyncio.wait_for(read_frame(reader), timeout=hello_timeout)
    except (TimeoutError, FramingError, OSError):
        await _close_quietly(writer)
        return None
    if raw is None:  # clean EOF before a hello ever arrived
        await _close_quietly(writer)
        return None

    try:
        env = signer.verify(_parse_json(raw))
        if env.type != "hello":
            raise ProtocolError(f"expected hello, got {env.type!r}")
    except (ProtocolError, RecursionError):
        await _close_quietly(writer)
        return None

    client_id = _secrets.token_hex(_CLIENT_ID_BYTES)
    # The ack body stays empty (parity with the WS hello_ack): the clientId is
    # internal — it scopes ownership broker-side and never travels to the client
    # (no reclaim credential in v1, so nothing for the peer to hold).
    ack = signer.sign(Envelope(type="hello_ack", body={}))
    try:
        await write_frame(writer, _dump_json(ack))
    except (OSError, FramingError):
        await _close_quietly(writer)
        return None
    return client_id


@asynccontextmanager
async def mcp_socket_streams(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    signer: Signer,
) -> AsyncIterator[
    tuple[
        MemoryObjectReceiveStream[SessionMessage | Exception],
        MemoryObjectSendStream[SessionMessage],
    ]
]:
    """Adapt a framed, HMAC-authenticated AF_UNIX stream into the
    ``(read_stream, write_stream)`` pair ``mcp.server.Server.run`` consumes —
    the broker's analogue of ``mcp.server.stdio.stdio_server``.

    Each inbound frame is a signed ``mcp`` envelope whose body is one JSON-RPC
    message; we verify it (HMAC, freshness, replay — the same ``Signer`` the
    extension authenticates with) and hand the inner message to the server.
    Each outbound message is signed into an ``mcp`` envelope and framed back.

    A frame that fails verification on this already-authenticated channel is
    skipped (mirror the WS read loop), never surfaced. A malformed inner
    JSON-RPC message is surfaced to the server as an exception on the read
    stream (mirror ``stdio_server``)."""
    read_stream_writer, read_stream = anyio.create_memory_object_stream[
        "SessionMessage | Exception"
    ](0)
    write_stream, write_stream_reader = anyio.create_memory_object_stream[SessionMessage](0)

    async def socket_reader() -> None:
        try:
            async with read_stream_writer:
                while True:
                    try:
                        raw = await read_frame(reader)
                    except (FramingError, OSError):
                        break
                    if raw is None:
                        break
                    try:
                        env = signer.verify(_parse_json(raw))
                    except (ProtocolError, RecursionError):
                        continue  # forged / replayed / garbled frame: skip
                    if env.type != "mcp":
                        continue  # control frames (ping/pong) aren't MCP payload
                    try:
                        message = JSONRPCMessage.model_validate(env.body)
                    except Exception as exc:  # noqa: BLE001 - surface like stdio_server
                        await read_stream_writer.send(exc)
                        continue
                    await read_stream_writer.send(SessionMessage(message))
        except anyio.ClosedResourceError:  # pragma: no cover - consumer hung up
            pass

    async def socket_writer() -> None:
        try:
            async with write_stream_reader:
                async for session_message in write_stream_reader:
                    body = session_message.message.model_dump(
                        by_alias=True, exclude_none=True, mode="json"
                    )
                    try:
                        frame = _dump_json(signer.sign(Envelope(type="mcp", body=body)))
                    except ProtocolError:
                        # Body holds a value canonical JSON can't sign. Don't tear
                        # the session down (it would strand every in-flight request
                        # on this connection) — answer this one with a JSON-RPC
                        # error carrying the same id; skip a notification (no id).
                        err = _unserialisable_error(body)
                        if err is None:
                            continue
                        try:
                            frame = _dump_json(signer.sign(Envelope(type="mcp", body=err)))
                        except ProtocolError:  # pragma: no cover - id itself illegal
                            continue
                    try:
                        await write_frame(writer, frame)
                    except (OSError, FramingError):
                        break
        except anyio.ClosedResourceError:  # pragma: no cover - producer hung up
            pass

    async with anyio.create_task_group() as tg:
        tg.start_soon(socket_reader)
        tg.start_soon(socket_writer)
        yield read_stream, write_stream


async def _serve_authenticated(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    bridge: Bridge,
    signer: Signer,
    client_id: str,
) -> None:
    """Run a per-connection MCP server bound to an already-authenticated
    ``clientId`` until the client disconnects, then release its resources.

    The ``clientId`` is threaded through ``build_server`` into every tool call,
    so each connection's calls are attributable and ownership-scoped (#13). The
    shared ``Bridge`` (single extension WS slot, invariant #8) is untouched; the
    call lock keeps concurrent clients from racing the one browser."""
    from .mcp_server import build_server

    try:
        server = build_server(bridge, client_id=client_id)
        async with mcp_socket_streams(reader, writer, signer) as (read_stream, write_stream):
            await server.run(read_stream, write_stream, server.create_initialization_options())
    finally:
        # Release this client's owned tabs (invariant #13): they stay open but
        # become unowned, so the human can use/close them. Then close the socket.
        bridge.release_client(client_id)
        await _close_quietly(writer)


async def serve_connection(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    bridge: Bridge,
    signer: Signer,
    *,
    hello_timeout: float = 10.0,
) -> str | None:
    """Serve one MCP client end-to-end: authenticate, then run its MCP server
    until disconnect. Returns the served ``clientId`` (None if authentication
    failed). The accept loop in ``start_broker_server`` splits these two phases
    so the client cap counts only earned slots; this whole-path helper is kept
    for direct/standalone-style use and tests."""
    client_id = await authenticate_connection(reader, writer, signer, hello_timeout=hello_timeout)
    if client_id is None:
        return None
    await _serve_authenticated(reader, writer, bridge, signer, client_id)
    return client_id


class BrokerError(Exception):
    """Broker startup/socket-claim failure (already running, squatted path)."""


def broker_socket_path(port: int, config_dir: Path | None = None) -> Path:
    """Path of the broker's AF_UNIX socket. Lives beside the secret (same
    0700-able config dir) so the kernel uid gate that protects the secret
    protects the socket too."""
    base = config_dir if config_dir is not None else DEFAULT_PATH.parent
    return base / f"broker-{port}.sock"


def _prepare_socket_dir(path: Path) -> None:
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    os.chmod(parent, 0o700)


async def _socket_is_live(path: Path) -> bool:
    """True iff a broker is currently listening on `path` (a connect succeeds)."""
    try:
        _, writer = await asyncio.open_unix_connection(str(path))
    except OSError:
        return False
    writer.close()
    with contextlib.suppress(OSError):
        await writer.wait_closed()
    return True


def _classify_socket_path(path: Path) -> bool:
    """Sync pre-bind checks on an existing path. Returns True if it is OUR socket
    (caller must liveness-check before reclaiming), False if nothing is there.
    Raises BrokerError on a non-socket or foreign-owned path."""
    if not path.exists():
        return False
    st = path.stat()
    if not stat.S_ISSOCK(st.st_mode):
        raise BrokerError(f"{path} exists and is not a socket")
    if st.st_uid != os.getuid():
        raise BrokerError(f"{path} is owned by uid {st.st_uid}, refusing to bind")
    return True


def _reclaim_stale_socket(path: Path) -> None:
    path.unlink()


async def _claim_socket_path(path: Path) -> None:
    """Make `path` safe to bind: refuse a foreign-owned or live socket, unlink a
    stale one. Best-effort against a same-uid squatter — per the threat model
    the security floor is same-uid (such an attacker can read the secret anyway).

    The blocking filesystem checks live in sync helpers so this coroutine only
    awaits the (genuinely async) liveness probe."""
    if not _classify_socket_path(path):
        return
    if await _socket_is_live(path):
        raise BrokerError(f"a broker is already listening on {path}")
    _reclaim_stale_socket(path)  # stale socket from a crashed broker


async def start_broker_server(
    bridge: Bridge,
    secret: bytes,
    path: Path,
    *,
    hello_timeout: float = 10.0,
    max_clients: int = MAX_BROKER_CLIENTS,
    max_pending: int = MAX_PENDING_HANDSHAKES,
) -> asyncio.Server:
    """Bind the broker's AF_UNIX socket and accept MCP clients. Returns the
    running server; the caller owns its lifecycle (`serve_forever` / `close`).
    The socket is chmod 0600 so only the owning uid can reach it — the
    network-surface analogue of invariant #2.

    Each connection gets a FRESH ``Signer`` (gap-11): the nonce-replay cache was
    sized for the single extension peer, so a shared cache across N clients could
    churn a still-fresh nonce out of the window. Per-connection caches keep each
    client's replay window closed independently.

    Two separate bounds, both check-then-increment with no ``await`` between the
    two steps (atomic under single-threaded asyncio, no lock needed):

    * ``max_clients`` — AUTHENTICATED clients served at once. Checked up front so
      a connection arriving with no free client slot is refused BEFORE auth (no
      reason echoed, no crypto spent), and re-checked after auth in case the last
      slot was claimed during the handshake.
    * ``max_pending`` — connections still in the (≤ ``hello_timeout``) handshake.
      A never-hello peer occupies only a pending slot, never a client slot, so it
      can't lock authenticated sessions out (invariant #14, earned-not-grabbed)."""
    _prepare_socket_dir(path)
    await _claim_socket_path(path)

    active = 0  # authenticated clients being served
    pending = 0  # connections still in the handshake

    async def _handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        nonlocal active, pending
        # No free client slot at all → refuse before auth (no disclosure, no
        # crypto). Bound concurrent half-open handshakes separately.
        if active >= max_clients or pending >= max_pending:
            await _close_quietly(writer)
            return
        pending += 1
        try:
            signer = Signer(secret)
            client_id = await authenticate_connection(
                reader, writer, signer, hello_timeout=hello_timeout
            )
        finally:
            pending -= 1
        if client_id is None:
            return  # auth failed/timed out; authenticate_connection closed it
        if active >= max_clients:
            await _close_quietly(writer)  # earned the hello but lost the last slot
            return
        active += 1
        try:
            await _serve_authenticated(reader, writer, bridge, signer, client_id)
        finally:
            active -= 1

    server = await asyncio.start_unix_server(_handler, path=str(path))
    os.chmod(path, 0o600)
    return server


async def broker_is_available(path: Path) -> bool:
    """Role detection: True iff a live broker WE own is listening on `path`.
    A standalone daemon uses this at startup to decide whether to become a shim
    (broker present) or own the WS port itself (no broker)."""
    try:
        if not _classify_socket_path(path):
            return False  # nothing there
    except BrokerError:
        return False  # foreign-owned / not a socket — not a broker we may use
    return await _socket_is_live(path)


async def run_shim(
    cc_reader: asyncio.StreamReader,
    cc_writer: asyncio.StreamWriter,
    sock_reader: asyncio.StreamReader,
    sock_writer: asyncio.StreamWriter,
    signer: Signer,
    *,
    hello_timeout: float = 10.0,
) -> None:
    """Relay one Claude Code stdio MCP session to the broker socket.

    The shim is a transport translator, not an MCP participant: it adds/strips
    the HMAC envelope + length-prefix framing so MCP semantics pass through
    untouched. Claude Code speaks newline-delimited JSON-RPC on
    ``cc_reader``/``cc_writer``; the broker speaks framed ``mcp`` envelopes on
    ``sock_reader``/``sock_writer``. The shim first authenticates to the broker
    (signed hello), then pumps both directions until either side closes."""
    await write_frame(sock_writer, _dump_json(signer.sign(Envelope(type="hello", body={}))))
    try:
        ack = await asyncio.wait_for(read_frame(sock_reader), timeout=hello_timeout)
    except (TimeoutError, FramingError, OSError) as exc:
        raise BrokerError("broker handshake failed") from exc
    if ack is None:
        raise BrokerError("broker closed before hello_ack")
    try:
        if signer.verify(_parse_json(ack)).type != "hello_ack":
            raise BrokerError("unexpected broker hello response")
    except (ProtocolError, RecursionError) as exc:
        raise BrokerError("broker hello_ack failed verification") from exc

    async def pump_up() -> None:  # Claude Code -> broker
        while True:
            try:
                line = await cc_reader.readline()
            except ValueError:
                # A line longer than the reader's limit (LimitOverrunError, raised
                # as ValueError) — beyond the frame cap, so it can't be relayed.
                # Stop the relay cleanly rather than letting it crash the shim.
                break
            if not line:
                break
            try:
                msg = json.loads(line)
            except ValueError:
                continue  # not JSON — drop, like the SDK's stdin reader
            try:
                env = signer.sign(Envelope(type="mcp", body=msg))
                await write_frame(sock_writer, _dump_json(env))
            except (OSError, FramingError, ProtocolError):
                break

    async def pump_down() -> None:  # broker -> Claude Code
        while True:
            try:
                raw = await read_frame(sock_reader)
            except (FramingError, OSError):
                break
            if raw is None:
                break
            try:
                env = signer.verify(_parse_json(raw))
            except (ProtocolError, RecursionError):
                continue  # forged/garbled frame on an authed channel: skip
            if env.type != "mcp":
                continue
            try:
                cc_writer.write(_dump_json(env.body) + b"\n")
                await cc_writer.drain()
            except OSError:
                break

    up = asyncio.create_task(pump_up())
    down = asyncio.create_task(pump_down())
    try:
        await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in (up, down):
            task.cancel()
        await asyncio.gather(up, down, return_exceptions=True)
