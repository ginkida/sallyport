"""Runtime PID file: lets ``doctor`` identify the process holding the port.

A long-lived daemon (MCP or ``serve`` mode) writes ``daemon-<port>.pid`` next
to the secret file when its WS server comes up and removes it on clean
shutdown. The file is purely diagnostic — nothing reads it on the hot path,
and a leftover from a crash is harmless: readers treat a dead PID as stale.

Alongside it the daemon keeps ``daemon-<port>.status.json``, a *volatile*
snapshot rewritten on every extension connect/disconnect/rejected-handshake,
so ``doctor`` can answer "is the extension attached right now, and if not, why"
without speaking MCP. It never contains secret material.
"""

from __future__ import annotations

import contextlib
import json
import os
import time
from pathlib import Path
from typing import Any


def daemon_version() -> str:
    """Installed package version, best-effort (editable installs included)."""
    try:
        from importlib.metadata import version

        return version("sallyport")
    except Exception:  # noqa: BLE001 - diagnostics must never raise
        return "unknown"


def pidfile_path(config_dir: Path, port: int) -> Path:
    return config_dir / f"daemon-{port}.pid"


def write_pidfile(path: Path, port: int) -> None:
    """Best-effort — a daemon that cannot write its pidfile still runs."""
    info = {
        "pid": os.getpid(),
        "port": port,
        "version": daemon_version(),
        "started_at": time.time(),
    }
    with contextlib.suppress(OSError):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(info))


def remove_pidfile(path: Path) -> None:
    """Remove the pidfile only if it is still ours — a successor daemon on the
    same port may have overwritten it after we lost the bind race."""
    with contextlib.suppress(OSError, ValueError):
        if json.loads(path.read_text()).get("pid") == os.getpid():
            path.unlink()


def read_pidfile(path: Path) -> dict[str, Any] | None:
    """Parsed pidfile contents, or None when missing/corrupt/shape-less."""
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("pid"), int):
        return None
    return data


def status_path(config_dir: Path, port: int) -> Path:
    return config_dir / f"daemon-{port}.status.json"


def write_status(path: Path, info: dict[str, Any]) -> None:
    """Best-effort connection-state snapshot for ``doctor``. Volatile —
    rewritten on every connection change — and may be stale if the daemon died
    mid-write, so readers must verify ``pid`` liveness. Never holds secret
    material. Always stamps the writer's ``pid`` and an ``updatedAt``."""
    payload: dict[str, Any] = {"pid": os.getpid(), "updatedAt": time.time(), **info}
    with contextlib.suppress(OSError):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload))


def read_status(path: Path) -> dict[str, Any] | None:
    """Parsed status snapshot, or None when missing/corrupt/shape-less."""
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("pid"), int):
        return None
    return data


def remove_status(path: Path) -> None:
    """Remove the status file only if it is still ours (mirrors
    :func:`remove_pidfile` — a successor on the same port may own it now)."""
    with contextlib.suppress(OSError, ValueError):
        if json.loads(path.read_text()).get("pid") == os.getpid():
            path.unlink()
