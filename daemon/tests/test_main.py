"""Tests for the CLI entry — argument parsing, list-tools, exec mode.

`exec` mode is the developer's local-test path: spin up the daemon, wait for
the extension, fire one tool, exit. We hit every observable: success path
with a fake extension, "no extension" timeout, bad args, and bad tool name.
"""

from __future__ import annotations

import asyncio
import json
import socket

# AsyncIterator no longer used after fixture became sync
from pathlib import Path
from typing import Any

import pytest
import websockets

from sallyport_daemon.__main__ import (
    _parse_kv,
    amain,
    find_sallyport_processes,
    parse_args,
    parse_ps_line,
)
from sallyport_daemon.protocol import Envelope, Signer

# asyncio_mode = "auto" in pyproject already auto-marks async tests — no
# module-level pytestmark is needed (and it would warn on sync tests here).

SECRET = bytes(32)


# ---------------------------------------------------------------------------
# _parse_kv
# ---------------------------------------------------------------------------


def test_parse_kv_strings() -> None:
    out = _parse_kv(["a=hello", "b=world"])
    assert out == {"a": "hello", "b": "world"}


def test_parse_kv_json_values() -> None:
    out = _parse_kv(["n=42", "ok=true", "arr=[1,2,3]", 'obj={"k":"v"}'])
    assert out == {"n": 42, "ok": True, "arr": [1, 2, 3], "obj": {"k": "v"}}


def test_parse_kv_string_fallback_for_unquoted_text() -> None:
    out = _parse_kv(["url=https://example.com"])
    assert out == {"url": "https://example.com"}


def test_parse_kv_value_with_equals_keeps_rest() -> None:
    out = _parse_kv(["q=a=b=c"])
    assert out == {"q": "a=b=c"}


def test_parse_kv_rejects_no_equals() -> None:
    with pytest.raises(ValueError, match="key=value"):
        _parse_kv(["badformat"])


def test_parse_kv_empty_list_returns_empty_dict() -> None:
    assert _parse_kv([]) == {}


# ---------------------------------------------------------------------------
# parse_args / list-tools
# ---------------------------------------------------------------------------


def test_parse_args_exec_minimal() -> None:
    ns = parse_args(["exec", "snapshot"])
    assert ns.command == "exec"
    assert ns.tool == "snapshot"
    assert ns.args == []


def test_parse_args_exec_with_args_and_wait() -> None:
    ns = parse_args(["--port", "9999", "exec", "navigate", "url=x", "--wait", "5"])
    assert ns.port == 9999
    assert ns.command == "exec"
    assert ns.tool == "navigate"
    assert ns.args == ["url=x"]
    assert ns.wait == 5.0


def test_parse_args_list_tools() -> None:
    ns = parse_args(["list-tools"])
    assert ns.command == "list-tools"


def test_parse_args_serve() -> None:
    ns = parse_args(["--port", "9999", "serve"])
    assert ns.command == "serve"
    assert ns.port == 9999


def test_parse_args_doctor() -> None:
    ns = parse_args(["doctor"])
    assert ns.command == "doctor"


def test_refuse_non_loopback_exits() -> None:
    from sallyport_daemon.__main__ import refuse_non_loopback

    # Loopback addresses are allowed and the call returns normally.
    refuse_non_loopback("127.0.0.1")
    refuse_non_loopback("127.0.0.2")
    refuse_non_loopback("::1")
    refuse_non_loopback("localhost")
    # Anything else exits with code 2.
    with pytest.raises(SystemExit) as exc_info:
        refuse_non_loopback("0.0.0.0")  # noqa: S104 - exact case we're refusing
    assert exc_info.value.code == 2
    with pytest.raises(SystemExit):
        refuse_non_loopback("192.168.1.1")
    with pytest.raises(SystemExit):
        refuse_non_loopback("not-a-host")


def test_setup_logging_does_not_crash() -> None:
    from sallyport_daemon.__main__ import setup_logging

    setup_logging(False)
    setup_logging(True)


def test_parse_kv_rejects_other_bad_inputs() -> None:
    """Belt-and-braces around _parse_kv's edge cases."""
    # An empty key still parses as {"": value}, which the schema layer
    # then rejects — _parse_kv itself only enforces the `=` requirement.
    out = _parse_kv(["=value"])
    assert out == {"": "value"}


def test_parse_args_default_no_subcommand() -> None:
    ns = parse_args([])
    assert ns.command is None


async def test_list_tools_prints_each_tool(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    secret_file = tmp_path / "s"
    ns = parse_args(["--secret-file", str(secret_file), "list-tools"])
    rc = await amain(ns)
    assert rc == 0
    out = capsys.readouterr().out
    # Smoke: every tool name in the daemon catalogue appears.
    for name in (
        "list_tabs",
        "navigate",
        "reload",
        "close_tab",
        "snapshot",
        "read_text",
        "click",
        "fill",
        "key_type",
        "send_keys",
        "screenshot",
        "evaluate",
        "fetch_in_page",
        "save_to_file",
    ):
        assert name in out
    # list-tools is fully offline — it must NOT create the HMAC secret as a
    # side effect (regression: it used to generate ~/.config/sallyport/secret
    # silently before printing the catalogue).
    assert not secret_file.exists()


async def test_doctor_reports_ok_and_prints_secret(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    """`doctor` on a clean setup passes every check, returns 0, and prints
    the base64 pairing block plus next-step guidance."""
    port = _free_port()
    ns = parse_args(["--secret-file", str(tmp_path / "s"), "--port", str(port), "doctor"])
    rc = await amain(ns)
    assert rc == 0
    out = capsys.readouterr().out
    assert "Pairing secret" in out
    assert "claude mcp add sallyport" in out
    assert "free to bind" in out
    # The printed block must contain a valid base64 secret of >= 16 bytes.
    import base64
    import contextlib

    found = False
    for line in out.splitlines():
        token = line.strip()
        if not token:
            continue
        with contextlib.suppress(Exception):
            found = len(base64.b64decode(token, validate=True)) >= 16
        if found:
            break
    assert found, "doctor did not print a usable base64 secret"


async def test_doctor_diagnoses_corrupt_secret(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    """An empty/corrupt secret file must be reported by `doctor` as a FAIL
    with remediation — never an uncaught traceback (doctor's whole job is to
    diagnose exactly this)."""
    bad = tmp_path / "secret"
    bad.write_bytes(b"")  # empty → load_or_create raises RuntimeError
    ns = parse_args(["--secret-file", str(bad), "doctor"])
    rc = await amain(ns)
    assert rc == 1
    out = capsys.readouterr().out
    assert "FAIL" in out
    assert "rm " in out  # remediation hint


async def test_bad_secret_exits_cleanly_for_non_doctor(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    """For non-doctor commands that need the secret, a corrupt secret exits 1
    with a clean stderr message instead of a traceback. (``list-tools`` is
    intentionally exempt — it never loads the secret.)"""
    bad = tmp_path / "secret"
    bad.write_bytes(b"not valid base64 @@@")
    ns = parse_args(["--secret-file", str(bad), "serve"])
    rc = await amain(ns)
    assert rc == 1
    err = capsys.readouterr().err
    assert "cannot use secret file" in err


async def test_doctor_flags_port_in_use(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    """If the port is already held, `doctor` fails the bind check and
    returns 1 with an actionable message."""
    # Hold the port for the duration of the check.
    held = socket.socket()
    held.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    held.bind(("127.0.0.1", 0))
    held.listen()
    port = int(held.getsockname()[1])
    try:
        ns = parse_args(["--secret-file", str(tmp_path / "s"), "--port", str(port), "doctor"])
        rc = await amain(ns)
        assert rc == 1
        out = capsys.readouterr().out
        assert "FAIL" in out
        assert "cannot bind" in out
    finally:
        held.close()


async def test_show_secret_prints_and_exits(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    ns = parse_args(["--secret-file", str(tmp_path / "s"), "--show-secret"])
    rc = await amain(ns)
    assert rc == 0
    out = capsys.readouterr().out.strip()
    # First call creates a secret; output is base64 — must round-trip.
    import base64

    decoded = base64.b64decode(out, validate=True)
    assert len(decoded) >= 16


# ---------------------------------------------------------------------------
# exec mode
# ---------------------------------------------------------------------------


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture
def seed_secret(tmp_path: Path) -> Path:
    """Pre-seed the secret file so the test uses our fixed SECRET = 32 zero
    bytes (matches the FakeExtension below)."""
    import base64

    path = tmp_path / "secret"
    path.write_bytes(base64.b64encode(SECRET))
    return path


class _FakeExt:
    def __init__(self, url: str) -> None:
        self.url = url
        self.signer = Signer(SECRET)
        self.ws: Any = None

    async def __aenter__(self) -> _FakeExt:
        self.ws = await websockets.connect(self.url)
        await self._send("hello", {"extensionVersion": "test"})
        ack = await self._recv()
        assert ack.type == "hello_ack"
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.ws.close()

    async def _send(self, type: str, body: Any, id: str | None = None) -> None:
        env = self.signer.sign(Envelope(type=type, body=body, id=id))
        await self.ws.send(json.dumps(env, separators=(",", ":")))

    async def _recv(self) -> Envelope:
        raw = await self.ws.recv()
        if isinstance(raw, bytes):
            raw = raw.decode()
        return self.signer.verify(json.loads(raw))

    async def serve_one_tool(self, response_data: Any) -> Envelope:
        """Receive one tool_call, send a successful tool_result, return the request."""
        req = await self._recv()
        assert req.type == "tool_call"
        await self._send("tool_result", {"ok": True, "data": response_data}, id=req.id)
        return req


async def test_exec_succeeds_when_extension_responds(
    capsys: pytest.CaptureFixture[str], seed_secret: Path
) -> None:
    port = _free_port()
    ns = parse_args(
        [
            "--secret-file",
            str(seed_secret),
            "--port",
            str(port),
            "exec",
            "list_tabs",
            "--wait",
            "3",
        ]
    )
    daemon = asyncio.create_task(amain(ns))

    # Wait for the daemon's WS server to come up, then play the extension.
    for _ in range(50):
        try:
            async with _FakeExt(f"ws://127.0.0.1:{port}/ws") as ext:
                await ext.serve_one_tool({"tabs": [{"tabId": 1, "url": "https://x"}]})
                break
        except (OSError, websockets.InvalidHandshake):
            await asyncio.sleep(0.05)
    else:
        daemon.cancel()
        raise RuntimeError("daemon did not start in time")

    rc = await asyncio.wait_for(daemon, timeout=3.0)
    assert rc == 0
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert payload == {"tabs": [{"tabId": 1, "url": "https://x"}]}


async def test_exec_times_out_when_no_extension(
    capsys: pytest.CaptureFixture[str], seed_secret: Path
) -> None:
    port = _free_port()
    ns = parse_args(
        [
            "--secret-file",
            str(seed_secret),
            "--port",
            str(port),
            "exec",
            "list_tabs",
            "--wait",
            "0.3",
        ]
    )
    rc = await amain(ns)
    assert rc == 3
    err = capsys.readouterr().err
    assert "did not connect" in err


async def test_exec_propagates_tool_error(
    capsys: pytest.CaptureFixture[str], seed_secret: Path
) -> None:
    port = _free_port()
    ns = parse_args(
        [
            "--secret-file",
            str(seed_secret),
            "--port",
            str(port),
            "exec",
            "navigate",
            "url=https://blocked.example",
            "--wait",
            "3",
        ]
    )
    daemon = asyncio.create_task(amain(ns))

    async def play_extension() -> None:
        for _ in range(50):
            try:
                async with _FakeExt(f"ws://127.0.0.1:{port}/ws") as ext:
                    req = await ext._recv()
                    assert req.type == "tool_call"
                    await ext._send(
                        "tool_result",
                        {
                            "ok": False,
                            "error": "blocked.example is not in the allowlist",
                            "code": "domain_not_allowed",
                        },
                        id=req.id,
                    )
                    return
            except (OSError, websockets.InvalidHandshake):
                await asyncio.sleep(0.05)
        raise RuntimeError("daemon did not start")

    await play_extension()
    rc = await asyncio.wait_for(daemon, timeout=3.0)
    assert rc == 5
    err = capsys.readouterr().err
    assert "domain_not_allowed" in err


async def test_serve_runs_ws_without_mcp(
    capsys: pytest.CaptureFixture[str], seed_secret: Path
) -> None:
    """`serve` mode must keep the WS server alive without requiring stdin.

    The MCP daemon mode dies on stdin EOF, which makes long-running use
    awkward. `serve` is the clean way to keep the extension paired without
    Claude Code."""
    port = _free_port()
    ns = parse_args(
        [
            "--secret-file",
            str(seed_secret),
            "--port",
            str(port),
            "serve",
        ]
    )
    daemon = asyncio.create_task(amain(ns))

    # Wait for the WS to come up.
    connected = False
    for _ in range(50):
        try:
            async with _FakeExt(f"ws://127.0.0.1:{port}/ws") as ext:
                # Handshake works → daemon is alive and serving HMAC-authed WS.
                assert ext.signer is not None
                connected = True
                break
        except (OSError, websockets.InvalidHandshake):
            await asyncio.sleep(0.05)
    assert connected, "extension failed to connect to serve mode"

    # The daemon should still be running — cancel it explicitly.
    daemon.cancel()
    import contextlib

    with contextlib.suppress(asyncio.CancelledError, Exception):
        await asyncio.wait_for(daemon, timeout=2.0)

    # Banner went to stderr.
    captured = capsys.readouterr()
    assert "serve mode" in captured.err


async def test_exec_local_tool_runs_without_extension(
    capsys: pytest.CaptureFixture[str],
    seed_secret: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Local-only tools (save_to_file) must not require an extension to
    connect. Regression test for a timing bug where exec mode
    unconditionally waited on bridge.connected even for tools routed
    locally in Bridge.call_tool."""
    monkeypatch.setenv("SALLYPORT_DOWNLOAD_DIR", str(tmp_path))
    port = _free_port()
    import base64 as _b64

    payload = _b64.b64encode(b"hi").decode()
    ns = parse_args(
        [
            "--secret-file",
            str(seed_secret),
            "--port",
            str(port),
            "exec",
            "save_to_file",
            f"data={payload}",
            "filename=local-only.bin",
            "--wait",
            "1",  # extension would have to connect in <1s; it never does here
        ]
    )
    rc = await asyncio.wait_for(amain(ns), timeout=3.0)
    assert rc == 0
    out = capsys.readouterr().out
    payload_out = json.loads(out)
    assert payload_out["size"] == 2
    assert (tmp_path / "local-only.bin").read_bytes() == b"hi"


async def test_exec_truncates_large_blob_in_stdout(
    capsys: pytest.CaptureFixture[str], seed_secret: Path
) -> None:
    """A screenshot can be megabytes of base64. `exec` mode replaces any
    `data` field longer than 200 chars with a `<N bytes base64; truncated>`
    placeholder so the terminal stays readable — the full payload still
    reaches a real MCP client."""
    port = _free_port()
    ns = parse_args(
        [
            "--secret-file",
            str(seed_secret),
            "--port",
            str(port),
            "exec",
            "screenshot",
            "--wait",
            "3",
        ]
    )
    daemon = asyncio.create_task(amain(ns))

    big_blob = "X" * 5000
    for _ in range(50):
        try:
            async with _FakeExt(f"ws://127.0.0.1:{port}/ws") as ext:
                await ext.serve_one_tool({"data": big_blob, "format": "png"})
                break
        except (OSError, websockets.InvalidHandshake):
            await asyncio.sleep(0.05)
    else:
        daemon.cancel()
        raise RuntimeError("daemon did not start in time")

    rc = await asyncio.wait_for(daemon, timeout=3.0)
    assert rc == 0
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert "truncated" in payload["data"]
    assert "5000" in payload["data"]  # the byte-count hint
    assert big_blob not in out  # raw blob is NOT echoed


async def test_exec_rejects_bad_arg_format(
    capsys: pytest.CaptureFixture[str], seed_secret: Path
) -> None:
    port = _free_port()
    ns = parse_args(
        [
            "--secret-file",
            str(seed_secret),
            "--port",
            str(port),
            "exec",
            "navigate",
            "this-has-no-equals",
            "--wait",
            "0.3",
        ]
    )
    rc = await amain(ns)
    assert rc == 2
    err = capsys.readouterr().err
    assert "key=value" in err


# ---------------------------------------------------------------------------
# zombie-daemon diagnostics: ps parsing, port-holder report, kill-stale,
# parent watchdog
# ---------------------------------------------------------------------------


def test_parse_args_doctor_kill_stale() -> None:
    assert parse_args(["doctor"]).kill_stale is False
    assert parse_args(["doctor", "--kill-stale"]).kill_stale is True


def test_parse_ps_line_valid() -> None:
    info = parse_ps_line("  123   456  02-03:04:05 /usr/bin/sallyport-daemon --port 10086")
    assert info is not None
    assert info.pid == 123
    assert info.ppid == 456
    assert info.etime == "02-03:04:05"
    assert info.command == "/usr/bin/sallyport-daemon --port 10086"
    assert info.orphaned is False


def test_parse_ps_line_orphan() -> None:
    info = parse_ps_line("99 1 01:02 sallyport-daemon")
    assert info is not None
    assert info.orphaned is True


def test_parse_ps_line_garbage() -> None:
    assert parse_ps_line("") is None
    assert parse_ps_line("too few") is None
    assert parse_ps_line("notanint 1 01:02 cmd") is None
    assert parse_ps_line("1 notanint 01:02 cmd") is None


PS_OUTPUT = """\
  100     1  03:00:00 /opt/venv/bin/sallyport-daemon
  200   150  00:05:00 /opt/venv/bin/python -m sallyport_daemon serve
  300     1  10:00:00 /usr/bin/some-other-tool
  400   399  00:00:01 grep sallyport-daemon-lookalike-but-own-pid
"""


def test_find_sallyport_processes_filters() -> None:
    procs = find_sallyport_processes(PS_OUTPUT, own_pid=400)
    assert [p.pid for p in procs] == [100, 200]
    assert [p.orphaned for p in procs] == [True, False]


def test_find_sallyport_processes_excludes_self() -> None:
    procs = find_sallyport_processes(PS_OUTPUT, own_pid=100)
    assert [p.pid for p in procs] == [200, 400]


def test_describe_port_holder_names_pid_version_and_age(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """When lsof/ps/pidfile all cooperate, the report carries PID, version,
    start age, uptime, and the ORPHANED marker with the kill-stale hint."""
    import time as _time

    import sallyport_daemon.__main__ as m

    monkeypatch.setattr(m, "_listening_pids", lambda port: [100])
    monkeypatch.setattr(
        m,
        "_ps_snapshot",
        lambda: "100 1 03:00:00 /opt/venv/bin/sallyport-daemon\n",
    )
    pidfile = tmp_path / "daemon-10086.pid"
    pidfile.write_text(
        json.dumps(
            {
                "pid": 100,
                "port": 10086,
                "version": "0.3.2",
                "started_at": _time.time() - 7200,
            }
        )
    )
    lines = m._describe_port_holder(10086, tmp_path)
    text = "\n".join(lines)
    assert "PID 100" in text
    assert "sallyport 0.3.2" in text
    assert "started 2.0h ago" in text
    assert "up 03:00:00" in text
    assert "ORPHANED" in text
    assert "--kill-stale" in text


def test_describe_port_holder_degrades_without_ps_match(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A holder that isn't a sallyport process (or ps failed) still gets a
    PID line; no orphan hint is invented."""
    import sallyport_daemon.__main__ as m

    monkeypatch.setattr(m, "_listening_pids", lambda port: [555])
    monkeypatch.setattr(m, "_ps_snapshot", lambda: "")
    lines = m._describe_port_holder(10086, tmp_path)
    assert any("PID 555" in line for line in lines)
    assert not any("--kill-stale" in line for line in lines)


def test_describe_port_holder_empty_without_lsof(monkeypatch: pytest.MonkeyPatch) -> None:
    import sallyport_daemon.__main__ as m

    monkeypatch.setattr(m, "_listening_pids", lambda port: [])
    assert m._describe_port_holder(10086, Path("/nonexistent")) == []


def test_kill_stale_terminates_only_orphans(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """SIGTERM goes to orphaned daemons only; live-session daemons are listed
    and left alone."""
    import signal as _signal

    import sallyport_daemon.__main__ as m

    killed: list[tuple[int, int]] = []
    monkeypatch.setattr(m, "_ps_snapshot", lambda: PS_OUTPUT)
    monkeypatch.setattr(m.os, "getpid", lambda: 400)
    monkeypatch.setattr(m.os, "kill", lambda pid, sig: killed.append((pid, sig)))
    monkeypatch.setattr(m, "_pid_alive", lambda pid: False)
    m._run_kill_stale()
    out = capsys.readouterr().out
    assert killed == [(100, _signal.SIGTERM)]
    assert "KILL  PID 100" in out
    assert "LEFT  PID 200" in out
    assert "WARN" not in out


def test_kill_stale_reports_survivors(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import sallyport_daemon.__main__ as m

    monkeypatch.setattr(m, "_ps_snapshot", lambda: "100 1 03:00:00 sallyport-daemon\n")
    monkeypatch.setattr(m.os, "getpid", lambda: 400)
    monkeypatch.setattr(m.os, "kill", lambda pid, sig: None)
    monkeypatch.setattr(m, "_pid_alive", lambda pid: True)
    monkeypatch.setattr(m.time, "monotonic", _FakeMonotonic())
    m._run_kill_stale()
    out = capsys.readouterr().out
    assert "WARN  PID 100 ignored SIGTERM" in out


class _FakeMonotonic:
    """Advances one second per call so the SIGTERM-wait loop exits at once."""

    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        self.t += 1.0
        return self.t


def test_kill_stale_without_ps(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import sallyport_daemon.__main__ as m

    monkeypatch.setattr(m, "_ps_snapshot", lambda: "")
    m._run_kill_stale()
    assert "nothing scanned" in capsys.readouterr().out


async def test_watch_parent_triggers_on_reparent() -> None:
    """When the parent dies (getppid flips to 1), the watchdog sets the
    shutdown event and exits."""
    from sallyport_daemon.__main__ import _watch_parent

    shutdown = asyncio.Event()
    calls = {"n": 0}

    def fake_getppid() -> int:
        calls["n"] += 1
        return 1 if calls["n"] >= 3 else 4242

    await asyncio.wait_for(
        _watch_parent(shutdown, interval=0.01, getppid=fake_getppid), timeout=5.0
    )
    assert shutdown.is_set()


async def test_watch_parent_exempt_when_started_under_init() -> None:
    """A daemon deliberately started under init/launchd (initial ppid == 1)
    must not immediately shut itself down."""
    from sallyport_daemon.__main__ import _watch_parent

    shutdown = asyncio.Event()
    await asyncio.wait_for(_watch_parent(shutdown, interval=0.01, getppid=lambda: 1), timeout=5.0)
    assert not shutdown.is_set()


async def test_watch_parent_exits_on_shutdown() -> None:
    """The watchdog ends promptly when shutdown is set by someone else —
    it must not keep the drain phase waiting."""
    from sallyport_daemon.__main__ import _watch_parent

    shutdown = asyncio.Event()
    task = asyncio.create_task(_watch_parent(shutdown, interval=30.0, getppid=lambda: 4242))
    await asyncio.sleep(0.05)
    shutdown.set()
    await asyncio.wait_for(task, timeout=5.0)
    assert not task.cancelled()


# --- ensure_port_available: single-instance startup guard --------------------


def test_ensure_port_available_passes_when_free(monkeypatch: pytest.MonkeyPatch) -> None:
    import sallyport_daemon.__main__ as m

    monkeypatch.setattr(m, "_probe_bind", lambda host, port: (True, "free"))
    m.ensure_port_available("127.0.0.1", 10086, Path("/nonexistent"))  # no exit, no raise


def test_ensure_port_available_evicts_stale_orphan(monkeypatch: pytest.MonkeyPatch) -> None:
    """A port held by an ORPHANED sallyport daemon is reclaimed (SIGTERM); the
    re-probe then succeeds and startup proceeds."""
    import signal as _signal

    import sallyport_daemon.__main__ as m

    probes = {"n": 0}

    def fake_probe(host: str, port: int) -> tuple[bool, str]:
        probes["n"] += 1
        return (probes["n"] > 1, "")  # busy first, free after eviction

    killed: list[tuple[int, int]] = []
    monkeypatch.setattr(m, "_probe_bind", fake_probe)
    monkeypatch.setattr(m, "_listening_pids", lambda port: [100])
    monkeypatch.setattr(m, "_ps_snapshot", lambda: "100 1 03:00:00 sallyport-daemon\n")
    monkeypatch.setattr(m.os, "getpid", lambda: 999)
    monkeypatch.setattr(m.os, "kill", lambda pid, sig: killed.append((pid, sig)))
    monkeypatch.setattr(m, "_pid_alive", lambda pid: False)
    monkeypatch.setattr(m.time, "sleep", lambda *a: None)

    m.ensure_port_available("127.0.0.1", 10086, Path("/nonexistent"))
    assert killed == [(100, _signal.SIGTERM)]
    assert probes["n"] == 2  # re-probed after the eviction


def test_ensure_port_available_refuses_live_holder(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A port held by a LIVE-session daemon (parent alive) is never auto-killed;
    the guard refuses with a clear message naming the holder and exits 2."""
    import sallyport_daemon.__main__ as m

    killed: list[tuple[int, int]] = []
    monkeypatch.setattr(m, "_probe_bind", lambda host, port: (False, "busy"))
    monkeypatch.setattr(m, "_listening_pids", lambda port: [200])
    monkeypatch.setattr(m, "_ps_snapshot", lambda: "200 150 00:05:00 sallyport-daemon serve\n")
    monkeypatch.setattr(m.os, "getpid", lambda: 999)
    monkeypatch.setattr(m.os, "kill", lambda pid, sig: killed.append((pid, sig)))

    with pytest.raises(SystemExit) as exc:
        m.ensure_port_available("127.0.0.1", 10086, Path("/nonexistent"))
    assert exc.value.code == 2
    assert killed == []  # a live daemon is someone's working bridge — left alone
    err = capsys.readouterr().err
    assert "already in use" in err
    assert "PID 200" in err


def test_ensure_port_available_refuses_non_sallyport_holder(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A non-sallyport process on the port is reported and refused, never killed."""
    import sallyport_daemon.__main__ as m

    killed: list[tuple[int, int]] = []
    monkeypatch.setattr(m, "_probe_bind", lambda host, port: (False, "busy"))
    monkeypatch.setattr(m, "_listening_pids", lambda port: [777])
    monkeypatch.setattr(m, "_ps_snapshot", lambda: "777 1 01:00 some-other-server\n")
    monkeypatch.setattr(m.os, "getpid", lambda: 999)
    monkeypatch.setattr(m.os, "kill", lambda pid, sig: killed.append((pid, sig)))

    with pytest.raises(SystemExit) as exc:
        m.ensure_port_available("127.0.0.1", 10086, Path("/nonexistent"))
    assert exc.value.code == 2
    assert killed == []
