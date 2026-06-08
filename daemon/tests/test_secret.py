"""Tests for the shared-secret on-disk file: generation, persistence, perms."""

from __future__ import annotations

import base64
import os
import stat
from pathlib import Path

import pytest

from sallyport_daemon.secret import SECRET_BYTES, encode_b64, load_or_create


def test_create_generates_random_bytes(tmp_path: Path) -> None:
    secret, created = load_or_create(tmp_path / "secret")
    assert created is True
    assert len(secret) == SECRET_BYTES
    # Highly improbable for a CSPRNG to return all zeros.
    assert secret != b"\x00" * SECRET_BYTES


def test_create_writes_base64(tmp_path: Path) -> None:
    path = tmp_path / "secret"
    secret, _ = load_or_create(path)
    on_disk = path.read_bytes().strip()
    decoded = base64.b64decode(on_disk, validate=True)
    assert decoded == secret


def test_load_existing_returns_same_bytes(tmp_path: Path) -> None:
    path = tmp_path / "secret"
    secret1, created1 = load_or_create(path)
    assert created1 is True
    secret2, created2 = load_or_create(path)
    assert created2 is False
    assert secret1 == secret2


def test_created_file_is_chmod_600(tmp_path: Path) -> None:
    path = tmp_path / "secret"
    load_or_create(path)
    mode = stat.S_IMODE(os.stat(path).st_mode)
    # On most filesystems we get exactly 0o600. On a few (mounted with relaxed
    # perms — eg. NTFS) we may not — accept anything tight enough.
    assert mode & 0o077 == 0, f"too-loose perms: {mode:o}"


def test_load_rejects_empty_file(tmp_path: Path) -> None:
    path = tmp_path / "secret"
    path.write_bytes(b"")
    with pytest.raises(RuntimeError, match="empty"):
        load_or_create(path)


def test_load_rejects_non_base64(tmp_path: Path) -> None:
    path = tmp_path / "secret"
    path.write_bytes(b"!!! definitely not base64 !!!")
    with pytest.raises(RuntimeError, match="base64"):
        load_or_create(path)


def test_load_rejects_short_secret(tmp_path: Path) -> None:
    path = tmp_path / "secret"
    path.write_bytes(base64.b64encode(b"\x00" * 8))
    with pytest.raises(RuntimeError, match="too short"):
        load_or_create(path)


def test_encode_b64_roundtrip() -> None:
    secret = bytes.fromhex("ab" * 32)
    b64 = encode_b64(secret)
    assert base64.b64decode(b64) == secret


def test_load_creates_parent_directory(tmp_path: Path) -> None:
    nested = tmp_path / "a" / "b" / "c" / "secret"
    load_or_create(nested)
    assert nested.exists()


@pytest.mark.skipif(os.name != "posix", reason="dir perms are POSIX-only")
def test_created_parent_dir_is_0700(tmp_path: Path) -> None:
    nested = tmp_path / "fresh" / "secret"
    load_or_create(nested)
    mode = stat.S_IMODE(os.stat(nested.parent).st_mode)
    assert mode == 0o700, f"parent dir mode {mode:04o} is not 0700"


def test_rejects_symlinked_secret_path(tmp_path: Path) -> None:
    real = tmp_path / "elsewhere"
    real.write_bytes(base64.b64encode(b"\x00" * 32))
    link = tmp_path / "secret"
    link.symlink_to(real)
    with pytest.raises(RuntimeError, match="symlink"):
        load_or_create(link)


# ---------------------------------------------------------------------------
# check_perms
# ---------------------------------------------------------------------------


def test_check_perms_returns_none_for_tight_file(tmp_path: Path) -> None:
    from sallyport_daemon.secret import check_perms

    path = tmp_path / "secret"
    load_or_create(path)
    # `load_or_create` chmods 600 — should be tight.
    assert check_perms(path) is None


def test_check_perms_warns_about_loose_file(tmp_path: Path) -> None:
    from sallyport_daemon.secret import check_perms

    path = tmp_path / "secret"
    load_or_create(path)
    os.chmod(path, 0o644)
    warning = check_perms(path)
    assert warning is not None
    assert "loose permissions" in warning
    assert "chmod 600" in warning


@pytest.mark.skipif(os.name != "posix", reason="dir perms are POSIX-only")
def test_check_perms_warns_about_writable_dir(tmp_path: Path) -> None:
    from sallyport_daemon.secret import check_perms

    path = tmp_path / "secret"
    load_or_create(path)
    # File stays tight (0600), but the parent dir becomes group/world-WRITABLE
    # (an attacker could replace the secret). That is what must warn.
    os.chmod(path.parent, 0o777)  # noqa: S103 - deliberately loosening to test the warning
    warning = check_perms(path)
    assert warning is not None
    assert "secret dir" in warning
    assert "writable" in warning
    assert "chmod 700" in warning


@pytest.mark.skipif(os.name != "posix", reason="dir perms are POSIX-only")
def test_check_perms_silent_on_traversable_but_unwritable_dir(tmp_path: Path) -> None:
    """A 0755 dir (OS default for ~/.config) with a 0600 secret inside is
    safe — traverse-only can't read the file — so doctor must not FAIL on it."""
    from sallyport_daemon.secret import check_perms

    path = tmp_path / "secret"
    load_or_create(path)
    os.chmod(path.parent, 0o755)  # noqa: S103 - the safe-but-traversable case
    assert check_perms(path) is None
