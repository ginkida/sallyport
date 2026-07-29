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
import fcntl
import json
import os
import secrets as _secrets
import stat
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
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

# Cap on the client-declared session label. Cosmetic only (audit rows, agent
# window grouping), but it is peer-supplied text that ends up in the extension's
# persisted audit log, so it is length- and charset-bounded like any other
# untrusted string that crosses the wire.
MAX_LABEL_CHARS = 24


def _running_version() -> str:
    from .pidfile import daemon_version

    return daemon_version()


# Snapshotted at import, NOT read per handshake. `daemon_version()` goes to
# `importlib.metadata`, which re-reads the on-disk dist-info — so a broker that
# started before a `pip install -U` would cheerfully advertise the NEW version
# while still running the OLD code in memory, and the skew warning could never
# fire for the upgrade case it exists for. This is the build actually running.
RUNNING_VERSION = _running_version()


def sanitise_label(raw: Any) -> str | None:
    """Normalise a peer-declared session label, or None if unusable.

    The label is PURELY COSMETIC: it lets a human watching one browser tell
    which session opened which tab. It is client-supplied, so it must never
    reach a gate — ownership keys on the server-minted ``clientId``, which never
    leaves the daemon (invariant #14). Here we only make it safe to display:
    keep letters/digits/``.-_``, fold everything else to ``-``, cap the length.
    """
    if not isinstance(raw, str):
        return None
    kept = [c if (c.isalnum() or c in "._-") else "-" for c in raw.strip()]
    label = "".join(kept).strip("-")[:MAX_LABEL_CHARS]
    return label or None


@dataclass(frozen=True)
class ClientIdentity:
    """What one authenticated MCP connection is known by.

    ``id`` is server-minted, connection-bound and never disclosed to the peer —
    it is the ownership/diagnostics key. ``label`` is the peer's own cosmetic
    name for itself, used only for display.
    """

    id: str
    label: str | None = None


@dataclass
class BrokerState:
    """Live counters for the accept loop, hoisted out of its closure so the
    idle-exit watcher and the status file can read them."""

    active: int = 0
    pending: int = 0
    served_total: int = 0
    last_active_change: float = field(default_factory=time.monotonic)
    # Live per-connection writers. `asyncio.Server.close()` stops accepting but
    # leaves established connections alone, and on Python 3.12+ `wait_closed()`
    # blocks until they finish — with a shim attached that never happens, so a
    # broker would hang on shutdown before unlinking its socket. Shutdown closes
    # these first.
    writers: set[asyncio.StreamWriter] = field(default_factory=set)

    def note_change(self) -> None:
        self.last_active_change = time.monotonic()

    def idle_for(self) -> float:
        """Seconds since the last authenticated client came or went. Zero while
        any client is attached, so an idle timer never fires under load."""
        if self.active or self.pending:
            return 0.0
        return time.monotonic() - self.last_active_change


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
) -> ClientIdentity | None:
    """Run the broker-side MCP-client handshake over a framed AF_UNIX stream.

    Mirrors ``Bridge._handle_client``'s hello gate: the first frame must be a
    valid signed ``hello`` within ``hello_timeout``. On success, mint a
    server-assigned connection-bound ``clientId``, ack it, and return it
    together with the peer's cosmetic label. On any failure close the writer
    WITHOUT echoing a reason — a same-uid prober learns nothing (not even
    whether an extension is attached) — and return None.
    """
    try:
        raw = await asyncio.wait_for(read_frame(reader), timeout=hello_timeout)
    except (asyncio.TimeoutError, FramingError, OSError):
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
    label = sanitise_label((env.body or {}).get("label"))
    # The ack carries the broker's own version and nothing else identifying:
    # the clientId stays internal (it scopes ownership broker-side and never
    # travels to the peer). The version lets a shim warn when it is relaying to
    # a broker running a different build than the session was launched from.
    ack = signer.sign(Envelope(type="hello_ack", body={"version": RUNNING_VERSION}))
    try:
        await write_frame(writer, _dump_json(ack))
    except (OSError, FramingError):
        await _close_quietly(writer)
        return None
    return ClientIdentity(id=client_id, label=label)


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
    identity: ClientIdentity,
) -> None:
    """Run a per-connection MCP server bound to an already-authenticated
    identity until the client disconnects, then release its resources.

    The ``clientId`` is threaded through ``build_server`` into every tool call,
    so each connection's calls are attributable and ownership-scoped (#13); the
    cosmetic label rides along for the extension's audit log. The shared
    ``Bridge`` (single extension WS slot, invariant #8) is untouched; per-client
    lanes keep concurrent clients from racing the one browser."""
    from .mcp_server import build_server

    try:
        server = build_server(bridge, client_id=identity.id, client_label=identity.label)
        async with mcp_socket_streams(reader, writer, signer) as (read_stream, write_stream):
            await server.run(read_stream, write_stream, server.create_initialization_options())
    finally:
        # Release this client's owned tabs (invariant #13): they stay OPEN but
        # become unowned, so the human can use/close them. We do ask the browser
        # to stop DRIVING them (detach the debugger, drop the focus emulation) —
        # otherwise Chrome's "started debugging this browser" bar and the
        # disabled back/forward cache outlive every session that ever ran.
        released = bridge.release_client(identity.id)
        if released:
            await bridge.release_tabs_in_browser(released)
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
    identity = await authenticate_connection(reader, writer, signer, hello_timeout=hello_timeout)
    if identity is None:
        return None
    await _serve_authenticated(reader, writer, bridge, signer, identity)
    return identity.id


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


def broker_lock_path(sock_path: Path) -> Path:
    """Lockfile guarding a broker socket path. Beside the socket (hence beside
    the secret, same 0700 dir), so the uid gate that protects both protects it."""
    return sock_path.with_name(sock_path.name + ".lock")


# Conservative bound on an AF_UNIX path. The kernel's sun_path is 104 bytes on
# macOS / 108 on Linux, and exceeding it fails at bind() with a bare
# "AF_UNIX path too long" from deep inside asyncio. Checked up front so a
# session doesn't spawn a broker that cannot possibly bind and then wait out
# the whole start budget for it.
MAX_SOCKET_PATH_BYTES = 100


def socket_path_is_bindable(path: Path) -> bool:
    return len(str(path).encode("utf-8")) <= MAX_SOCKET_PATH_BYTES


def acquire_file_lock(lock_path: Path) -> int | None:
    """``flock`` a lockfile exclusively, non-blocking. Returns the held fd, or
    None if another live process holds it. The kernel releases the lock when the
    holder dies, so there is no stale-lock state to garbage-collect."""
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    except OSError:
        return None
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    return fd


def acquire_broker_lock(sock_path: Path) -> int | None:
    """Take the exclusive, kernel-backed claim on this broker socket path.

    ``_claim_socket_path`` alone is NOT an exclusion mechanism, only stale-file
    cleanup: ``asyncio.start_unix_server`` unlinks whatever socket file is at the
    path before binding — live or not — so two brokers racing the same path will
    both "succeed", the loser silently stealing the path from a listener that
    keeps running on an unlinked inode. With auto-start that race stops being
    rare (N sessions launching at once), so the claim has to be real.

    ``flock`` is the right primitive here because the kernel drops it when the
    holder dies: there is no stale-lock state to garbage-collect, unlike a pid
    file. The winner keeps the fd for its whole lifetime.

    Returns the held fd, or None if another live process holds the claim.
    """
    return acquire_file_lock(broker_lock_path(sock_path))


def release_broker_lock(fd: int | None) -> None:
    """Drop the claim (also implicit on process death)."""
    if fd is None:
        return
    with contextlib.suppress(OSError):
        fcntl.flock(fd, fcntl.LOCK_UN)
    with contextlib.suppress(OSError):
        os.close(fd)


def socket_identity(path: Path) -> tuple[int, int] | None:
    """``(st_dev, st_ino)`` of the socket file, or None if it is gone."""
    try:
        st = path.stat()
    except OSError:
        return None
    return (st.st_dev, st.st_ino)


def unlink_socket_if_ours(path: Path, identity: tuple[int, int] | None) -> bool:
    """Remove the socket file only if it is still the inode WE bound.

    A bare ``path.unlink()`` at shutdown deletes whatever happens to be at that
    name — which, after a racing broker rebinds the path, is the successor's
    LIVE socket. Every session then finds no socket, spawns another broker, and
    the failure cascades. Compare identity first."""
    if identity is None:
        return False
    if socket_identity(path) != identity:
        return False
    try:
        path.unlink()
    except OSError:
        return False
    return True


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
    state: BrokerState | None = None,
    lock_fd: int | None = None,
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
      can't lock authenticated sessions out (invariant #14, earned-not-grabbed).

    ``lock_fd`` is the claim from :func:`acquire_broker_lock`. Pass the one the
    caller already holds (``__main__`` takes it before the WS port guard so the
    port and the socket are claimed under ONE mutex); if omitted this function
    takes it itself and refuses to bind when another broker holds it."""
    if not socket_path_is_bindable(path):
        # Otherwise this surfaces as a raw "AF_UNIX path too long" OSError out of
        # asyncio, AFTER the WS port is bound and the pidfile written.
        raise BrokerError(f"{path} is too long for an AF_UNIX socket")
    _prepare_socket_dir(path)
    own_lock = False
    if lock_fd is None:
        lock_fd = acquire_broker_lock(path)
        if lock_fd is None:
            raise BrokerError(f"another broker holds the claim on {path}")
        own_lock = True
    try:
        # Now that the claim is ours, any socket file at the path is stale by
        # construction: a live holder could not have released the lock.
        await _claim_socket_path(path)
    except BaseException:
        if own_lock:
            release_broker_lock(lock_fd)
        raise

    st = state if state is not None else BrokerState()

    async def _handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        # No free client slot at all → refuse before auth (no disclosure, no
        # crypto). Bound concurrent half-open handshakes separately.
        if st.active >= max_clients or st.pending >= max_pending:
            await _close_quietly(writer)
            return
        st.pending += 1
        try:
            signer = Signer(secret)
            identity = await authenticate_connection(
                reader, writer, signer, hello_timeout=hello_timeout
            )
        finally:
            st.pending -= 1
        if identity is None:
            return  # auth failed/timed out; authenticate_connection closed it
        if st.active >= max_clients:
            await _close_quietly(writer)  # earned the hello but lost the last slot
            return
        st.active += 1
        st.served_total += 1
        st.writers.add(writer)
        st.note_change()
        try:
            await _serve_authenticated(reader, writer, bridge, signer, identity)
        finally:
            st.active -= 1
            st.writers.discard(writer)
            st.note_change()

    server = await asyncio.start_unix_server(_handler, path=str(path))
    os.chmod(path, 0o600)
    return server


async def close_broker_clients(state: BrokerState) -> None:
    """Close every attached MCP connection.

    Must run BEFORE ``asyncio.Server.wait_closed()``: ``close()`` only stops
    accepting, and from Python 3.12 ``wait_closed()`` waits for established
    connections to finish — with a shim attached that await never returns, so
    the broker would hang before unlinking its socket and clearing its pidfile,
    and further signals would be no-ops (shutdown is already set)."""
    for writer in list(state.writers):
        with contextlib.suppress(Exception):
            writer.close()
    for writer in list(state.writers):
        with contextlib.suppress(Exception):
            await asyncio.wait_for(writer.wait_closed(), timeout=1.0)
    state.writers.clear()


async def call_tool_via_broker(
    path: Path,
    secret: bytes,
    name: str,
    tool_args: dict[str, Any],
    *,
    call_timeout: float = 90.0,
) -> list[dict[str, Any]]:
    """Run ONE tool through a live broker and return its MCP content blocks.

    This is what keeps ``sallyport-daemon exec`` — the documented shell-level
    debugging layer — working now that a broker is normally running. Without it
    `exec` would always try to own the WS port and be refused, i.e. the tool the
    docs point at when a connection won't come up would itself stop working.

    A deliberately minimal MCP client (initialize → initialized → tools/call):
    both ends are ours, one request/response, and pulling in the SDK client
    would buy nothing but a second transport adapter to keep in sync.
    """
    signer = Signer(secret)
    reader, writer = await asyncio.open_unix_connection(str(path))
    try:
        await write_frame(writer, _dump_json(signer.sign(Envelope(type="hello", body={}))))
        ack = await asyncio.wait_for(read_frame(reader), timeout=10.0)
        if ack is None or signer.verify(_parse_json(ack)).type != "hello_ack":
            raise BrokerError("broker refused the handshake")

        async def request(req_id: int, method: str, params: dict[str, Any]) -> dict[str, Any]:
            body = {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}
            await write_frame(writer, _dump_json(signer.sign(Envelope(type="mcp", body=body))))
            deadline = asyncio.get_running_loop().time() + call_timeout
            while True:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise BrokerError(f"broker did not answer {method} within {call_timeout:.0f}s")
                raw = await asyncio.wait_for(read_frame(reader), timeout=remaining)
                if raw is None:
                    raise BrokerError("broker closed mid-request")
                env = signer.verify(_parse_json(raw))
                if env.type != "mcp" or not isinstance(env.body, dict):
                    continue
                if env.body.get("id") != req_id:
                    continue  # a notification or another response
                if "error" in env.body:
                    raise BrokerError(str(env.body["error"]))
                result = env.body.get("result")
                return result if isinstance(result, dict) else {}

        async def notify(method: str) -> None:
            body = {"jsonrpc": "2.0", "method": method, "params": {}}
            await write_frame(writer, _dump_json(signer.sign(Envelope(type="mcp", body=body))))

        await request(
            1,
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "sallyport-exec", "version": "1"},
            },
        )
        await notify("notifications/initialized")
        result = await request(2, "tools/call", {"name": name, "arguments": tool_args})
        content = result.get("content")
        return (
            [item for item in content if isinstance(item, dict)]
            if isinstance(content, list)
            else []
        )
    finally:
        await _close_quietly(writer)


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
    label: str | None = None,
) -> str:
    """Relay one Claude Code stdio MCP session to the broker socket.

    The shim is a transport translator, not an MCP participant: it adds/strips
    the HMAC envelope + length-prefix framing so MCP semantics pass through
    untouched. Claude Code speaks newline-delimited JSON-RPC on
    ``cc_reader``/``cc_writer``; the broker speaks framed ``mcp`` envelopes on
    ``sock_reader``/``sock_writer``. The shim first authenticates to the broker
    (signed hello), then pumps both directions until either side closes.

    ``label`` is this session's cosmetic name (usually its working directory),
    declared in the hello body so a human watching the browser can tell which
    session opened which tab. It is not a credential and grants nothing.

    Returns which side ended the relay: ``"client"`` (Claude Code closed our
    stdin — a normal session end) or ``"broker"`` (the broker went away, which
    the caller must surface: the session is left with no browser tools and
    cannot silently look like a clean exit)."""
    hello_body: dict[str, Any] = {"pid": os.getpid()}
    if label:
        hello_body["label"] = label
    await write_frame(sock_writer, _dump_json(signer.sign(Envelope(type="hello", body=hello_body))))
    try:
        ack = await asyncio.wait_for(read_frame(sock_reader), timeout=hello_timeout)
    except (asyncio.TimeoutError, FramingError, OSError) as exc:
        raise BrokerError("broker handshake failed") from exc
    if ack is None:
        raise BrokerError("broker closed before hello_ack")
    try:
        ack_env = signer.verify(_parse_json(ack))
        if ack_env.type != "hello_ack":
            raise BrokerError("unexpected broker hello response")
    except (ProtocolError, RecursionError) as exc:
        raise BrokerError("broker hello_ack failed verification") from exc
    _warn_on_version_skew((ack_env.body or {}).get("version"))

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
        done, _ = await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
        # Whichever pump ended first tells us who hung up: `up` draining means
        # Claude Code closed our stdin (normal); `down` draining means the
        # broker's socket EOF'd (it died or was killed) and this session now has
        # no browser tools at all.
        # Prefer "broker" when BOTH pumps completed: `pump_up` also breaks on an
        # OSError writing to the broker socket, which is exactly what happens if
        # the broker dies while Claude Code is mid-request — reporting that as a
        # clean client exit is the silent-0 this distinction exists to avoid.
        return "broker" if down in done else "client"
    finally:
        for task in (up, down):
            task.cancel()
        await asyncio.gather(up, down, return_exceptions=True)


def _warn_on_version_skew(broker_version: Any) -> None:
    """Note on stderr when the broker runs a different build than this session.

    An auto-started broker is long-lived by design, so it happily outlives a
    ``pip install -U``: new sessions then attach to the OLD tool catalogue and
    gates with nothing anywhere saying so. Advisory only — the wire protocol is
    versioned separately and unchanged by a patch bump."""
    if not isinstance(broker_version, str) or not broker_version:
        return
    import sys

    mine = RUNNING_VERSION
    if broker_version != mine:
        print(
            f"Sallyport: attached to a broker running {broker_version} while this session is "
            f"{mine} — the broker's build serves every session. Restart it to pick up the new "
            "one: `sallyport-daemon doctor --stop-broker`, then start a fresh session.",
            file=sys.stderr,
        )
