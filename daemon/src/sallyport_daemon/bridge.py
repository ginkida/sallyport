"""WebSocket server that the extension connects into.

There is at most one extension client at a time. The MCP side calls
:meth:`Bridge.call_tool` and we route it to whatever extension is currently
attached, awaiting the signed response.
"""

from __future__ import annotations

import asyncio
import logging
import secrets as _secrets
import time
from collections import deque
from pathlib import Path
from typing import Any

import websockets
from websockets.asyncio.server import ServerConnection, serve

from .protocol import Envelope, ProtocolError, Signer
from .scheduling import (
    DEFAULT_MAX_CONCURRENT_CALLS,
    DEFAULT_QUEUE_TIMEOUT_S,
    LaneRegistry,
    PermitPool,
)

log = logging.getLogger("sallyport.ws")


class ExtensionNotConnected(Exception):
    """Raised when a tool call arrives but no extension is connected. Carries a
    stable ``code`` so the MCP layer tags it and appends a recovery hint exactly
    like a ToolError — a looping agent can then branch on ``[not_connected]``
    (poll status, it auto-reconnects) instead of a bare, unclassifiable
    ``Error:`` line that burns the tool timeout."""

    def __init__(self, message: str, *, code: str = "not_connected") -> None:
        super().__init__(message)
        self.code = code


# Tools answered by the daemon itself, before locks and routing. Unlike
# LOCAL_TOOLS (local_tools.py) these need Bridge state, so they live here.
BUILTIN_TOOLS = frozenset({"status"})

# Extension-side housekeeping tool the daemon calls on its own initiative when a
# broker client disconnects. Leading-underscored so it can never collide with a
# real tool name.
RELEASE_TABS_TOOL = "_release_tabs"

# Tool names the DAEMON may send but an MCP client may NOT ask for.
#
# Absence from the MCP catalogue is not a gate: the SDK forwards an unlisted
# tool name to our handler unvalidated, and `call_tool` routes anything that
# isn't a builtin or a local tool straight to the extension. `_release_tabs`
# takes a `tabIds` ARRAY that the ownership gate — which only ever inspects
# `args["tabId"]` — never sees, so a client with one owned tab could name it
# with `tabIds:[1..N]` and detach/unmute/deregister every tab in the profile,
# including other sessions' and the human's. This set is the actual gate: a
# client naming one of these gets `unknown_tool`, exactly as if it did not
# exist, and the daemon's own call path bypasses `call_tool` entirely.
INTERNAL_TOOLS = frozenset({RELEASE_TABS_TOOL})

# Diagnostic last-call ring surfaced via `status`: how many recent calls to
# keep PER CLIENT, and the cap on the echoed error string (mirrors the
# handshake-reason cap). The ring records call OUTCOMES only — tool name, ok,
# ms, code — never the args, which for fill/key_type/send_keys would carry
# credentials.
#
# Per-client, not global: with concurrent lanes a chatty session would evict
# every other session's entries out of one shared 10-slot ring within ten calls,
# so a quiet session's `lastCalls` would be reliably empty and `lastError`
# reliably someone else's. Keying by client also removes the cross-client oracle
# surface outright instead of filtering it out on the way to the caller
# (invariants #13/#14).
LAST_CALLS_MAXLEN = 10
MAX_CALL_ERROR = 200


class ToolError(Exception):
    def __init__(self, message: str, code: str | None = None, detail: Any = None) -> None:
        super().__init__(message)
        self.code = code
        # Optional structured failure metadata forwarded verbatim from the
        # extension's tool_result body (e.g. select_option's available options).
        # Surfaced by the MCP layer as a compact JSON line under the error.
        self.detail = detail


class Bridge:
    """Owns the single extension connection + a queue of pending tool calls."""

    def __init__(
        self,
        secret: bytes,
        host: str,
        port: int,
        request_timeout: float = 60.0,
        hello_timeout: float = 10.0,
        status_path: Path | None = None,
        broker_mode: bool = False,
        max_concurrent_calls: int = DEFAULT_MAX_CONCURRENT_CALLS,
        queue_timeout: float = DEFAULT_QUEUE_TIMEOUT_S,
    ) -> None:
        self._signer = Signer(secret)
        self._host = host
        self._port = port
        # Broker mode (one process, N MCP clients) is signalled to the extension
        # in the hello_ack body so it can enable the broker-only behaviours the
        # daemon gate can't reach: owner-scoping its own list_tabs to
        # agent-created tabs, and the focus-theft mitigation (dedicated window /
        # never foreground a created tab). Standalone leaves all of that off.
        self._broker_mode = broker_mode
        self._request_timeout = request_timeout
        self._hello_timeout = hello_timeout
        self._client: ServerConnection | None = None
        self._client_lock = asyncio.Lock()
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        # req_id -> originating client_id, so `status.pendingCalls` can be
        # owner-scoped in broker mode (a client must not learn another client's
        # in-flight call as an activity oracle). None entries = standalone.
        self._pending_clients: dict[str, str | None] = {}
        self._send_lock = asyncio.Lock()
        # Admission control (see scheduling.py). One serial lane per client
        # keeps a client's own calls ordered — which is what the extension's
        # per-tab state (CDP attachment, `@eN` refs, snapshot object groups)
        # actually needs, since tab ownership is exclusive per client — while
        # DIFFERENT clients run concurrently. The permit pool caps how many
        # calls are on the wire at once. Standalone maps to a single lane, so
        # single-client behaviour is unchanged.
        self._lanes = LaneRegistry()
        self._permits = PermitPool(max_concurrent_calls)
        self._queue_timeout = queue_timeout
        self._started_monotonic = time.monotonic()
        # Diagnostic connection snapshot (see pidfile.write_status). None in
        # short-lived modes (exec / unit tests) — set via set_status_path for
        # long-lived serve / MCP daemons so `doctor` can report live state.
        self._status_path = status_path
        self._client_attached_at: float | None = None
        self._clients_total = 0
        # Connections currently in the pre-auth handshake (≤ hello_timeout each).
        # Bounded by MAX_PENDING_HANDSHAKES so an unauthenticated peer can't flood
        # the accept path and starve the real extension.
        self._pending_handshakes = 0
        self._last_handshake_error: str | None = None
        self._last_handshake_error_at: float | None = None
        # Per-client diagnostic ring of recent tool-call outcomes (no args — see
        # LAST_CALLS_MAXLEN) + that client's most recent failure, surfaced via
        # `status` so a loop can attribute "it just timed out" to a specific
        # tool/code. Keyed by client_id (None = standalone), dropped with the
        # client's lane on disconnect.
        self._last_calls: dict[str | None, deque[dict[str, Any]]] = {}
        self._last_error: dict[str | None, dict[str, Any]] = {}
        # Per-client tab ownership (broker mode, invariant #13). Lazy import to
        # avoid the bridge<->ownership cycle (ownership imports ToolError here).
        # One registry on the shared Bridge serves all broker connections; in
        # standalone mode (client_id=None on every call) it stays empty and inert.
        from .ownership import OwnershipRegistry

        self._ownership = OwnershipRegistry()

    @property
    def connected(self) -> bool:
        # Reflect the WS's real protocol state, not just the Python reference.
        # A half-open / closing socket lingers as a non-None _client until the
        # read loop's finally clears it (and a dead TCP peer isn't noticed until
        # the next ping_timeout). Reading `.state` keeps `status` from lying
        # `connected: true` while the connection is already CLOSING/CLOSED.
        # Compared by name to stay robust across websockets' enum location.
        ws = self._client
        if ws is None:
            return False
        state = getattr(ws, "state", None)
        if state is None:
            return True  # can't introspect — trust the reference
        return getattr(state, "name", None) == "OPEN"

    # 16 MiB: enough for a full-page PNG screenshot at common viewport sizes,
    # plus headroom. Larger frames are rejected by `websockets` automatically
    # with a 1009 close, which is exactly what we want — the offending client
    # gets disconnected and we don't run out of memory holding a hostile blob.
    MAX_FRAME_BYTES = 16 * 1024 * 1024
    # Cap on connections simultaneously in the pre-auth handshake. A legitimate
    # extension holds at most one connection (reconnect closes the old), so this
    # is generous headroom, not a throttle on real use — the WS analogue of the
    # broker's MAX_PENDING_HANDSHAKES (invariant #8: an unauthenticated peer can't
    # deny service to the real extension).
    MAX_PENDING_HANDSHAKES = 32

    async def serve_forever(
        self, *, shutdown: asyncio.Event | None = None, ready: asyncio.Event | None = None
    ) -> None:
        """Run the WS server until cancelled or until ``shutdown`` is set.

        Bound to a loopback address only: anyone with the secret on this
        machine can connect; nobody on the network can even try.

        ``ready`` is set once the listening socket is actually bound. The broker
        waits on it before publishing its own AF_UNIX socket: without that
        signal a broker whose WS bind lost a race would still advertise itself
        and serve sessions whose every tool call fails `not_connected` forever,
        with the bind error sitting unobserved in this task.
        """
        log.info("ws: listening on %s:%d", self._host, self._port)
        async with serve(
            self._handle_client,
            self._host,
            self._port,
            max_size=self.MAX_FRAME_BYTES,
            # ping_interval keeps NAT/proxies awake AND lets us notice a
            # half-open TCP socket within ~40 s instead of waiting for the
            # next user-initiated send.
            ping_interval=20,
            ping_timeout=20,
        ):
            if ready is not None:
                ready.set()
            if shutdown is None:
                await asyncio.Future()
            else:
                await shutdown.wait()
                # Tell the connected client we're going away (gracefully) so
                # they don't pile up reconnect attempts on a dead socket.
                if self._client is not None:
                    try:
                        await self._client.close(code=1001, reason="daemon shutting down")
                    except Exception:  # noqa: BLE001,S110 - best effort on shutdown
                        log.debug("ws: error closing client during shutdown", exc_info=True)

    async def _authenticate_client(self, ws: ServerConnection) -> bool:
        """Pre-slot authentication: refuse browser-page origins, then require a
        valid signed hello within ``hello_timeout``. Returns ``True`` iff the peer
        authenticated; on any failure it closes ``ws`` (no reason echoed to a
        possibly-hostile peer) and returns ``False``. Runs BEFORE the single-client
        slot is claimed, so an unauthenticated peer can neither occupy the slot
        (denying service to the real extension) nor learn whether an extension is
        currently attached."""
        # A web page can open a cross-origin WebSocket to 127.0.0.1 without any
        # special permission. The real extension's service worker sends a
        # chrome-extension:// Origin; non-browser clients send none (and must
        # still pass the signed-hello gate below). Anything else is a browser page
        # and is refused outright.
        origin = ws.request.headers.get("Origin") if ws.request is not None else None
        if origin is not None and not origin.startswith("chrome-extension://"):
            log.warning("ws: rejecting connection with browser-page origin %r", origin)
            self._record_handshake_error(f"rejected browser-page origin: {origin}")
            await ws.close(code=1008, reason="forbidden origin")
            return False
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=self._hello_timeout)
        except (asyncio.TimeoutError, websockets.ConnectionClosed):
            log.warning("ws: closing client that sent no hello within %.0fs", self._hello_timeout)
            self._record_handshake_error(f"no signed hello within {self._hello_timeout:.0f}s")
            await ws.close(code=1008, reason="hello required")
            return False
        try:
            if isinstance(raw, bytes):
                raise ProtocolError("binary frame before hello")
            env = self._signer.verify(self._parse_json(raw))
            if env.type != "hello":
                raise ProtocolError(f"expected hello, got {env.type!r}")
        except (ProtocolError, RecursionError) as exc:
            # RecursionError: a deeply-nested frame can blow the parser /
            # canonicaliser stack — same treatment as any malformed frame.
            # Don't echo the reason to a possibly-attacker peer.
            log.warning("ws: rejecting unauthenticated client: %s", exc)
            self._record_handshake_error(f"authentication failed: {exc}")
            await ws.close(code=1008, reason="authentication failed")
            return False
        return True

    async def _handle_client(self, ws: ServerConnection) -> None:
        # Bound concurrent PRE-AUTH handshakes: refuse before the hello wait / any
        # crypto once too many peers are simultaneously mid-handshake, so an
        # unauthenticated peer can't open many never-hello sockets and starve the
        # real extension's accept path. Check-then-increment is atomic under
        # single-threaded asyncio (no await between), so no lock is needed.
        if self._pending_handshakes >= self.MAX_PENDING_HANDSHAKES:
            log.warning(
                "ws: refusing connection — %d handshakes already pending",
                self._pending_handshakes,
            )
            self._record_handshake_error("too many pending handshakes")
            await ws.close(code=1013, reason="server busy")
            return
        self._pending_handshakes += 1
        try:
            authenticated = await self._authenticate_client(ws)
        finally:
            # Success moves the peer to the single-client slot below; failure
            # closed it; a never-hello peer frees its slot on timeout. Decrement
            # exactly once here so a flood can't permanently wedge the cap.
            self._pending_handshakes -= 1
        if not authenticated:
            return

        # Only one client at a time. If another is already attached, drop the
        # new one — it authenticated, so a 1008 with a reason is fine.
        async with self._client_lock:
            if self._client is not None:
                log.warning("ws: rejecting second client")
                await ws.close(code=1008, reason="another client is already connected")
                return
            self._client = ws
            self._client_attached_at = time.time()
            self._clients_total += 1
            self._write_status()

        log.info("ws: client attached from %s", ws.remote_address)
        try:
            ack = self._signer.sign(Envelope(type="hello_ack", body={"broker": self._broker_mode}))
            await self._send_raw(ws, ack)
            await self._read_loop(ws)
        except websockets.ConnectionClosed:
            log.info("ws: client closed")
        except Exception:
            log.exception("ws: client loop crashed")
        finally:
            async with self._client_lock:
                if self._client is ws:
                    self._client = None
                    self._client_attached_at = None
                    self._write_status()
            # Cancel pending requests so the caller doesn't hang forever.
            for fut in list(self._pending.values()):
                if not fut.done():
                    fut.set_exception(ExtensionNotConnected("extension disconnected mid-request"))
            self._pending.clear()
            self._pending_clients.clear()

    async def _read_loop(self, ws: ServerConnection) -> None:
        async for raw in ws:
            if isinstance(raw, bytes):
                # We only do JSON text.
                log.warning("ws: ignoring binary frame")
                continue
            try:
                env = self._signer.verify(self._parse_json(raw))
            except (ProtocolError, RecursionError) as exc:
                # RecursionError: json.loads (and the canonical encoder)
                # recurse per nesting level, so a few-KiB deeply-nested
                # frame — far under the 16 MiB cap — blows the stack.
                # Skip it like any other bad frame; never tear down the
                # connection. Don't echo the reason to a possibly-attacker
                # peer.
                log.warning("ws: rejected frame: %s", exc)
                continue

            if env.type == "hello":
                # The attach-time hello is consumed by _handle_client; this
                # re-acks a (harmless) mid-session hello.
                ack = self._signer.sign(
                    Envelope(type="hello_ack", body={"broker": self._broker_mode})
                )
                await self._send_raw(ws, ack)
            elif env.type == "ping":
                # The extension pings on a fixed cadence to keep its MV3
                # service worker (and this socket) alive between tool calls.
                # Answer so it gets inbound traffic too and can tell a live
                # daemon from a dead one.
                pong = self._signer.sign(Envelope(type="pong", body={}))
                await self._send_raw(ws, pong)
            elif env.type == "pong":
                pass  # reply to a daemon-initiated ping (none yet; reserved)
            elif env.type == "tool_result":
                if env.id is None:
                    continue
                fut = self._pending.pop(env.id, None)
                # The `not fut.done()` guard is load-bearing: if the call
                # already timed out, `asyncio.wait_for` marked the future
                # done (with a TimeoutError) before `_call_tool_locked`
                # popped it. A late tool_result must NOT call set_result on
                # an already-resolved future — that raises InvalidStateError
                # and crashes the read loop.
                if fut and not fut.done():
                    fut.set_result(env.body or {})
            else:
                log.debug("ws: unhandled type %r", env.type)

    @staticmethod
    def _parse_json(raw: str) -> dict[str, Any]:
        import json

        try:
            parsed = json.loads(raw)
        except (ValueError, RecursionError) as exc:
            # json.JSONDecodeError is a ValueError; deeply-nested JSON
            # raises RecursionError (NOT a ValueError). Surface both as a
            # ProtocolError so the read loop skips the frame instead of
            # tearing down the connection with a traceback.
            raise ProtocolError(f"malformed JSON frame: {type(exc).__name__}") from exc
        if not isinstance(parsed, dict):
            raise ProtocolError("frame is not a JSON object")
        return parsed

    async def _send_raw(self, ws: ServerConnection, env: dict[str, Any]) -> None:
        import json

        async with self._send_lock:
            await ws.send(json.dumps(env, separators=(",", ":")))

    def _status(self, client_id: str | None = None) -> dict[str, Any]:
        """Cheap health snapshot for loop preflight. Exposes no secret
        material — connection state, version, port, queue depth, uptime.

        The diagnostic ring + lastError are stored PER CLIENT, so a session
        reads only its own recent outcomes — never another client's tools,
        codes or server-minted clientId (invariants #13/#14: the diagnostics
        must not become a cross-client activity oracle). Standalone
        (``client_id is None``) is just another key with the same view it
        always had."""
        from .pidfile import daemon_version

        last_calls = list(self._last_calls.get(client_id, ()))
        last_error = self._last_error.get(client_id)
        return {
            "connected": self.connected,
            # Run mode, so an agent knows WHY tabId is required and navigate with
            # no tabId is create-own (broker) vs the active-tab fallback
            # (standalone). Broker-global, not a per-client oracle.
            "mode": "broker" if self._broker_mode else "standalone",
            "version": daemon_version(),
            "port": self._port,
            # Owner-scoped in broker mode: a client sees only its OWN in-flight
            # calls, never another client's — which, now that lanes let several
            # calls be in flight at once, would otherwise be a live read on how
            # busy the other sessions are. Standalone (client_id is None)
            # reports its own lane's count, which is the whole process.
            "pendingCalls": sum(1 for c in self._pending_clients.values() if c == client_id),
            # A CONSTANT — how many calls the browser runs at once across all
            # sessions — so an agent can reason about a `busy` failure. There is
            # deliberately no queue-depth field beside it: a caller that just got
            # `busy` never entered `_pending` (that happens after the permit is
            # taken), and anything counting OTHER clients' waiting calls would be
            # the live cross-session activity oracle `pendingCalls` above avoids.
            "maxConcurrentCalls": self._permits.size,
            "uptimeS": round(time.monotonic() - self._started_monotonic, 1),
            # Recent tool-call outcomes (oldest→newest) + the latest failure, so
            # a loop can attribute a stall to a specific tool/code. Outcomes
            # only — never the args.
            "lastCalls": last_calls,
            "lastError": last_error,
            # Why the extension leg last failed to attach (wrong secret, clock
            # skew >30s, no hello, bad origin) — describes the SHARED extension
            # connection, not any client's activity, so it's safe for every
            # caller. Lets an agent tell "extension rejected / never attached"
            # apart from "attached but slow" when connected is false.
            "lastHandshakeError": self._last_handshake_error,
            "lastHandshakeErrorAt": self._last_handshake_error_at,
        }

    def set_status_path(self, path: Path | None) -> None:
        """Enable the diagnostic status file (long-lived modes only) and write
        an initial snapshot so `doctor` reports state even before a client."""
        self._status_path = path
        self._write_status()

    def _write_status(self) -> None:
        """Persist a connection snapshot for `doctor`. No-op without a path
        (exec / tests). Best-effort: a failed write never affects the bridge."""
        if self._status_path is None:
            return
        from .pidfile import write_status

        write_status(
            self._status_path,
            {
                "connected": self.connected,
                "port": self._port,
                "clientAttachedAt": self._client_attached_at,
                "clientsTotal": self._clients_total,
                "lastHandshakeError": self._last_handshake_error,
                "lastHandshakeErrorAt": self._last_handshake_error_at,
            },
        )

    def _record_handshake_error(self, reason: str) -> None:
        """Note why a peer failed to attach (wrong secret, no hello, bad
        origin) so `doctor` can surface it. The reason is daemon-authored or a
        ProtocolError string — never secret material — but cap it defensively
        since the origin path echoes an attacker-controlled header."""
        self._last_handshake_error = reason[:200]
        self._last_handshake_error_at = time.time()
        self._write_status()

    async def call_tool(
        self,
        name: str,
        args: dict[str, Any],
        client_id: str | None = None,
        client_label: str | None = None,
    ) -> Any:
        # `client_id` identifies the MCP client in broker mode (per-connection,
        # server-minted) and is the scope tab-ownership, scheduling lanes and
        # diagnostics hang on. In single-client/standalone mode it is None and
        # changes nothing. `client_label` is the cosmetic, peer-declared session
        # name forwarded to the extension for the audit log and agent-window
        # grouping — never a gate input (see ownership.CLIENT_LABEL_ARG).
        # Built-ins answer BEFORE the call lock on purpose: `status` exists
        # so a loop iteration can fail fast / report progress even while a
        # slow tool call (e.g. a 30 s embedded wait) holds the lock. It is also
        # deliberately NOT recorded in the last-call ring — it IS the
        # introspection, so logging it would be self-referential noise.
        if name == "status":
            return self._status(client_id)

        # Daemon-only tools are not part of the agent-facing surface at all.
        # Refuse by NAME before anything else looks at the arguments — see
        # INTERNAL_TOOLS for why absence from the catalogue is not enough.
        if name in INTERNAL_TOOLS:
            raise ToolError(f"unknown tool: {name}", code="unknown_tool")

        # Local-only tools run in this process and don't need the extension.
        # Imported lazily to avoid a circular reference (local_tools imports
        # ToolError from this module).
        from .local_tools import LOCAL_TOOLS, POST_CALL_PROCESSORS, PRE_CALL_VALIDATORS
        from .ownership import (
            CLIENT_LABEL_ARG,
            CREATE_CAPABLE,
            ensure_owns,
            record_close,
            record_result,
            scope_list_tabs,
        )

        started = time.monotonic()
        try:
            # LANE FIRST, then the global permit (scheduling.py explains why the
            # reverse order starves). The lane spans the whole
            # ensure_owns → round-trip → record_result sequence, exactly as the
            # old global call lock did, so the ownership check-then-act stays
            # atomic for this client. Cross-client safety comes from the
            # registry's per-client sub-dicts plus single-threaded asyncio.
            async with self._lanes.lane(client_id):
                if name in LOCAL_TOOLS:
                    # Daemon-local tools touch no browser, so they take the lane
                    # (ordering within a client) but never a browser permit —
                    # a `save_to_file` must not consume a slot another session
                    # needs to drive Chrome.
                    result = await LOCAL_TOOLS[name](args)
                else:
                    # Daemon-side pre-call validation (sandbox membership for
                    # `upload`, etc.) runs BEFORE the WS round-trip so both MCP
                    # and `sallyport-daemon exec` get the same authoritative gate.
                    validator = PRE_CALL_VALIDATORS.get(name)
                    if validator is not None:
                        validator(args)
                    # Broker-mode ownership gate (invariant #13): a client may
                    # only act on tabs it created. No-op in standalone
                    # (client_id=None). May raise tab_required/tab_not_owned, and
                    # injects the expected epoch for the extension to confirm.
                    args = ensure_owns(self._ownership, client_id, name, args)
                    if client_label:
                        # Cosmetic session name for the extension's audit log and
                        # agent-window grouping. Stripped extension-side before
                        # the tool body runs, exactly like the epoch.
                        args = {**args, CLIENT_LABEL_ARG: client_label}
                    # Hold a browser permit only across the WS round-trip, not
                    # across the ownership bookkeeping or the post-processor
                    # (which writes files and needs no browser).
                    try:
                        await self._permits.acquire(timeout=self._queue_timeout)
                    except asyncio.TimeoutError as exc:
                        raise ToolError(
                            f"busy: {self._permits.size} browser calls already in flight for "
                            f"{self._queue_timeout:.0f}s — another session is holding the "
                            "browser; nothing was sent, so this is safe to retry",
                            code="busy",
                        ) from exc
                    try:
                        result = await self._call_tool_locked(name, args, client_id)
                    finally:
                        self._permits.release()
                    # Record a freshly-created owned tab, evict a just-closed one,
                    # then owner-scope a list_tabs result (fail-closed) before it
                    # leaves the daemon.
                    record_result(self._ownership, client_id, name, result, opened_at=time.time())
                    if name in CREATE_CAPABLE and isinstance(result, dict) and "epoch" in result:
                        # `epoch` is internal ownership-registry bookkeeping
                        # (invariant #13, confirmed extension-side in
                        # tools.ts:runTool) — record_result just consumed it
                        # above. Strip it so the agent-facing result (and its
                        # MCP schema) doesn't have to explain a field with no
                        # actionable meaning to the caller. Gated on the same
                        # CREATE_CAPABLE set record_result reads from, so an
                        # unrelated future tool that happens to return a field
                        # literally named "epoch" isn't silently stripped too.
                        result = {k: v for k, v in result.items() if k != "epoch"}
                    record_close(self._ownership, client_id, name, args)
                    if name == "list_tabs":
                        result = scope_list_tabs(self._ownership, client_id, result)
                    # Daemon-side post-call processing — print_to_pdf writes its
                    # PDF into the download sandbox here so the base64 payload
                    # never reaches the MCP caller's context. Runs after the
                    # ownership bookkeeping above, in-process.
                    processor = POST_CALL_PROCESSORS.get(name)
                    if processor is not None:
                        result = await processor(args, result)
        except Exception as exc:
            # CancelledError is a BaseException, so a cancelled call is NOT
            # recorded here — only genuinely completed (errored) calls are.
            self._record_call(
                name,
                ok=False,
                ms=round((time.monotonic() - started) * 1000),
                code=getattr(exc, "code", None),
                error=str(exc),
                client_id=client_id,
            )
            raise
        self._record_call(
            name,
            ok=True,
            ms=round((time.monotonic() - started) * 1000),
            code=None,
            error=None,
            client_id=client_id,
        )
        return result

    def release_client(self, client_id: str | None) -> dict[int, str | None]:
        """Release a disconnected broker client's tab ownership (invariant #13).

        Called by the broker when an MCP connection closes. By DEFAULT the tabs
        stay open — they merely become unowned, so the human can use or close
        them — rather than auto-closing work the agent left behind; the
        extension's `closeAgentTabsOnDisconnect` setting (popup, off by default)
        opts into closing them instead. Returns the released tab
        ids so the caller can ask the extension to stop *driving* them (detach
        the debugger, drop the focus emulation); leaving them attached is what
        made Chrome's "started debugging this browser" bar outlive every session
        that ever ran. No-op in standalone (client_id=None), where there is no
        per-client ownership.

        Also drops the per-client scheduling lane and diagnostic ring: broker
        clientIds are minted fresh per connection, so without this both would
        accumulate for the whole (long) life of a broker process."""
        if client_id is None:
            return {}
        owned = self._ownership.release_client(client_id)
        released = {tab_id: tab.epoch for tab_id, tab in owned.items()}
        self._lanes.drop(client_id)
        self._last_calls.pop(client_id, None)
        self._last_error.pop(client_id, None)
        return released

    async def release_tabs_in_browser(self, tabs: dict[int, str | None]) -> None:
        """Ask the extension to stop DRIVING a disconnected client's tabs.

        Fire-and-forget housekeeping, not a gate: it detaches the debugger and
        drops the focus emulation on tabs whose session is gone, so Chrome's
        "started debugging this browser" bar, the disabled back/forward cache
        and the "this tab thinks it is focused" override don't outlive the agent
        that caused them. By DEFAULT the tabs themselves stay open and the human
        decides what to do with them; the extension's
        `closeAgentTabsOnDisconnect` setting (popup, off by default) closes them
        instead — which is why the epoch travels with each id: a close is allowed
        only when it matches. Orphan-don't-close is the DEFAULT, not part of
        invariant #13; do not reason about it as one.

        Goes STRAIGHT to the wire rather than through `call_tool`, which now
        refuses this tool by name (INTERNAL_TOOLS): the agent-facing entry point
        is not a path the daemon's own housekeeping should be able to take
        either, or the refusal would be one `if` away from being bypassable.
        It takes a browser permit like any other call so it cannot jump a
        saturated queue, but no lane — the client it belongs to is gone.

        Every failure is swallowed — the extension may already be gone (a paused
        bridge has no WS client at all), and a disconnect path must never raise
        into the accept loop — but a DROPPED release is logged at warning, not
        debug: it means those tabs keep their debugger session, and the popup's
        sweep is then the only way to tidy them."""
        if not tabs:
            return
        payload = [
            {"tabId": tab_id, **({"epoch": epoch} if epoch is not None else {})}
            for tab_id, epoch in sorted(tabs.items())
        ]
        try:
            await self._permits.acquire(timeout=self._queue_timeout)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            log.warning("ws: no free browser slot to release tabs %s", sorted(tabs))
            return
        try:
            await self._call_tool_locked(RELEASE_TABS_TOOL, {"tabs": payload})
        except Exception:  # noqa: BLE001 - best-effort housekeeping
            log.warning("ws: releasing tabs %s failed", sorted(tabs), exc_info=True)
        finally:
            self._permits.release()

    def _record_call(
        self,
        name: str,
        *,
        ok: bool,
        ms: int,
        code: str | None,
        error: str | None,
        client_id: str | None = None,
    ) -> None:
        """Append a tool-call OUTCOME to the CALLING CLIENT's diagnostic ring
        (and, on failure, set that client's lastError). Records the tool name,
        ok, integer ms and — on failure — the BridgeError code; NEVER the args
        (which for fill/key_type/send_keys carry credentials). The compact ring
        entry omits the error string; the full (capped) message lives only in
        lastError. Rings are per-client so one busy session cannot evict another
        session's diagnostics — and so nothing needs filtering on the way out."""
        entry: dict[str, Any] = {"tool": name, "ok": ok, "ms": ms}
        if not ok and code:
            entry["code"] = code
        ring = self._last_calls.get(client_id)
        if ring is None:
            ring = deque(maxlen=LAST_CALLS_MAXLEN)
            self._last_calls[client_id] = ring
        ring.append(entry)
        if not ok:
            self._last_error[client_id] = {
                "tool": name,
                "code": code,
                "error": (error or "")[:MAX_CALL_ERROR],
            }

    async def _call_tool_locked(
        self, name: str, args: dict[str, Any], client_id: str | None = None
    ) -> Any:
        if self._client is None:
            raise ExtensionNotConnected(
                "extension is not connected — open Chrome and check the Sallyport popup",
                code="not_connected",
            )
        req_id = _secrets.token_hex(8)
        try:
            env = self._signer.sign(
                Envelope(type="tool_call", id=req_id, body={"name": name, "args": args})
            )
        except (ProtocolError, RecursionError) as exc:
            # Arguments the canonical encoding rejects (non-finite floats,
            # precision-losing ints, lone surrogates, absurd nesting) fail
            # fast and legibly instead of surfacing as a baffling timeout.
            raise ToolError(
                f"tool arguments are not wire-serialisable: {exc}", code="bad_args"
            ) from exc
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        self._pending_clients[req_id] = client_id
        try:
            try:
                await self._send_raw(self._client, env)
            except websockets.ConnectionClosed as exc:
                # The extension dropped while we queued on the send lock. Without
                # this the raw ConnectionClosed escapes past _dispatch_call's
                # ExtensionNotConnected/ToolError handlers and reaches the MCP
                # caller as an untagged protocol error with no recovery hint.
                raise ExtensionNotConnected(
                    "extension disconnected mid-request", code="not_connected"
                ) from exc
            try:
                result = await asyncio.wait_for(fut, timeout=self._request_timeout)
            except asyncio.TimeoutError as exc:
                # Deliberately NOT the `timeout` code: that one documents the
                # extension's page-load watchdog and tells the agent a retry is
                # safe. This timeout means the call WAS sent and the extension
                # may still be executing it, so a blind retry can double-act
                # (navigate twice, click twice). Distinct code, distinct hint.
                raise ToolError(
                    f"extension did not reply within {self._request_timeout}s — the call may "
                    "still be running in the browser; read the tab's state before retrying",
                    code="extension_timeout",
                ) from exc
        finally:
            self._pending.pop(req_id, None)
            self._pending_clients.pop(req_id, None)
            # A future the disconnect path already failed (bridge._handle_client
            # sets ExtensionNotConnected on every pending future) would otherwise
            # be garbage-collected with an unretrieved exception, logging a noisy
            # "Future exception was never retrieved" per in-flight call.
            if fut.done() and not fut.cancelled():
                fut.exception()

        if not isinstance(result, dict):
            # A verified-but-malformed tool_result body (truthy non-dict —
            # the extension is expected to send {ok, data|error, code?}).
            # Surface a clean ToolError instead of an AttributeError on
            # result.get(...), which would reach the MCP caller as an
            # opaque crash rather than a tool failure.
            raise ToolError("extension returned a non-object tool_result body", code="bad_args")
        if result.get("ok") is True:
            return result.get("data")
        raise ToolError(
            result.get("error", "unknown error"),
            code=result.get("code"),
            detail=result.get("detail"),
        )
