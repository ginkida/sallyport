"""Length-prefixed framing for the broker's AF_UNIX MCP transport."""

from __future__ import annotations

import asyncio
from typing import Any, cast

import pytest

from sallyport_daemon import framing
from sallyport_daemon.framing import (
    MAX_FRAME_BYTES,
    FrameDecoder,
    FramingError,
    encode_frame,
    read_frame,
    write_frame,
)


def test_max_frame_default_is_16_mib() -> None:
    assert MAX_FRAME_BYTES == 16 * 1024 * 1024


def test_encode_decode_roundtrip() -> None:
    dec = FrameDecoder()
    assert dec.feed(encode_frame(b"hello")) == [b"hello"]


def test_encode_empty_payload_roundtrips() -> None:
    dec = FrameDecoder()
    assert dec.feed(encode_frame(b"")) == [b""]


def test_decoder_multiple_frames_one_feed() -> None:
    dec = FrameDecoder()
    blob = encode_frame(b"a") + encode_frame(b"bb") + encode_frame(b"ccc")
    assert dec.feed(blob) == [b"a", b"bb", b"ccc"]


def test_decoder_frame_split_across_feeds() -> None:
    dec = FrameDecoder()
    frame = encode_frame(b"abcdef")
    assert dec.feed(frame[:2]) == []  # partial header
    assert dec.feed(frame[2:5]) == []  # rest of header + partial body
    assert dec.feed(frame[5:]) == [b"abcdef"]


def test_decoder_keeps_trailing_partial_for_next_feed() -> None:
    dec = FrameDecoder()
    one, two = encode_frame(b"xy"), encode_frame(b"zzzz")
    assert dec.feed(one + two[:3]) == [b"xy"]
    assert dec.feed(two[3:]) == [b"zzzz"]


def test_encode_rejects_oversize(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(framing, "MAX_FRAME_BYTES", 8)
    assert encode_frame(b"x" * 8)  # boundary is allowed
    with pytest.raises(FramingError):
        encode_frame(b"x" * 9)


def test_decoder_rejects_oversize_declared_length(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(framing, "MAX_FRAME_BYTES", 8)
    dec = FrameDecoder()
    # A header declaring 9 bytes is rejected on the header alone — no body fed.
    with pytest.raises(FramingError):
        dec.feed((9).to_bytes(4, "big"))


@pytest.mark.asyncio
async def test_read_frame_reads_one_then_clean_eof() -> None:
    reader = asyncio.StreamReader()
    reader.feed_data(encode_frame(b"payload"))
    reader.feed_eof()
    assert await read_frame(reader) == b"payload"
    assert await read_frame(reader) is None


@pytest.mark.asyncio
async def test_read_frame_two_frames() -> None:
    reader = asyncio.StreamReader()
    reader.feed_data(encode_frame(b"one") + encode_frame(b"two"))
    reader.feed_eof()
    assert await read_frame(reader) == b"one"
    assert await read_frame(reader) == b"two"
    assert await read_frame(reader) is None


@pytest.mark.asyncio
async def test_read_frame_eof_at_boundary_returns_none() -> None:
    reader = asyncio.StreamReader()
    reader.feed_eof()
    assert await read_frame(reader) is None


@pytest.mark.asyncio
async def test_read_frame_truncated_header_raises() -> None:
    reader = asyncio.StreamReader()
    reader.feed_data(b"\x00\x00")  # 2 of 4 header bytes, then EOF
    reader.feed_eof()
    with pytest.raises(FramingError):
        await read_frame(reader)


@pytest.mark.asyncio
async def test_read_frame_truncated_body_raises() -> None:
    reader = asyncio.StreamReader()
    reader.feed_data((5).to_bytes(4, "big") + b"ab")  # declares 5, gives 2
    reader.feed_eof()
    with pytest.raises(FramingError):
        await read_frame(reader)


@pytest.mark.asyncio
async def test_read_frame_rejects_oversize(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(framing, "MAX_FRAME_BYTES", 8)
    reader = asyncio.StreamReader()
    reader.feed_data((9).to_bytes(4, "big"))
    reader.feed_eof()
    with pytest.raises(FramingError):
        await read_frame(reader)


@pytest.mark.asyncio
async def test_write_frame_emits_encoded_bytes() -> None:
    chunks: list[bytes] = []

    class _W:
        def write(self, b: bytes) -> None:
            chunks.append(b)

        async def drain(self) -> None:
            return None

    await write_frame(cast(Any, _W()), b"hi")
    assert b"".join(chunks) == encode_frame(b"hi")
