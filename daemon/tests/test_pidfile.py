"""Tests for the diagnostic pidfile (`pidfile.py`).

The pidfile exists so `doctor` can name the process holding the port. It is
best-effort by design: every reader must shrug off missing/corrupt files, and
removal must never delete a successor daemon's file.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from sallyport_daemon.pidfile import (
    daemon_version,
    pidfile_path,
    read_pidfile,
    remove_pidfile,
    write_pidfile,
)


def test_pidfile_path_is_per_port(tmp_path: Path) -> None:
    assert pidfile_path(tmp_path, 10086) == tmp_path / "daemon-10086.pid"
    assert pidfile_path(tmp_path, 10086) != pidfile_path(tmp_path, 10087)


def test_write_read_roundtrip(tmp_path: Path) -> None:
    path = pidfile_path(tmp_path, 10086)
    write_pidfile(path, 10086)
    info = read_pidfile(path)
    assert info is not None
    assert info["pid"] == os.getpid()
    assert info["port"] == 10086
    assert isinstance(info["version"], str)
    assert info["version"]
    assert isinstance(info["started_at"], float)


def test_write_creates_missing_parent_dir(tmp_path: Path) -> None:
    path = pidfile_path(tmp_path / "config" / "sallyport", 1)
    write_pidfile(path, 1)
    assert read_pidfile(path) is not None


def test_read_missing_file_returns_none(tmp_path: Path) -> None:
    assert read_pidfile(tmp_path / "nope.pid") is None


def test_read_corrupt_file_returns_none(tmp_path: Path) -> None:
    path = tmp_path / "bad.pid"
    path.write_text("{not json")
    assert read_pidfile(path) is None


def test_read_wrong_shape_returns_none(tmp_path: Path) -> None:
    path = tmp_path / "shape.pid"
    path.write_text(json.dumps([1, 2, 3]))
    assert read_pidfile(path) is None
    path.write_text(json.dumps({"pid": "not-an-int"}))
    assert read_pidfile(path) is None


def test_remove_own_pidfile(tmp_path: Path) -> None:
    path = pidfile_path(tmp_path, 10086)
    write_pidfile(path, 10086)
    remove_pidfile(path)
    assert not path.exists()


def test_remove_leaves_foreign_pidfile(tmp_path: Path) -> None:
    """A daemon that lost the bind race must not delete the pidfile the
    winning daemon (a different PID) wrote for the same port."""
    path = pidfile_path(tmp_path, 10086)
    path.write_text(json.dumps({"pid": os.getpid() + 1, "port": 10086}))
    remove_pidfile(path)
    assert path.exists()


def test_remove_missing_file_is_silent(tmp_path: Path) -> None:
    remove_pidfile(tmp_path / "gone.pid")  # must not raise


def test_daemon_version_returns_string() -> None:
    assert isinstance(daemon_version(), str)
    assert daemon_version()
