"""Entry point. Run as `sallyport-daemon` or `python -m sallyport_daemon`.

This is the process Claude Code spawns over stdio. We:
  1. Load or create the shared secret in ~/.config/sallyport/secret.
  2. On first run, print the secret to stderr so the user pastes it into the
     extension popup. (Stdout is reserved for the MCP framing.)
  3. Start a WS server on 127.0.0.1:10086 — extension connects in.
  4. Speak MCP on stdio to Claude Code.

The MCP stdio loop owns the lifecycle: when Claude Code closes our stdin
(EOF on stdio), we gracefully close the WS server and exit zero. Same on
SIGINT/SIGTERM. We never leave the WS task or pending tool calls dangling.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import dataclasses
import ipaddress
import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .bridge import Bridge, ExtensionNotConnected, ToolError
from .broker import (
    BrokerError,
    broker_is_available,
    broker_socket_path,
    run_shim,
    start_broker_server,
)
from .framing import MAX_FRAME_BYTES
from .mcp_server import TOOLS, run_stdio
from .pidfile import (
    pidfile_path,
    read_pidfile,
    read_status,
    remove_pidfile,
    remove_status,
    status_path,
    write_pidfile,
)
from .protocol import Signer
from .secret import DEFAULT_PATH, check_perms, encode_b64, load_or_create

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 10086


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        "sallyport-daemon",
        description=(
            "MCP daemon for Sallyport. Default mode speaks MCP on stdio + WS to "
            "the extension. Subcommands let you operate it without an MCP client."
        ),
    )
    p.add_argument("--host", default=DEFAULT_HOST, help="WS bind address (default 127.0.0.1)")
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help="WS port")
    p.add_argument("--secret-file", default=str(DEFAULT_PATH), help="Path to shared secret file")
    p.add_argument("--show-secret", action="store_true", help="Print secret and exit")
    p.add_argument("--verbose", "-v", action="store_true", help="Verbose logging to stderr")

    sub = p.add_subparsers(dest="command", metavar="COMMAND")

    exec_p = sub.add_parser(
        "exec",
        help="Call one tool and exit (no MCP). Waits for the extension to connect.",
    )
    exec_p.add_argument("tool", help="Tool name, e.g. navigate / snapshot / click")
    exec_p.add_argument(
        "args",
        nargs="*",
        help="Tool args as key=value (e.g. url=https://example.com tabId=7). "
        "Values are parsed as JSON when possible, otherwise as strings.",
    )
    exec_p.add_argument(
        "--wait", type=float, default=10.0, help="Seconds to wait for extension (default 10)"
    )

    sub.add_parser("list-tools", help="Print the catalogue of tools the daemon exposes.")

    doctor_p = sub.add_parser(
        "doctor",
        help=(
            "Diagnose the local setup (Python version, secret file + perms, "
            "port availability) and print the pairing block to paste into the "
            "extension popup. Non-interactive, no MCP — safe to run anywhere."
        ),
    )
    doctor_p.add_argument(
        "--kill-stale",
        action="store_true",
        help=(
            "Before the checks, SIGTERM orphaned sallyport-daemon processes "
            "(parent is PID 1, i.e. the session that spawned them is gone). "
            "Daemons whose parent is alive are listed but left running."
        ),
    )

    sub.add_parser(
        "serve",
        help=(
            "Run only the WS server (no MCP stdio). Stays alive until SIGINT. "
            "Useful for pairing the extension or smoke-testing without Claude Code."
        ),
    )

    sub.add_parser(
        "broker",
        help=(
            "Run a shared broker: one process owns the extension (WS) and serves "
            "many Claude Code sessions over a 0600 AF_UNIX socket. Stays alive "
            "until SIGINT. Plain `sallyport-daemon` sessions auto-attach as shims."
        ),
    )

    return p.parse_args(argv)


def setup_logging(verbose: bool) -> None:
    # All logs to stderr — stdout is the MCP wire.
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def refuse_non_loopback(host: str) -> None:
    # Make it impossible to accidentally expose the bridge.
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        if host == "localhost":
            return
        print(
            f"refusing to bind to {host!r}: only loopback addresses are allowed.",
            file=sys.stderr,
        )
        sys.exit(2)
    if not addr.is_loopback:
        print(
            f"refusing to bind to {host!r}: only loopback addresses are allowed.",
            file=sys.stderr,
        )
        sys.exit(2)


def _install_signal_handlers(shutdown: asyncio.Event) -> None:
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, shutdown.set)
        except NotImplementedError:
            # Windows / odd runtimes: fall back to default handler.
            pass


def _parse_kv(items: list[str]) -> dict[str, object]:
    """Parse `key=value` pairs. Values are JSON when possible (so numbers,
    booleans, and arrays work without quoting tricks), otherwise raw strings."""
    out: dict[str, object] = {}
    for item in items:
        if "=" not in item:
            raise ValueError(f"expected key=value, got: {item!r}")
        k, v = item.split("=", 1)
        try:
            out[k] = json.loads(v)
        except json.JSONDecodeError:
            out[k] = v
    return out


def _probe_bind(host: str, port: int) -> tuple[bool, str]:
    """Check whether ``(host, port)`` is free to bind right now.

    Used by ``doctor`` to turn the most common run-time failure — "address
    already in use" because Claude Code or another ``sallyport-daemon`` already
    holds the port — into an up-front, legible check instead of a stack trace
    at startup. Returns ``(ok, human_message)``.
    """
    import socket as _socket

    try:
        infos = _socket.getaddrinfo(host, port, type=_socket.SOCK_STREAM)
    except _socket.gaierror as exc:
        return False, f"cannot resolve host {host!r}: {exc}"
    family, socktype, proto, _canon, sockaddr = infos[0]
    try:
        with _socket.socket(family, socktype, proto) as s:
            # SO_REUSEADDR lets us ignore lingering TIME_WAIT sockets; an
            # active listener on the port still fails with EADDRINUSE, which
            # is exactly the conflict we want to report.
            s.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 1)
            s.bind(sockaddr)
        return True, f"port {host}:{port} is free to bind"
    except OSError as exc:
        return False, (
            f"cannot bind {host}:{port}: {exc.strerror or exc} — another "
            "sallyport-daemon or a live Claude Code MCP session may already hold "
            "it (single-client invariant); stop it or pass --port"
        )


@dataclasses.dataclass
class ProcInfo:
    """One row of ``ps -o pid=,ppid=,etime=,command=`` output."""

    pid: int
    ppid: int
    etime: str
    command: str

    @property
    def orphaned(self) -> bool:
        # Re-parented to PID 1 (init/launchd): the session that spawned this
        # daemon is gone, so nothing will ever close its stdin or kill it.
        return self.ppid == 1


def parse_ps_line(line: str) -> ProcInfo | None:
    parts = line.split(None, 3)
    if len(parts) < 4:
        return None
    try:
        pid, ppid = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    return ProcInfo(pid=pid, ppid=ppid, etime=parts[2], command=parts[3].strip())


def find_sallyport_processes(ps_output: str, own_pid: int) -> list[ProcInfo]:
    """Filter ``ps -axo pid=,ppid=,etime=,command=`` output down to other
    sallyport-daemon processes (covers both the console script and
    ``python -m sallyport_daemon``). Pure, so it is unit-testable against
    literal ps output."""
    out: list[ProcInfo] = []
    for line in ps_output.splitlines():
        info = parse_ps_line(line)
        if info is None or info.pid == own_pid:
            continue
        if "sallyport-daemon" in info.command or "sallyport_daemon" in info.command:
            out.append(info)
    return out


def _is_broker_command(command: str) -> bool:
    """True if a ps command line invokes the ``broker`` subcommand. A broker is
    user-launched and runs WITHOUT the parent watchdog, so once its shell exits
    it re-parents to PID 1 and looks orphaned — but it is orphan-BY-DESIGN and
    must never be auto-reaped out from under its attached sessions. Matched on a
    standalone ``broker`` argv token (not a substring) so a path component can't
    trip it; conservative — a miss only means we'd decline to auto-kill, never
    that we'd wrongly kill a real broker."""
    return "broker" in command.split()


def _ps_snapshot() -> str:
    """All processes, ``pid ppid etime command`` per line; '' if ps fails
    (Windows, stripped containers) — callers degrade to less detail."""
    try:
        res = subprocess.run(  # noqa: S603 - fixed argv, no user input
            ["ps", "-axo", "pid=,ppid=,etime=,command="],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return res.stdout


def _listening_pids(port: int) -> list[int]:
    """PIDs listening on ``port`` via lsof; [] when lsof is unavailable."""
    try:
        res = subprocess.run(  # noqa: S603 - fixed argv, no user input
            ["lsof", "-nP", f"-tiTCP:{port}", "-sTCP:LISTEN"],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    return [int(tok) for tok in res.stdout.split() if tok.isdigit()]


def _pid_is_broker(pid: int, command: str | None, recorded: dict[str, Any] | None) -> bool:
    """True if this pid is a POSITIVELY-IDENTIFIED broker — its argv carries the
    ``broker`` token, or the port pidfile records ``mode==broker`` for this pid.
    Shared by the port-holder description AND doctor's exit-code decision so the
    two can never disagree about whether a holder is a broker. Conservative: an
    unknown/foreign holder is NOT a broker (so it still fails the port check)."""
    return (command is not None and _is_broker_command(command)) or (
        recorded is not None and recorded.get("pid") == pid and recorded.get("mode") == "broker"
    )


def _port_held_by_broker(port: int, config_dir: Path) -> bool:
    """True when the port is held by a live, positively-identified broker — the
    one holder doctor must NOT flag as a failure, since new sessions auto-attach
    to it as shims. Any unknown/foreign holder returns False (still a failure)."""
    pids = _listening_pids(port)
    if not pids:
        return False
    by_pid = {p.pid: p for p in find_sallyport_processes(_ps_snapshot(), own_pid=-1)}
    recorded = read_pidfile(pidfile_path(config_dir, port))
    return any(
        _pid_is_broker(pid, proc.command if (proc := by_pid.get(pid)) else None, recorded)
        for pid in pids
    )


def _describe_port_holder(port: int, config_dir: Path) -> list[str]:
    """Human lines identifying who holds the port: PID, command, age, and —
    when the holder's pidfile survives — the daemon version it runs. Returns
    [] when nothing could be determined (no lsof, Windows)."""
    pids = _listening_pids(port)
    if not pids:
        return []
    by_pid = {p.pid: p for p in find_sallyport_processes(_ps_snapshot(), own_pid=-1)}
    recorded = read_pidfile(pidfile_path(config_dir, port))
    lines: list[str] = []
    orphan_nonbroker = False
    for pid in pids:
        proc = by_pid.get(pid)
        # A broker is detected either from its command line or its pidfile mode;
        # it is long-lived by design, not a stale orphan to reap.
        is_broker = _pid_is_broker(pid, proc.command if proc else None, recorded)
        bits = [f"port {port} is held by PID {pid}"]
        if recorded and recorded.get("pid") == pid:
            bits.append(f"sallyport {recorded.get('version', '?')}")
            started = recorded.get("started_at")
            if isinstance(started, (int, float)):
                hours = (time.time() - started) / 3600
                bits.append(f"started {hours:.1f}h ago")
        if proc is not None:
            bits.append(f"up {proc.etime}")
            if is_broker:
                bits.append("broker (long-lived by design — shared by multiple sessions)")
            elif proc.orphaned:
                bits.append("ORPHANED (parent died — stale daemon from a dead session)")
                orphan_nonbroker = True
            lines.append("        " + ", ".join(bits) + f" — {proc.command}")
        else:
            if is_broker:
                bits.append("broker (long-lived by design)")
            lines.append("        " + ", ".join(bits))
    if orphan_nonbroker:
        lines.append("        run `sallyport-daemon doctor --kill-stale` to terminate it")
    return lines


def _describe_extension_connection(config_dir: Path, port: int) -> list[str]:
    """Human lines on whether the extension is attached to the running daemon
    right now, read from the status file the daemon keeps. Empty when there is
    no live daemon to ask (no file, or its writer PID is dead — a stale
    snapshot from a daemon that already exited). Turns the most opaque failure
    — "connected: false at tool time" — into an up-front, legible check."""
    data = read_status(status_path(config_dir, port))
    if data is None:
        return []
    pid = data.get("pid")
    if not isinstance(pid, int):
        return []
    # Trust the snapshot only if its writer is the process actually listening on
    # the port — mirrors _describe_port_holder's lsof cross-check. Guards against
    # PID reuse after a crash that skipped remove_status, and against reporting a
    # connection while the port is in fact free. No lsof (Windows / stripped
    # container) → fall back to bare liveness so the feature still works there.
    listeners = _listening_pids(port)
    if listeners:
        if pid not in listeners:
            return []
    elif not _pid_alive(pid):
        return []  # stale snapshot — the daemon that wrote it is gone
    if data.get("connected"):
        attached = data.get("clientAttachedAt")
        since = (
            f" (for {time.time() - attached:.0f}s)" if isinstance(attached, (int, float)) else ""
        )
        return [f"extension: connected{since}"]
    lines = ["extension: NOT connected — open Chrome and check the Sallyport popup"]
    err = data.get("lastHandshakeError")
    at = data.get("lastHandshakeErrorAt")
    if isinstance(err, str) and err:
        ago = f" ({time.time() - at:.0f}s ago)" if isinstance(at, (int, float)) else ""
        lines.append(f"last rejected handshake: {err}{ago}")
    return lines


def _run_kill_stale() -> None:
    """SIGTERM orphaned sallyport-daemon processes (``ProcInfo.orphaned``).

    Daemons whose parent is still alive belong to a live session (Claude
    Code, a `serve` shell) and are deliberately left alone — killing those
    would break someone's working bridge, not clean up after a dead one.
    SIGTERM only: the daemon shuts down cleanly on it; survivors are
    reported, never escalated to SIGKILL automatically.
    """
    ps_out = _ps_snapshot()
    if not ps_out:
        print("  --kill-stale: `ps` unavailable on this platform — nothing scanned")
        return
    procs = find_sallyport_processes(ps_out, own_pid=os.getpid())
    # A broker is orphan-by-design (no parent watchdog) — never auto-reap it.
    brokers = [p for p in procs if _is_broker_command(p.command)]
    rest = [p for p in procs if not _is_broker_command(p.command)]
    stale = [p for p in rest if p.orphaned]
    live = [p for p in rest if not p.orphaned]
    for p in brokers:
        print(
            f"  LEFT  PID {p.pid} (broker — long-lived by design, up {p.etime}); "
            f"stop it explicitly with `kill {p.pid}` if you mean to"
        )
    for p in live:
        print(f"  LEFT  PID {p.pid} (parent {p.ppid} alive — likely a live session), up {p.etime}")
    if not stale:
        print("  --kill-stale: no orphaned sallyport-daemon processes found")
        return
    for p in stale:
        try:
            os.kill(p.pid, signal.SIGTERM)
            print(f"  KILL  PID {p.pid} (orphaned, up {p.etime}) — sent SIGTERM")
        except OSError as exc:
            print(f"  FAIL  PID {p.pid}: {exc}")
    deadline = time.monotonic() + 3.0
    remaining = [p.pid for p in stale]
    while remaining and time.monotonic() < deadline:
        time.sleep(0.1)
        remaining = [pid for pid in remaining if _pid_alive(pid)]
    for pid in remaining:
        print(f"  WARN  PID {pid} ignored SIGTERM — inspect it, then `kill -9 {pid}` if truly dead")
    print()


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True  # exists but not ours (EPERM)
    return True


def _terminate_stale_holder(port: int, config_dir: Path) -> bool:
    """If ``port`` is held by an ORPHANED sallyport daemon (parent died — a dead
    session's leftover), SIGTERM it and wait briefly for it to release the
    socket. Returns True if such a holder was found and signalled (caller should
    re-probe the bind), False if there is nothing safe to evict — port free, held
    by a *live* session (parent alive), or by a non-sallyport process.

    Mirrors ``_run_kill_stale``'s policy: only orphans are touched; a daemon with
    a live parent is someone's working bridge and is never killed automatically.
    """
    pids = _listening_pids(port)
    if not pids:
        return False
    by_pid = {p.pid: p for p in find_sallyport_processes(_ps_snapshot(), own_pid=os.getpid())}
    # An orphaned broker is intentional (long-lived, no parent watchdog) — refuse
    # to reclaim the port from it; the caller then reports it as the live holder.
    stale = [
        pid
        for pid in pids
        if pid in by_pid and by_pid[pid].orphaned and not _is_broker_command(by_pid[pid].command)
    ]
    if not stale:
        return False
    for pid in stale:
        try:
            os.kill(pid, signal.SIGTERM)
            print(
                f"Sallyport: port {port} held by orphaned daemon PID {pid} "
                "(its session is gone) — sent SIGTERM, reclaiming the port.",
                file=sys.stderr,
            )
        except OSError as exc:
            print(f"Sallyport: could not signal stale PID {pid}: {exc}", file=sys.stderr)
    deadline = time.monotonic() + 3.0
    remaining = list(stale)
    while remaining and time.monotonic() < deadline:
        time.sleep(0.1)
        remaining = [pid for pid in remaining if _pid_alive(pid)]
    return True


def ensure_port_available(host: str, port: int, config_dir: Path) -> None:
    """Single-instance guard, run BEFORE binding the WS server.

    Without it, a second daemon spawned while an orphaned one still holds the
    port fails to bind deep inside a fire-and-forget task — after the pidfile is
    already written — and lingers as a zombie fighting for the port (the field
    bug: up to 5 daemons, Connection closed / connected:false). Here we instead:
    reclaim the port from a stale orphan, or refuse to start with a clear message
    naming the holder. ``exit(2)`` on refusal, like ``refuse_non_loopback``.
    """
    ok, _msg = _probe_bind(host, port)
    if ok:
        return
    # Busy. If a stale orphaned sallyport daemon holds it, evict and re-probe.
    if _terminate_stale_holder(port, config_dir):
        ok, _msg = _probe_bind(host, port)
        if ok:
            return
    # Still held — by a live session, a non-sallyport process, or the SIGTERM
    # was ignored. Refuse loudly with the holder's identity instead of spawning
    # a doomed second daemon.
    print(f"Sallyport: refusing to start — {host}:{port} is already in use.", file=sys.stderr)
    for line in _describe_port_holder(port, config_dir):
        print(line.strip(), file=sys.stderr)
    print(
        "Sallyport: stop that daemon, run `sallyport-daemon doctor --kill-stale`, "
        "or start with a different --port.",
        file=sys.stderr,
    )
    sys.exit(2)


async def _watch_parent(
    shutdown: asyncio.Event,
    *,
    interval: float = 5.0,
    getppid: Callable[[], int] = os.getppid,
) -> None:
    """Backstop against orphaned daemons holding the port forever.

    Stdin EOF is the primary shutdown signal in MCP mode, but if the client
    crashes while some other process (a forked child of the client) still
    holds the write end of our stdin pipe, EOF never arrives and the daemon
    outlives its session running stale code (seen in the field: 8 zombies
    after an upgrade). Re-parenting to PID 1 is an unambiguous "our spawner
    is gone" — trigger shutdown on it. Daemons deliberately started under
    init/launchd (initial ppid == 1) are exempt.
    """
    if getppid() == 1:
        return
    while not shutdown.is_set():
        if getppid() == 1:
            print(
                "Sallyport: parent process died (re-parented to PID 1) — shutting down "
                "instead of lingering as an orphan.",
                file=sys.stderr,
            )
            shutdown.set()
            return
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(shutdown.wait(), interval)


def _run_doctor(args: argparse.Namespace, secret: bytes, created: bool, secret_path: Path) -> int:
    """Self-diagnostic for the daemon side of the setup.

    Verifies the four things that actually block a working bridge — Python
    version, secret presence, secret-file permissions, port availability —
    then prints the pairing block and next steps. Stdout only and no MCP, so
    it is always safe to run in a normal shell. Exit 0 if every check passes,
    1 otherwise.
    """
    if getattr(args, "kill_stale", False):
        _run_kill_stale()

    checks: list[tuple[bool, str]] = []

    py = sys.version_info
    py_ok = py >= (3, 10)
    checks.append(
        (
            py_ok,
            f"Python {py.major}.{py.minor}"
            + ("" if py_ok else " is too old — Sallyport needs >= 3.10"),
        )
    )

    # load_or_create (called by amain before us) already validated the secret
    # decodes and is long enough, so reaching here means it's structurally OK.
    checks.append(
        (
            True,
            f"secret {'generated' if created else 'loaded'} at {secret_path} ({len(secret)} bytes)",
        )
    )

    perm_warning = check_perms(secret_path)
    checks.append(
        (
            perm_warning is None,
            perm_warning or "secret file permissions are owner-only (0600)",
        )
    )

    port_ok, port_msg = _probe_bind(args.host, args.port)
    # A live broker legitimately owns the port — new sessions auto-attach to it
    # as shims, so that must NOT read as a failure (doctor would otherwise exit 1
    # on the very multi-session setup broker mode exists for). Only a
    # POSITIVELY-identified broker relaxes the check; an unknown/foreign holder
    # still fails.
    if not port_ok and _port_held_by_broker(args.port, secret_path.parent):
        checks.append(
            (True, f"port {args.port} held by your broker — new sessions auto-attach as shims")
        )
    else:
        checks.append((port_ok, port_msg))

    all_ok = all(ok for ok, _ in checks)
    for ok, msg in checks:
        print(f"  {'OK ' if ok else 'FAIL'}  {msg}")
    if not port_ok:
        # Identify the holder: PID + age + command via lsof/ps, version via
        # the pidfile the daemon writes next to the secret. Best-effort.
        for line in _describe_port_holder(args.port, secret_path.parent):
            print(line)
    # If a daemon is live (its own or another session's), report whether the
    # extension is attached to it and the last rejected handshake — the piece
    # that previously needed the worker console + lsof to diagnose.
    for line in _describe_extension_connection(secret_path.parent, args.port):
        print(f"  {line}")
    print()
    print("Pairing secret — paste this whole block into the extension popup:")
    print()
    print("  " + encode_b64(secret))
    print()
    print("Next steps:")
    print("  1. chrome://extensions -> Load unpacked -> extension/dist (build it first).")
    print("  2. Open the Sallyport popup, paste the block above, click Pair.")
    print("  3. Allowlist tab -> add a domain (every tool rejects URLs until you do).")
    # Resolve an absolute path so a GUI-launched Claude Code (which often lacks
    # ~/.local/bin on PATH) can actually spawn the daemon; fall back to the
    # module form on the current interpreter if the console script isn't found.
    daemon_path = shutil.which("sallyport-daemon")
    if daemon_path:
        print(f"  4. Register with Claude Code:  claude mcp add sallyport {daemon_path}")
    else:
        print(
            "  4. Register with Claude Code:  "
            f"claude mcp add sallyport {sys.executable} -m sallyport_daemon"
        )
    if not all_ok:
        print()
        print("Some checks FAILED — fix the lines above, then re-run: sallyport-daemon doctor")
    return 0 if all_ok else 1


def _run_doctor_secret_error(secret_path: Path, error: str) -> int:
    """Doctor output for the case where the secret file itself is unusable
    (empty, not base64, too short, unreadable). The diagnostic command must
    diagnose this rather than crash on it."""
    print(f"  FAIL  {error}")
    print(f"  FAIL  cannot continue without a valid secret at {secret_path}")
    print()
    print("Fix: delete the file so a fresh 32-byte secret is generated, then")
    print("re-run the check:")
    print(f"    rm {secret_path}")
    print("    sallyport-daemon doctor")
    return 1


async def _run_exec(args: argparse.Namespace, bridge: Bridge, shutdown: asyncio.Event) -> int:
    # Local-only tools (e.g. save_to_file) and daemon built-ins (status)
    # don't need an extension at all, so we skip both the WS server startup
    # and the connect-wait for them.
    from .bridge import BUILTIN_TOOLS
    from .local_tools import LOCAL_TOOLS

    is_local = args.tool in LOCAL_TOOLS or args.tool in BUILTIN_TOOLS

    ws_task: asyncio.Task[None] | None = None
    if not is_local:
        ensure_port_available(args.host, args.port, Path(args.secret_file).parent)
        ws_task = asyncio.create_task(bridge.serve_forever(shutdown=shutdown), name="ws-server")

    try:
        try:
            tool_args = _parse_kv(args.args)
        except ValueError as exc:
            print(f"exec: {exc}", file=sys.stderr)
            return 2

        if not is_local:
            # Poll for the extension to connect. Stay within --wait seconds.
            deadline = asyncio.get_running_loop().time() + args.wait
            while not bridge.connected:
                if asyncio.get_running_loop().time() > deadline:
                    print(
                        f"exec: extension did not connect within {args.wait}s — "
                        f"open Chrome, pair the popup, then retry.",
                        file=sys.stderr,
                    )
                    return 3
                await asyncio.sleep(0.1)

        print(f"exec: calling {args.tool}({tool_args})", file=sys.stderr)
        try:
            result = await bridge.call_tool(args.tool, tool_args)
        except ExtensionNotConnected as exc:
            print(f"exec: {exc}", file=sys.stderr)
            return 4
        except ToolError as exc:
            code = f" [{exc.code}]" if exc.code else ""
            print(f"exec: tool error{code}: {exc}", file=sys.stderr)
            return 5

        # Trim screenshot blobs so the terminal doesn't drown in base64.
        if isinstance(result, dict) and "data" in result and isinstance(result["data"], str):
            d = result["data"]
            if len(d) > 200:
                result = dict(result)
                result["data"] = f"<{len(d)} bytes base64; truncated>"
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    finally:
        shutdown.set()
        if ws_task is not None:
            # Cancel explicitly, then wait briefly. Setting `shutdown` should
            # be enough on its own, but an explicit cancel guarantees the task
            # tears down even if it's wedged past the shutdown signal — we
            # promise (see module docstring) never to leave the WS task
            # dangling. Suppress only the two expected control-flow outcomes;
            # a real exception from the WS task surfaces instead of vanishing.
            ws_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, asyncio.TimeoutError):
                await asyncio.wait_for(ws_task, timeout=2.0)


async def _open_stdio_streams() -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    """Wrap this process's stdin/stdout as asyncio streams for the shim relay.

    Claude Code speaks newline-delimited JSON-RPC over our stdio; the shim needs
    those ends as asyncio streams to pump against the broker socket. We bind the
    binary buffers (``.buffer``) so byte framing stays exact and no text codec
    sits in the path."""
    loop = asyncio.get_running_loop()
    # Match the frame cap (invariant #6), NOT asyncio's 64 KiB default: a single
    # MCP request line can legitimately exceed 64 KiB (a large `evaluate` script,
    # a long `fill`/`send_keys` value). With the default, readline() raises
    # LimitOverrunError mid-relay and the shim would die silently; standalone
    # (the SDK's own stdio reader) has no such cap, so this keeps broker at parity.
    reader = asyncio.StreamReader(limit=MAX_FRAME_BYTES)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    transport, protocol = await loop.connect_write_pipe(
        asyncio.streams.FlowControlMixin, sys.stdout.buffer
    )
    writer = asyncio.StreamWriter(transport, protocol, reader, loop)
    return reader, writer


async def _run_shim(
    secret: bytes,
    sock_reader: asyncio.StreamReader,
    sock_writer: asyncio.StreamWriter,
    shutdown: asyncio.Event,
) -> int:
    """Default-mode shim: relay this stdio MCP session to a running broker.

    Claude Code spawned us expecting a stdio MCP server, but a broker already
    owns the extension (WS) leg and the port — so instead of binding anything we
    translate Claude Code's stdio MCP into the broker's framed/HMAC envelopes and
    back. We hold no port and write no pidfile; the broker is the holder. We run
    until Claude Code closes our stdin or a signal sets ``shutdown``.
    """
    cc_reader, cc_writer = await _open_stdio_streams()
    signer = Signer(secret)
    shim = asyncio.create_task(
        run_shim(cc_reader, cc_writer, sock_reader, sock_writer, signer), name="broker-shim"
    )
    stop = asyncio.create_task(shutdown.wait(), name="shim-shutdown")
    try:
        await asyncio.wait({shim, stop}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        stop.cancel()
        shim.cancel()
        results = await asyncio.gather(shim, stop, return_exceptions=True)
        sock_writer.close()
        with contextlib.suppress(OSError):
            await sock_writer.wait_closed()
    # A broker-handshake failure surfaces as the shim task's stored exception.
    shim_result = results[0]
    if isinstance(shim_result, BrokerError):
        print(f"Sallyport: {shim_result}", file=sys.stderr)
        return 1
    return 0


async def amain(args: argparse.Namespace) -> int:
    # `list-tools` is fully offline — print the catalogue WITHOUT touching the
    # secret file. Generating an HMAC secret as a side effect of a command
    # documented as "no daemon start" would be a surprising credential write.
    if args.command == "list-tools":
        for tool_def in TOOLS:
            first_line = (tool_def.description or "").splitlines()[0]
            print(f"{tool_def.name:<14} {first_line}")
        return 0

    secret_path = Path(args.secret_file)
    try:
        secret, created = load_or_create(secret_path)
    except (RuntimeError, OSError) as secret_exc:
        # A corrupt / empty / unreadable secret file must not dump a
        # traceback. `doctor` turns it into a diagnosable FAIL with
        # remediation; every other command exits cleanly with the reason.
        if args.command == "doctor":
            return _run_doctor_secret_error(secret_path, str(secret_exc))
        print(f"Sallyport: cannot use secret file: {secret_exc}", file=sys.stderr)
        print(
            f"Sallyport: delete {secret_path} to regenerate a fresh one, "
            "or point --secret-file elsewhere.",
            file=sys.stderr,
        )
        return 1

    if args.show_secret:
        print(encode_b64(secret))
        return 0

    if args.command == "doctor":
        # Print our own report rather than the generic created/loaded banner.
        return _run_doctor(args, secret, created, secret_path)

    if created:
        # Loud one-time onboarding banner to stderr. The extension popup
        # auto-extracts the base64 secret from anywhere in the pasted
        # text, so it's fine — encouraged — to copy this whole block.
        print("=" * 70, file=sys.stderr)
        print("Sallyport: new secret generated at", args.secret_file, file=sys.stderr)
        print("Open the extension popup and paste this whole block:", file=sys.stderr)
        print(file=sys.stderr)
        print("  " + encode_b64(secret), file=sys.stderr)
        print(file=sys.stderr)
        print("=" * 70, file=sys.stderr)
    else:
        print(
            f"Sallyport: loaded existing secret from {args.secret_file} "
            f"(use --show-secret to print it again).",
            file=sys.stderr,
        )

    warning = check_perms(secret_path)
    if warning:
        print(f"Sallyport: WARNING: {warning}", file=sys.stderr)

    shutdown = asyncio.Event()
    _install_signal_handlers(shutdown)

    # broker_mode tells the extension (via hello_ack) to enable owner-scoped
    # list_tabs + focus mitigation. Only the `broker` subcommand sets it; serve /
    # exec / standalone default all run single-client with it off.
    bridge = Bridge(
        secret=secret, host=args.host, port=args.port, broker_mode=(args.command == "broker")
    )

    if args.command == "exec":
        return await _run_exec(args, bridge, shutdown)

    # Default mode (no subcommand) auto-attaches to a running broker. If one we
    # own is live on the socket, become a thin stdio shim relaying MCP to it
    # instead of binding the WS port ourselves — this is how N Claude Code
    # sessions share one extension leg. A shim binds nothing and writes no
    # pidfile; the broker is the port holder. `serve`/`broker` are explicit
    # "own the port" commands and never auto-attach.
    if args.command is None:
        sock_path = broker_socket_path(args.port, secret_path.parent)
        if await broker_is_available(sock_path):
            try:
                sock_reader, sock_writer = await asyncio.open_unix_connection(str(sock_path))
            except OSError as connect_exc:
                # TOCTOU: the broker vanished between the probe and our connect.
                # Fall through to standalone so the session still works.
                print(
                    f"Sallyport: broker at {sock_path} went away before connect "
                    f"({connect_exc}); starting a standalone daemon instead.",
                    file=sys.stderr,
                )
            else:
                print(
                    f"Sallyport: attached to broker via {sock_path} (shim mode).",
                    file=sys.stderr,
                )
                return await _run_shim(secret, sock_reader, sock_writer, shutdown)

    # Long-lived modes leave a diagnostic pidfile next to the secret so
    # `doctor` can name the port holder (PID + version + start time), plus a
    # volatile status file so it can also report live extension connectivity.
    pidpath = pidfile_path(secret_path.parent, args.port)
    statuspath = status_path(secret_path.parent, args.port)

    # Single-instance guard BEFORE binding: reclaim the port from a stale orphan
    # or refuse with a clear message, instead of spawning a doomed second daemon
    # that fails to bind deep in an async task and lingers as a zombie.
    ensure_port_available(args.host, args.port, secret_path.parent)

    # Only now that the port is safely ours: enable the status file. Writing it
    # before the guard would let a daemon about to be REFUSED clobber the live
    # holder's snapshot (same ordering rule as write_pidfile below).
    bridge.set_status_path(statuspath)

    if args.command == "serve":
        # WS-only mode: just hold the socket open for the extension. Exits
        # cleanly on SIGINT/SIGTERM (handlers already installed above).
        print(
            f"Sallyport: serve mode — WS on 127.0.0.1:{args.port}, no MCP. Ctrl-C to stop.",
            file=sys.stderr,
        )
        write_pidfile(pidpath, args.port)
        try:
            await bridge.serve_forever(shutdown=shutdown)
        finally:
            remove_pidfile(pidpath)
            remove_status(statuspath)
        return 0

    if args.command == "broker":
        # Broker: own the extension (WS) once, serve many MCP clients over a
        # 0600 AF_UNIX socket. The WS-port single-instance guard + pidfile above
        # apply (the broker IS the port holder); the socket has its own claim in
        # start_broker_server. Runs until SIGINT/SIGTERM. No parent watchdog —
        # the broker is user-launched, not a stdio child of Claude Code.
        sock_path = broker_socket_path(args.port, secret_path.parent)
        # Stamp mode=broker so doctor/--kill-stale recognise an orphan-by-design
        # broker (re-parents to PID 1 when its shell exits) and never reap it.
        write_pidfile(pidpath, args.port, mode="broker")
        ws_task = asyncio.create_task(bridge.serve_forever(shutdown=shutdown), name="ws-server")
        mcp_server: asyncio.Server | None = None
        try:
            try:
                mcp_server = await start_broker_server(bridge, secret, sock_path)
            except BrokerError as broker_exc:
                print(f"Sallyport: cannot start broker socket: {broker_exc}", file=sys.stderr)
                return 1
            print(
                f"Sallyport: broker mode — WS on {args.host}:{args.port}, "
                f"MCP clients via {sock_path}. Ctrl-C to stop.",
                file=sys.stderr,
            )
            await shutdown.wait()
        finally:
            if mcp_server is not None:
                mcp_server.close()
                with contextlib.suppress(Exception):
                    await mcp_server.wait_closed()
                # asyncio's UnixServer.close() does not unlink the socket file;
                # only remove the one WE bound (never a refused peer's).
                with contextlib.suppress(OSError):
                    sock_path.unlink()
            shutdown.set()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(ws_task, timeout=2.0)
            if not ws_task.done():
                ws_task.cancel()
                await asyncio.gather(ws_task, return_exceptions=True)
            remove_pidfile(pidpath)
            remove_status(statuspath)
        return 0

    write_pidfile(pidpath, args.port)
    ws_task = asyncio.create_task(bridge.serve_forever(shutdown=shutdown), name="ws-server")
    mcp_task = asyncio.create_task(run_stdio(bridge), name="mcp-stdio")
    # Watchdog: if Claude Code dies without our stdin reaching EOF (write end
    # inherited by a child that survives the crash), the re-parent check still
    # shuts us down instead of leaving a zombie on the port.
    wd_task = asyncio.create_task(_watch_parent(shutdown), name="parent-watchdog")

    try:
        done, _pending = await asyncio.wait(
            {ws_task, mcp_task}, return_when=asyncio.FIRST_COMPLETED
        )

        # If MCP died (typically: Claude Code closed our stdin), shut down the
        # WS server cleanly so the extension sees a 1001 close and stops
        # reconnecting immediately.
        shutdown.set()

        # Drain whatever's left. The watchdog exits on its own once
        # `shutdown` is set (it waits on the event between polls).
        drain = {t for t in (ws_task, mcp_task, wd_task) if not t.done()}
        if drain:
            try:
                await asyncio.wait_for(asyncio.gather(*drain, return_exceptions=True), timeout=2.0)
            except asyncio.TimeoutError:
                for t in drain:
                    t.cancel()
                await asyncio.gather(*drain, return_exceptions=True)
    finally:
        remove_pidfile(pidpath)
        remove_status(statuspath)

    # Re-raise the first real exception (other than expected cancellation).
    for t in done:
        if t.cancelled():
            continue
        exc = t.exception()
        if exc is not None and not isinstance(exc, asyncio.CancelledError):
            raise exc
    return 0


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    setup_logging(args.verbose)
    refuse_non_loopback(args.host)
    try:
        rc = asyncio.run(amain(args))
    except KeyboardInterrupt:
        rc = 130
    sys.exit(rc)


if __name__ == "__main__":
    main()
