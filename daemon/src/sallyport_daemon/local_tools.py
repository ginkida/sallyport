"""Tools that run entirely in the daemon process (no extension round-trip).

Useful for things that don't need the browser at all — saving a base64 blob
the agent already pulled with `fetch_in_page`, for instance.

Every local tool is a coroutine `(args: dict) -> Any` that either returns a
JSON-serialisable value or raises :class:`ToolError`. Routing lives in
:meth:`Bridge.call_tool`.
"""

from __future__ import annotations

import base64
import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from .bridge import ToolError

DEFAULT_DOWNLOAD_DIR = Path.home() / "Downloads" / "sallyport"


def _resolve_dir() -> Path:
    """Allow override via SALLYPORT_DOWNLOAD_DIR for tests / users on weird OSes."""
    env = os.environ.get("SALLYPORT_DOWNLOAD_DIR")
    return Path(env).expanduser() if env else DEFAULT_DOWNLOAD_DIR


def _sanitise_filename(filename: str) -> str:
    """Reject anything that could escape the sandbox.

    We refuse: empty, leading dot (hidden files), any slash/backslash,
    any '..' segment. The result is a single component that lands inside
    the download directory; nothing else.
    """
    if not filename:
        raise ToolError("save_to_file: filename required", code="bad_args")
    if "\x00" in filename:
        raise ToolError("save_to_file: filename contains null byte", code="unsafe_path")
    if "/" in filename or "\\" in filename:
        raise ToolError(
            f"save_to_file: filename {filename!r} must be a single name, not a path",
            code="unsafe_path",
        )
    if filename in {".", ".."} or filename.startswith("."):
        raise ToolError(
            f"save_to_file: filename {filename!r} starts with a dot (hidden / traversal)",
            code="unsafe_path",
        )
    if len(filename) > 255:
        raise ToolError("save_to_file: filename too long (>255 chars)", code="bad_args")
    return filename


async def save_to_file(args: dict[str, Any]) -> dict[str, Any]:
    """Write a base64-encoded blob to ~/Downloads/sallyport/<filename>.

    Args:
        data: base64 string (required).
        filename: single component, no path separators (required).

    Returns:
        {"path": "/abs/path/to/file", "size": <bytes>}
    """
    data = args.get("data")
    filename = args.get("filename")
    if not isinstance(data, str):
        raise ToolError("save_to_file: data (base64 string) required", code="bad_args")
    if not isinstance(filename, str):
        raise ToolError("save_to_file: filename required", code="bad_args")

    filename = _sanitise_filename(filename)

    try:
        raw = base64.b64decode(data, validate=True)
    except Exception as exc:
        raise ToolError(f"save_to_file: not valid base64: {exc}", code="bad_args") from exc

    download_dir = _resolve_dir()
    # Filesystem failures (read-only volume, permission denied, disk full,
    # name too long for the OS) must surface as a ToolError, not an uncaught
    # OSError — the latter would crash the MCP dispatch loop and leave the
    # caller hanging until its own timeout. Base64 decode above is already
    # guarded the same way; this closes the matching gap on the write path.
    try:
        download_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ToolError(
            f"save_to_file: cannot create download dir {download_dir}: {exc}",
            code="filesystem_error",
        ) from exc
    target = download_dir / filename
    # Defense in depth: resolve() and check it really lives under download_dir.
    resolved = target.resolve()
    sandbox = download_dir.resolve()
    try:
        resolved.relative_to(sandbox)
    except ValueError as exc:
        raise ToolError(
            f"save_to_file: resolved path {resolved} escaped sandbox {sandbox}",
            code="unsafe_path",
        ) from exc

    try:
        resolved.write_bytes(raw)
    except OSError as exc:
        raise ToolError(
            f"save_to_file: write failed ({exc.__class__.__name__}): {exc}",
            code="filesystem_error",
        ) from exc
    return {"path": str(resolved), "size": len(raw)}


def validate_upload_paths(paths: object) -> None:
    """Sandbox check for `upload` paths.

    `upload` hands absolute paths to Chrome's debugger, which then reads
    the files. Without a daemon-side gate, an agent on an allow-listed
    domain could attach `/etc/passwd`, `~/.ssh/id_rsa`, or this very
    secret file to a POST. The extension's `validatePath` only enforces
    syntax (absolute, no `..`); the authoritative sandbox check lives
    here so it also covers `sallyport-daemon exec upload …`.

    Each path must:
      * be a non-empty string;
      * be absolute (POSIX `/…` or Windows drive-letter `X:\\…` / `X:/…`);
      * contain no `..` segments (defence-in-depth even though resolve()
        would normalise them);
      * resolve to a location under :func:`_resolve_dir` — the same
        sandbox that `save_to_file` writes to. `Path.resolve()` follows
        symlinks, so a symlink inside the sandbox pointing at
        `/etc/passwd` is still rejected.

    Typical safe workflow:
        fetch_in_page → save_to_file → upload from ~/Downloads/sallyport/.
    """
    if not isinstance(paths, list) or not paths:
        raise ToolError(
            "upload: paths must be a non-empty list of absolute file paths",
            code="bad_args",
        )
    sandbox = _resolve_dir().resolve()
    for p in paths:
        if not isinstance(p, str) or not p:
            raise ToolError("upload: each path must be a non-empty string", code="bad_args")
        if "\x00" in p:
            # Fast, clear message for the common case. The resolve() catch
            # below also covers it (null byte → ValueError), as it does the
            # lone-surrogate case (→ UnicodeEncodeError, a ValueError subclass).
            raise ToolError("upload: path contains null byte", code="unsafe_path")
        is_posix_abs = p.startswith("/")
        is_win_abs = len(p) >= 3 and p[1] == ":" and p[2] in ("\\", "/")
        if not (is_posix_abs or is_win_abs):
            raise ToolError(f"upload: path must be absolute: {p}", code="bad_args")
        for seg in p.replace("\\", "/").split("/"):
            if seg == "..":
                raise ToolError(f"upload: path contains '..': {p}", code="unsafe_path")
        try:
            resolved = Path(p).resolve(strict=False)
        except (OSError, RuntimeError, ValueError) as exc:
            # ValueError covers an embedded null byte and a lone surrogate
            # (UnicodeEncodeError ⊂ ValueError) — both make resolve() raise
            # outside OSError/RuntimeError and would otherwise escape this
            # validator and crash the MCP dispatch loop. Fail closed instead.
            raise ToolError(
                f"upload: cannot resolve path {p!r}: {type(exc).__name__}", code="unsafe_path"
            ) from exc
        try:
            resolved.relative_to(sandbox)
        except ValueError as exc:
            raise ToolError(
                f"upload: {resolved} is outside the sandbox {sandbox}; "
                f"stage the file via save_to_file (writes to {sandbox}) "
                f"or set SALLYPORT_DOWNLOAD_DIR to widen the sandbox",
                code="unsafe_path",
            ) from exc


# Registry consumed by Bridge.call_tool. Keep the keys identical to the
# MCP tool names so routing is purely a dict lookup.
LOCAL_TOOLS: dict[str, Callable[[dict[str, Any]], Awaitable[Any]]] = {
    "save_to_file": save_to_file,
}


# Per-tool pre-call validators that run on the daemon before forwarding to
# the extension. Keys are MCP tool names. Each validator receives the raw
# `args` dict and raises `ToolError` to abort the call.
PRE_CALL_VALIDATORS: dict[str, Callable[[dict[str, Any]], None]] = {
    "upload": lambda args: validate_upload_paths(args.get("paths")),
}
