"""Daemon-local tools: save_to_file sandbox + base64 handling."""

from __future__ import annotations

import base64
from pathlib import Path

import pytest

from sallyport_daemon.bridge import ToolError
from sallyport_daemon.local_tools import (
    PRE_CALL_VALIDATORS,
    _print_to_pdf_result,
    save_to_file,
    validate_upload_paths,
)


@pytest.fixture
def sandbox(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect SALLYPORT_DOWNLOAD_DIR to a tmp_path for each test."""
    monkeypatch.setenv("SALLYPORT_DOWNLOAD_DIR", str(tmp_path))
    return tmp_path


async def test_writes_bytes_to_sandbox(sandbox: Path) -> None:
    data = base64.b64encode(b"hello world").decode()
    result = await save_to_file({"data": data, "filename": "out.bin"})
    assert result["size"] == 11
    assert Path(result["path"]).read_bytes() == b"hello world"
    assert Path(result["path"]).parent == sandbox


async def test_creates_sandbox_dir_lazily(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = tmp_path / "nested" / "dl"
    monkeypatch.setenv("SALLYPORT_DOWNLOAD_DIR", str(target))
    assert not target.exists()
    await save_to_file({"data": base64.b64encode(b"x").decode(), "filename": "y.bin"})
    assert (target / "y.bin").exists()


@pytest.mark.parametrize(
    "filename",
    [
        "../escape.txt",
        "../../etc/passwd",
        "sub/dir/file.txt",
        "back\\slash.txt",
        ".hidden",
        ".",
        "..",
        "",
        "evil\x00.txt",
    ],
)
async def test_rejects_unsafe_filename(sandbox: Path, filename: str) -> None:
    data = base64.b64encode(b"x").decode()
    with pytest.raises(ToolError) as exc_info:
        await save_to_file({"data": data, "filename": filename})
    assert exc_info.value.code in {"unsafe_path", "bad_args"}


async def test_rejects_overlong_filename(sandbox: Path) -> None:
    long_name = "a" * 300 + ".bin"
    with pytest.raises(ToolError) as exc_info:
        await save_to_file({"data": base64.b64encode(b"x").decode(), "filename": long_name})
    assert exc_info.value.code == "bad_args"


async def test_rejects_missing_args(sandbox: Path) -> None:
    with pytest.raises(ToolError):
        await save_to_file({"filename": "x.bin"})
    with pytest.raises(ToolError):
        await save_to_file({"data": "AA=="})
    with pytest.raises(ToolError):
        await save_to_file({"data": 123, "filename": "x.bin"})


async def test_rejects_bad_base64(sandbox: Path) -> None:
    with pytest.raises(ToolError) as exc_info:
        await save_to_file({"data": "!!!not base64!!!", "filename": "x.bin"})
    assert exc_info.value.code == "bad_args"


async def test_overwrites_existing_file(sandbox: Path) -> None:
    p = sandbox / "out.bin"
    p.write_bytes(b"old")
    await save_to_file({"data": base64.b64encode(b"new").decode(), "filename": "out.bin"})
    assert p.read_bytes() == b"new"


async def test_write_oserror_becomes_tool_error(
    sandbox: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A filesystem failure on write (read-only volume, disk full, …) must
    surface as a ToolError with code `filesystem_error`, never an uncaught
    OSError that would crash the MCP dispatch loop and hang the caller."""

    def boom(self: Path, _data: bytes) -> int:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(Path, "write_bytes", boom)
    with pytest.raises(ToolError) as exc_info:
        await save_to_file({"data": base64.b64encode(b"x").decode(), "filename": "x.bin"})
    assert exc_info.value.code == "filesystem_error"
    assert "write failed" in str(exc_info.value)


async def test_mkdir_oserror_becomes_tool_error(
    sandbox: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same guarantee for the directory-creation step."""

    def boom(self: Path, *_a: object, **_k: object) -> None:
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(Path, "mkdir", boom)
    with pytest.raises(ToolError) as exc_info:
        await save_to_file({"data": base64.b64encode(b"x").decode(), "filename": "x.bin"})
    assert exc_info.value.code == "filesystem_error"


async def test_routed_through_bridge_call_tool(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End-to-end: Bridge.call_tool routes save_to_file locally without
    needing an attached extension. This is the path Claude uses."""
    from sallyport_daemon.bridge import Bridge

    monkeypatch.setenv("SALLYPORT_DOWNLOAD_DIR", str(tmp_path))
    bridge = Bridge(secret=bytes(32), host="127.0.0.1", port=0)
    out = await bridge.call_tool(
        "save_to_file",
        {"data": base64.b64encode(b"local").decode(), "filename": "local.bin"},
    )
    assert out["size"] == 5
    assert (tmp_path / "local.bin").read_bytes() == b"local"


# ---------------------------------------------------------------------------
# validate_upload_paths — daemon-side sandbox for the upload tool
# ---------------------------------------------------------------------------


def test_validate_upload_paths_accepts_file_in_sandbox(sandbox: Path) -> None:
    f = sandbox / "photo.jpg"
    f.write_bytes(b"x")
    validate_upload_paths([str(f)])  # no raise


def test_validate_upload_paths_accepts_nonexistent_in_sandbox(sandbox: Path) -> None:
    """The validator's job is sandbox membership, not existence — Chrome
    will surface a clean error if the file's missing at upload time."""
    validate_upload_paths([str(sandbox / "not-yet.bin")])


def test_validate_upload_paths_rejects_outside_sandbox(sandbox: Path) -> None:
    with pytest.raises(ToolError) as exc_info:
        validate_upload_paths(["/etc/passwd"])
    assert exc_info.value.code == "unsafe_path"
    assert "outside the sandbox" in str(exc_info.value)


def test_validate_upload_paths_rejects_symlink_escape(sandbox: Path, tmp_path: Path) -> None:
    """A symlink inside the sandbox pointing outside it must NOT slip
    through — Path.resolve() follows the link and the resolved target is
    what the sandbox check sees."""
    outside = tmp_path.parent / "outside-secret"
    outside.write_text("sensitive")
    link = sandbox / "looks-innocent.png"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlinks not supported on this filesystem")
    with pytest.raises(ToolError) as exc_info:
        validate_upload_paths([str(link)])
    assert exc_info.value.code == "unsafe_path"


def test_validate_upload_paths_rejects_relative(sandbox: Path) -> None:
    with pytest.raises(ToolError) as exc_info:
        validate_upload_paths(["relative/path.bin"])
    assert exc_info.value.code == "bad_args"


def test_validate_upload_paths_rejects_traversal_segments(sandbox: Path) -> None:
    with pytest.raises(ToolError) as exc_info:
        validate_upload_paths([f"{sandbox}/../escape.bin"])
    assert exc_info.value.code == "unsafe_path"


def test_validate_upload_paths_rejects_empty_list(sandbox: Path) -> None:
    with pytest.raises(ToolError) as exc_info:
        validate_upload_paths([])
    assert exc_info.value.code == "bad_args"


def test_validate_upload_paths_rejects_non_list(sandbox: Path) -> None:
    for bad in (None, "single.bin", 42, {"a": "b"}):
        with pytest.raises(ToolError):
            validate_upload_paths(bad)


def test_validate_upload_paths_rejects_non_string_entries(sandbox: Path) -> None:
    with pytest.raises(ToolError) as exc_info:
        validate_upload_paths([str(sandbox / "ok.bin"), 42])
    assert exc_info.value.code == "bad_args"


def test_validate_upload_paths_rejects_null_byte(sandbox: Path) -> None:
    """A null byte in a path would make Path.resolve() raise ValueError,
    which would escape the validator's OSError/RuntimeError catch. Must be
    rejected explicitly as unsafe_path."""
    with pytest.raises(ToolError) as exc_info:
        validate_upload_paths([f"{sandbox}/ok\x00.bin"])
    assert exc_info.value.code == "unsafe_path"


def test_validate_upload_paths_rejects_lone_surrogate(sandbox: Path) -> None:
    """A lone surrogate makes Path.resolve() raise UnicodeEncodeError (a
    ValueError subclass), which used to escape the validator's catch and
    crash the MCP dispatch loop. Must fail closed as unsafe_path."""
    with pytest.raises(ToolError) as exc_info:
        validate_upload_paths([f"{sandbox}/a\ud800b.bin"])
    assert exc_info.value.code == "unsafe_path"


async def test_upload_lone_surrogate_does_not_crash_dispatch(sandbox: Path) -> None:
    """End to end: the validator runs as a PRE_CALL_VALIDATOR before signing,
    so a lone-surrogate path must surface as a ToolError to the caller, not an
    uncaught UnicodeEncodeError that tears down the dispatch loop."""
    from sallyport_daemon.bridge import Bridge

    bridge = Bridge(secret=bytes(32), host="127.0.0.1", port=0)
    with pytest.raises(ToolError) as exc_info:
        await bridge.call_tool("upload", {"selector": "#f", "paths": [f"{sandbox}/a\ud800.bin"]})
    assert exc_info.value.code == "unsafe_path"


async def test_bridge_call_tool_runs_upload_validator_before_extension(
    sandbox: Path,
) -> None:
    """Bridge.call_tool must run the pre-call validator BEFORE attempting
    to reach the extension — even if no extension is connected, a path
    outside the sandbox should fail with `unsafe_path`, not
    `ExtensionNotConnected`."""
    from sallyport_daemon.bridge import Bridge

    bridge = Bridge(secret=bytes(32), host="127.0.0.1", port=0)
    with pytest.raises(ToolError) as exc_info:
        await bridge.call_tool("upload", {"selector": "#f", "paths": ["/etc/passwd"]})
    assert exc_info.value.code == "unsafe_path"


# ---------------------------------------------------------------- print_to_pdf


async def test_print_to_pdf_writes_bytes(sandbox: Path) -> None:
    """A valid base64 PDF payload lands in the sandbox; the MCP-visible
    result is the compact metadata shape, not the payload itself."""
    body = base64.b64encode(b"%PDF-1.7 fake").decode()
    result = await _print_to_pdf_result(
        {"filename": "report.pdf"}, {"pdfBase64": body, "base64Length": len(body)}
    )
    assert result["filename"] == "report.pdf"
    assert result["size"] == len(b"%PDF-1.7 fake")
    assert "pdfBase64" not in result
    assert Path(result["path"]).read_bytes() == b"%PDF-1.7 fake"
    assert Path(result["path"]).parent == sandbox


async def test_print_to_pdf_default_filename(sandbox: Path) -> None:
    body = base64.b64encode(b"%PDF").decode()
    result = await _print_to_pdf_result({}, {"pdfBase64": body})
    assert result["filename"].startswith("print-")
    assert result["filename"].endswith(".pdf")
    assert Path(result["path"]).name == result["filename"]


async def test_print_to_pdf_default_filenames_do_not_collide(sandbox: Path) -> None:
    """Two sessions printing in the same wall-clock second must not land on the
    same path — the later write would win and hand BOTH callers that path, so
    one of them would read a PDF rendered from the other's page."""
    a = base64.b64encode(b"%PDF-A").decode()
    b = base64.b64encode(b"%PDF-BB").decode()
    first = await _print_to_pdf_result({}, {"pdfBase64": a})
    second = await _print_to_pdf_result({}, {"pdfBase64": b})
    assert first["path"] != second["path"]
    assert Path(first["path"]).read_bytes() == b"%PDF-A"
    assert Path(second["path"]).read_bytes() == b"%PDF-BB"
    # And each caller's reported size matches the file actually on disk.
    assert first["size"] == Path(first["path"]).stat().st_size
    assert second["size"] == Path(second["path"]).stat().st_size


async def test_print_to_pdf_rejects_traversal(sandbox: Path) -> None:
    body = base64.b64encode(b"%PDF").decode()
    with pytest.raises(ToolError) as exc_info:
        await _print_to_pdf_result({"filename": "../evil.pdf"}, {"pdfBase64": body})
    assert exc_info.value.code == "unsafe_path"


async def test_print_to_pdf_rejects_bad_base64(sandbox: Path) -> None:
    with pytest.raises(ToolError) as exc_info:
        await _print_to_pdf_result({}, {"pdfBase64": "!!!not-base64!!!"})
    assert exc_info.value.code == "error"


async def test_print_to_pdf_rejects_missing_payload(sandbox: Path) -> None:
    with pytest.raises(ToolError) as exc_info:
        await _print_to_pdf_result({}, {"unexpected": True})
    assert exc_info.value.code == "error"


def test_print_to_pdf_validator_rejects_bad_filename() -> None:
    validator = PRE_CALL_VALIDATORS["print_to_pdf"]
    for bad in ("../x.pdf", "/abs/x.pdf", ".hidden.pdf", "dir/x.pdf"):
        with pytest.raises(ToolError) as exc_info:
            validator({"filename": bad})
        assert exc_info.value.code == "unsafe_path"
    with pytest.raises(ToolError) as exc_info:
        validator({"filename": 42})
    assert exc_info.value.code == "bad_args"
    # Absent filename and a plain name both pass.
    validator({})
    validator({"filename": "ok.pdf"})
