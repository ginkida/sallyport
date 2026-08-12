"""Tools that run entirely in the daemon process (no extension round-trip).

Useful for things that don't need the browser at all — saving a base64 blob
the agent already pulled with `fetch_in_page`, for instance.

Every local tool is a coroutine `(args: dict) -> Any` that either returns a
JSON-serialisable value or raises :class:`ToolError`. Routing lives in
:meth:`Bridge.call_tool`.
"""

from __future__ import annotations

import asyncio
import base64
import os
import secrets as _secrets
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .bridge import ToolError

DEFAULT_DOWNLOAD_DIR = Path.home() / "Downloads" / "sallyport"


def _resolve_dir() -> Path:
    """Allow override via SALLYPORT_DOWNLOAD_DIR for tests / users on weird OSes."""
    env = os.environ.get("SALLYPORT_DOWNLOAD_DIR")
    return Path(env).expanduser() if env else DEFAULT_DOWNLOAD_DIR


def _sanitise_filename(filename: str, *, tool: str = "save_to_file") -> str:
    """Reject anything that could escape the sandbox.

    We refuse: empty, leading dot (hidden files), any slash/backslash,
    any '..' segment. The result is a single component that lands inside
    the download directory; nothing else. `tool` only prefixes error text.
    """
    if not filename:
        raise ToolError(f"{tool}: filename required", code="bad_args")
    if "\x00" in filename:
        raise ToolError(f"{tool}: filename contains null byte", code="unsafe_path")
    if "/" in filename or "\\" in filename:
        raise ToolError(
            f"{tool}: filename {filename!r} must be a single name, not a path",
            code="unsafe_path",
        )
    if filename in {".", ".."} or filename.startswith("."):
        raise ToolError(
            f"{tool}: filename {filename!r} starts with a dot (hidden / traversal)",
            code="unsafe_path",
        )
    if len(filename) > 255:
        raise ToolError(f"{tool}: filename too long (>255 chars)", code="bad_args")
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

    return await _write_blob_async(filename, raw, tool="save_to_file")


def _write_sandbox_blob(filename: str, raw: bytes, *, tool: str) -> dict[str, Any]:
    """Write bytes into the download sandbox; return {"path", "size"}.

    Shared by save_to_file and print_to_pdf's post-call processor. Both
    guards matter (invariant #10): the name already passed
    _sanitise_filename, and resolve()+relative_to re-proves the final path
    stays under the download dir. Filesystem failures (read-only volume,
    permission denied, disk full, name too long for the OS) surface as
    ToolError, not an uncaught OSError — the latter would crash the MCP
    dispatch loop and leave the caller hanging until its own timeout.

    Fully synchronous on purpose, and always run via :func:`_write_blob_async`
    so the containment re-check and the write stay in the SAME threaded unit —
    splitting them would reopen the TOCTOU the re-check exists to close.
    """
    download_dir = _resolve_dir()
    try:
        download_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ToolError(
            f"{tool}: cannot create download dir {download_dir}: {exc}",
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
            f"{tool}: resolved path {resolved} escaped sandbox {sandbox}",
            code="unsafe_path",
        ) from exc

    try:
        resolved.write_bytes(raw)
    except OSError as exc:
        raise ToolError(
            f"{tool}: write failed ({exc.__class__.__name__}): {exc}",
            code="filesystem_error",
        ) from exc
    return {"path": str(resolved), "size": len(raw)}


async def _write_blob_async(filename: str, raw: bytes, *, tool: str) -> dict[str, Any]:
    """Off-thread wrapper around :func:`_write_sandbox_blob`.

    Every step in there is blocking (`mkdir`, two `resolve()` calls that stat
    and follow symlinks, and a `write_bytes` of up to ~12 MiB for a PDF). Since
    tool calls now run concurrently, doing that on the event-loop thread would
    stall the WS read loop — delaying every OTHER session's tool_result — and
    the `status` builtin that is supposed to answer during a slow call.
    """
    return await asyncio.to_thread(_write_sandbox_blob, filename, raw, tool=tool)


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


def _validate_pdf_filename(args: dict[str, Any]) -> None:
    """Fail before the extension round-trip when print_to_pdf's filename is
    unusable — same sandbox rules as save_to_file (invariant #10), applied
    early so we don't render a PDF we then refuse to write."""
    filename = args.get("filename")
    if filename is None:
        return
    if not isinstance(filename, str):
        raise ToolError("print_to_pdf: filename must be a string", code="bad_args")
    _sanitise_filename(filename, tool="print_to_pdf")


async def _print_to_pdf_result(args: dict[str, Any], result: Any) -> dict[str, Any]:
    """Write the extension's PDF payload into the download sandbox.

    The extension returns {pdfBase64, base64Length}; routing the bytes
    through the daemon keeps them OUT of the MCP caller's context (a
    multi-MiB PDF would otherwise land in the model's window) and puts the
    write behind exactly the same sandbox guards as save_to_file. Returns
    {path, size, filename} — small enough to be a safe tool result.
    """
    if not isinstance(result, dict) or not isinstance(result.get("pdfBase64"), str):
        raise ToolError("print_to_pdf: extension returned no PDF payload", code="error")
    filename = args.get("filename")
    if filename is None:
        filename = _default_pdf_filename()
    if not isinstance(filename, str):
        raise ToolError("print_to_pdf: filename must be a string", code="bad_args")
    filename = _sanitise_filename(filename, tool="print_to_pdf")
    try:
        raw = base64.b64decode(result["pdfBase64"], validate=True)
    except Exception as exc:
        raise ToolError(
            f"print_to_pdf: extension payload not valid base64: {exc}", code="error"
        ) from exc
    written = await _write_blob_async(filename, raw, tool="print_to_pdf")
    return {**written, "filename": filename}


def _validate_fetch_filename(args: dict[str, Any]) -> None:
    """Fail before the browser round-trip when fetch_in_page's `saveAs` is
    unusable — same sandbox rules as save_to_file (invariant #10). Mirrors
    :func:`_validate_pdf_filename`: there is no point downloading a multi-MiB
    asset through the page only to refuse to write it."""
    filename = args.get("saveAs")
    if filename is None:
        return
    if not isinstance(filename, str):
        raise ToolError("fetch_in_page: saveAs must be a string", code="bad_args")
    _sanitise_filename(filename, tool="fetch_in_page")


async def _fetch_in_page_result(args: dict[str, Any], result: Any) -> dict[str, Any] | Any:
    """With `saveAs`, divert fetch_in_page's body into the download sandbox.

    Without it, nothing changes — the body comes back in `data` as before.

    The saving is the whole point: `fetch_in_page` exists to pull assets from a
    logged-in page, and those are routinely images or archives. Base64 inflates
    them by a third and every byte then sits in the model's context, re-read on
    every subsequent turn, to no purpose — the agent almost never wants to LOOK
    at an image, it wants the file on disk for `upload` or for the user. The old
    route (fetch_in_page → save_to_file) did put it on disk, but only after the
    payload had already made the trip through the context it was trying to avoid,
    and it cost a second call.

    Both content modes are handled: 'base64' decodes, 'text' is written as UTF-8
    (a JSON/CSV export is a normal thing to want on disk). The result keeps the
    metadata that lets the agent decide what happened — status, contentType,
    mode — and replaces `data` with {path, size, filename}.
    """
    filename = args.get("saveAs")
    if filename is None:
        return result
    if not isinstance(result, dict):
        raise ToolError("fetch_in_page: extension returned no payload", code="error")
    if not isinstance(filename, str):
        raise ToolError("fetch_in_page: saveAs must be a string", code="bad_args")
    filename = _sanitise_filename(filename, tool="fetch_in_page")

    data = result.get("data")
    if not isinstance(data, str):
        raise ToolError("fetch_in_page: response carried no body to save", code="error")
    mode = result.get("mode")
    if mode == "base64":
        try:
            raw = base64.b64decode(data, validate=True)
        except Exception as exc:
            raise ToolError(
                f"fetch_in_page: response body was not valid base64: {exc}", code="error"
            ) from exc
    else:
        # 'text' (or anything the extension labelled otherwise) — write the
        # characters we were given. UTF-8 with surrogatepass would smuggle an
        # unpaired surrogate onto disk, so encode strictly and report instead.
        try:
            raw = data.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise ToolError(
                f"fetch_in_page: response body is not encodable as UTF-8: {exc}",
                code="error",
            ) from exc

    written = await _write_blob_async(filename, raw, tool="fetch_in_page")
    saved = {k: v for k, v in result.items() if k not in ("data", "headers")}
    return {**saved, **written, "filename": filename}


def _default_pdf_filename() -> str:
    """Name for a print_to_pdf call that supplied none.

    The timestamp alone has one-second resolution and the write is an
    unconditional overwrite, so two sessions printing in the same second used to
    land on the same path: the later write won and BOTH callers were handed that
    path — one of them reading a PDF rendered from the other's page. A random
    suffix makes the default collision-proof across concurrent sessions. An
    explicit `filename` is still honoured verbatim (the caller chose it, and two
    callers choosing the same name is their own coordination problem)."""
    stamp = datetime.now(timezone.utc).strftime("print-%Y%m%dT%H%M%SZ")
    return f"{stamp}-{_secrets.token_hex(3)}.pdf"


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
    "print_to_pdf": _validate_pdf_filename,
    "fetch_in_page": _validate_fetch_filename,
}


# Per-tool post-call processors that run on the daemon AFTER the extension
# round-trip: each receives (args, extension result) and returns the result
# the MCP caller actually sees.
POST_CALL_PROCESSORS: dict[str, Callable[[dict[str, Any], Any], Awaitable[Any]]] = {
    "print_to_pdf": _print_to_pdf_result,
    "fetch_in_page": _fetch_in_page_result,
}
