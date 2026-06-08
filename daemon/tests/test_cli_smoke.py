"""Subprocess-based smoke tests for the `sallyport-daemon` console script.

Existing tests call `amain()` directly, which means they pass even if the
`pyproject.toml` entry point is broken or someone renames `main()`. These
tests spawn the actual binary the user would invoke — if any of the
packaging plumbing breaks, they go red.

Kept narrowly-scoped: we only exercise the no-extension paths
(`--show-secret`, `list-tools`, `save_to_file`) so the tests run fast and
need no Chrome.
"""

from __future__ import annotations

import base64
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SALLYPORT_DAEMON = shutil.which("sallyport-daemon")


pytestmark = pytest.mark.skipif(
    SALLYPORT_DAEMON is None,
    reason="sallyport-daemon entry-point not on PATH; run `pip install -e .[dev]`",
)


def _run(
    args: list[str],
    *,
    env: dict[str, str] | None = None,
    timeout: float = 10,
) -> subprocess.CompletedProcess[str]:
    """Run sallyport-daemon with timeout. Inherits the test process env unless
    overridden. Stdin is closed so the (non-daemon) subcommands never hang
    waiting for MCP input."""
    assert SALLYPORT_DAEMON is not None
    full_env = None
    if env is not None:
        import os

        full_env = {**os.environ, **env}
    return subprocess.run(
        [SALLYPORT_DAEMON, *args],
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        timeout=timeout,
        env=full_env,
        check=False,
    )


def test_show_secret_round_trips_base64(tmp_path: Path) -> None:
    """First invocation generates a fresh secret; second invocation reads it
    back. Both must produce valid base64 ≥16 bytes."""
    secret_file = tmp_path / "secret"

    first = _run(["--secret-file", str(secret_file), "--show-secret"])
    assert first.returncode == 0, first.stderr
    raw = base64.b64decode(first.stdout.strip(), validate=True)
    assert len(raw) >= 16

    # File should exist now, second call returns same secret.
    assert secret_file.exists()
    second = _run(["--secret-file", str(secret_file), "--show-secret"])
    assert second.returncode == 0
    assert second.stdout.strip() == first.stdout.strip()


def test_list_tools_includes_all_known_tools(tmp_path: Path) -> None:
    out = _run(["--secret-file", str(tmp_path / "s"), "list-tools"])
    assert out.returncode == 0, out.stderr
    # We don't assert the catalogue is *exactly* this list — that would make
    # this test the bottleneck for adding tools. Just smoke that core ones
    # show up, including the most recently-added local + page tools.
    for tool in ("list_tabs", "navigate", "snapshot", "fetch_in_page", "save_to_file"):
        assert tool in out.stdout, f"{tool!r} missing from list-tools output"


def test_save_to_file_works_end_to_end_without_extension(tmp_path: Path) -> None:
    """The exec path for a local-only tool must not require the extension —
    the local-tool regression test lives here too, but at the CLI level."""
    download_dir = tmp_path / "dl"
    secret_file = tmp_path / "secret"
    payload = base64.b64encode(b"smoke-test").decode()

    out = _run(
        [
            "--secret-file",
            str(secret_file),
            "exec",
            "save_to_file",
            f"data={payload}",
            "filename=hello.bin",
            "--wait",
            "1",  # would hard-fail if exec waited on extension
        ],
        env={"SALLYPORT_DOWNLOAD_DIR": str(download_dir)},
    )
    assert out.returncode == 0, f"stderr: {out.stderr}\nstdout: {out.stdout}"
    parsed = json.loads(out.stdout)
    assert parsed["size"] == 10
    assert (download_dir / "hello.bin").read_bytes() == b"smoke-test"


def test_exec_rejects_traversal_with_exit_5(tmp_path: Path) -> None:
    payload = base64.b64encode(b"x").decode()
    out = _run(
        [
            "--secret-file",
            str(tmp_path / "s"),
            "exec",
            "save_to_file",
            f"data={payload}",
            "filename=../escape.txt",
            "--wait",
            "1",
        ],
        env={"SALLYPORT_DOWNLOAD_DIR": str(tmp_path / "dl")},
    )
    # tool_error path = exit 5 by design (see _run_exec).
    assert out.returncode == 5, f"expected 5, got {out.returncode}; stderr: {out.stderr}"
    assert "unsafe_path" in out.stderr


def test_refuses_to_bind_non_loopback() -> None:
    """The non-loopback guard must short-circuit before the daemon starts."""
    out = _run(["--host", "0.0.0.0", "--show-secret"], timeout=5)  # noqa: S104
    assert out.returncode == 2
    assert "loopback" in out.stderr.lower()


def test_python_dash_m_entrypoint_works(tmp_path: Path) -> None:
    """`python -m sallyport_daemon ...` is an alternative entry that some users
    will hit. Should behave identically to the console-script entry."""
    out = subprocess.run(
        [
            sys.executable,
            "-m",
            "sallyport_daemon",
            "--secret-file",
            str(tmp_path / "s"),
            "--show-secret",
        ],
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        timeout=5,
        check=False,
    )
    assert out.returncode == 0, out.stderr
    base64.b64decode(out.stdout.strip(), validate=True)
