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
import ipaddress
import json
import logging
import signal
import sys
from pathlib import Path

from .bridge import Bridge, ExtensionNotConnected, ToolError
from .mcp_server import TOOLS, run_stdio
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

    sub.add_parser(
        "doctor",
        help=(
            "Diagnose the local setup (Python version, secret file + perms, "
            "port availability) and print the pairing block to paste into the "
            "extension popup. Non-interactive, no MCP — safe to run anywhere."
        ),
    )

    sub.add_parser(
        "serve",
        help=(
            "Run only the WS server (no MCP stdio). Stays alive until SIGINT. "
            "Useful for pairing the extension or smoke-testing without Claude Code."
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


def _run_doctor(
    args: argparse.Namespace, secret: bytes, created: bool, secret_path: Path
) -> int:
    """Self-diagnostic for the daemon side of the setup.

    Verifies the four things that actually block a working bridge — Python
    version, secret presence, secret-file permissions, port availability —
    then prints the pairing block and next steps. Stdout only and no MCP, so
    it is always safe to run in a normal shell. Exit 0 if every check passes,
    1 otherwise.
    """
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
            f"secret {'generated' if created else 'loaded'} at {secret_path} "
            f"({len(secret)} bytes)",
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
    checks.append((port_ok, port_msg))

    all_ok = all(ok for ok, _ in checks)
    for ok, msg in checks:
        print(f"  {'OK ' if ok else 'FAIL'}  {msg}")
    print()
    print("Pairing secret — paste this whole block into the extension popup:")
    print()
    print("  " + encode_b64(secret))
    print()
    print("Next steps:")
    print("  1. chrome://extensions -> Load unpacked -> extension/dist (build it first).")
    print("  2. Open the Sallyport popup, paste the block above, click Pair.")
    print("  3. Allowlist tab -> add a domain (every tool rejects URLs until you do).")
    print("  4. Register with Claude Code:  claude mcp add sallyport sallyport-daemon")
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
    # Local-only tools (e.g. save_to_file) don't need an extension at all,
    # so we skip both the WS server startup and the connect-wait for them.
    from .local_tools import LOCAL_TOOLS

    is_local = args.tool in LOCAL_TOOLS

    ws_task: asyncio.Task[None] | None = None
    if not is_local:
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

    bridge = Bridge(secret=secret, host=args.host, port=args.port)

    if args.command == "exec":
        return await _run_exec(args, bridge, shutdown)

    if args.command == "serve":
        # WS-only mode: just hold the socket open for the extension. Exits
        # cleanly on SIGINT/SIGTERM (handlers already installed above).
        print(
            f"Sallyport: serve mode — WS on 127.0.0.1:{args.port}, no MCP. Ctrl-C to stop.",
            file=sys.stderr,
        )
        await bridge.serve_forever(shutdown=shutdown)
        return 0

    ws_task = asyncio.create_task(bridge.serve_forever(shutdown=shutdown), name="ws-server")
    mcp_task = asyncio.create_task(run_stdio(bridge), name="mcp-stdio")

    done, _pending = await asyncio.wait({ws_task, mcp_task}, return_when=asyncio.FIRST_COMPLETED)

    # If MCP died (typically: Claude Code closed our stdin), shut down the
    # WS server cleanly so the extension sees a 1001 close and stops
    # reconnecting immediately.
    shutdown.set()

    # Drain whatever's left.
    drain = {t for t in (ws_task, mcp_task) if not t.done()}
    if drain:
        try:
            await asyncio.wait_for(asyncio.gather(*drain, return_exceptions=True), timeout=2.0)
        except asyncio.TimeoutError:
            for t in drain:
                t.cancel()
            await asyncio.gather(*drain, return_exceptions=True)

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
