"""Long-lived shared secret between daemon and extension.

Stored at ~/.config/sallyport/secret (chmod 600). First run generates it and
prints the base64 to stderr for the user to paste into the extension popup.
"""

from __future__ import annotations

import base64
import os
import secrets
import stat
from pathlib import Path

SECRET_BYTES = 32
DEFAULT_PATH = Path.home() / ".config" / "sallyport" / "secret"


def load_or_create(path: Path = DEFAULT_PATH) -> tuple[bytes, bool]:
    """Returns (secret_bytes, created_now)."""
    # A symlink at the secret path is never something we created. Reading
    # through it could load an attacker-planted target as the secret, and
    # writing through it (on create) could clobber a file outside our dir.
    # Out of the stated single-user model, but cheap to refuse.
    if path.is_symlink():
        raise RuntimeError(f"secret path {path} is a symlink; refusing to use it")
    if path.exists():
        data = path.read_bytes().strip()
        if not data:
            raise RuntimeError(f"secret file at {path} is empty")
        try:
            secret = base64.b64decode(data, validate=True)
        except Exception as exc:
            raise RuntimeError(f"secret file at {path} is not valid base64: {exc}") from exc
        if len(secret) < 16:
            raise RuntimeError(f"secret file at {path} is too short (< 16 bytes)")
        return secret, False

    # Create the parent 0700 so the secret is never briefly exposed via a
    # group/world-traversable dir. mkdir's mode is masked by umask, so set
    # a tight umask first, then chmod to be certain.
    old_umask = os.umask(0o077)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            path.parent.chmod(0o700)
        except OSError:
            pass
        secret = secrets.token_bytes(SECRET_BYTES)
        b64 = base64.b64encode(secret)
        path.write_bytes(b64)
    finally:
        os.umask(old_umask)
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return secret, True


def encode_b64(secret: bytes) -> str:
    return base64.b64encode(secret).decode("ascii")


def check_perms(path: Path) -> str | None:
    """Return a human warning if the secret file — or its parent directory —
    is readable by anyone other than the owner, else ``None``. Used to nudge
    the user post-load."""
    if os.name != "posix":
        return None
    try:
        mode = stat.S_IMODE(os.stat(path).st_mode)
    except OSError:
        return None
    if mode & 0o077 != 0:
        return f"secret file at {path} has loose permissions ({mode:04o}); run: chmod 600 {path}"
    try:
        dir_mode = stat.S_IMODE(os.stat(path.parent).st_mode)
    except OSError:
        return None
    # Only group/world *write* matters: that lets another user replace the
    # secret file. A merely traversable 0755 dir (the OS default for
    # ~/.config) cannot read the 0600 file inside, so we don't nag about it.
    if dir_mode & 0o022 != 0:
        return (
            f"secret dir {path.parent} is group/world-writable ({dir_mode:04o}); "
            f"run: chmod 700 {path.parent}"
        )
    return None
