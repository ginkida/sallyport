"""Length-prefixed framing for the broker's AF_UNIX MCP transport.

The extension speaks over a WebSocket, which frames messages for us. The
broker's shim<->broker leg, by contrast, is a raw AF_UNIX byte stream, so it
needs its own message framing. Each frame is a 4-byte big-endian unsigned
length followed by exactly that many payload bytes (one HMAC envelope, JSON).

`MAX_FRAME_BYTES` mirrors `Bridge.MAX_FRAME_BYTES` (security invariant #6): the
MCP ingress is a new client-controlled surface and must not let a peer pin
unbounded memory. A declared length over the cap is rejected the instant the
header is read — before a single payload byte is buffered or awaited.
"""

from __future__ import annotations

import asyncio

# 16 MiB — mirrors Bridge.MAX_FRAME_BYTES (invariant #6). Kept as a literal
# rather than imported so framing.py need not pull in the heavier bridge module
# (and its websockets dependency) merely for a constant.
MAX_FRAME_BYTES = 16 * 1024 * 1024

_HEADER = 4  # bytes of big-endian unsigned length prefix


class FramingError(Exception):
    """A frame violated the wire shape (oversize length, truncated body)."""


def encode_frame(payload: bytes) -> bytes:
    """Prefix `payload` with its 4-byte big-endian length. Raises FramingError
    if the payload exceeds the cap, so we never emit a frame the peer would be
    forced to reject anyway."""
    n = len(payload)
    if n > MAX_FRAME_BYTES:
        raise FramingError(f"frame of {n} bytes exceeds {MAX_FRAME_BYTES} cap")
    return n.to_bytes(_HEADER, "big") + payload


class FrameDecoder:
    """Incremental decoder: push raw bytes with `feed`, pop complete payloads.

    Stateful and not thread-safe — one per connection. An oversize declared
    length is rejected the instant the header is parsed, before the body is
    buffered, so a hostile peer cannot announce a 4 GiB frame and make us
    allocate or wait for it."""

    def __init__(self) -> None:
        self._buf = bytearray()
        self._need: int | None = None  # body length, once the header is parsed

    def feed(self, data: bytes) -> list[bytes]:
        """Append `data`; return every complete frame payload now available
        (possibly empty). Raises FramingError on an oversize declared length."""
        self._buf.extend(data)
        out: list[bytes] = []
        while True:
            if self._need is None:
                if len(self._buf) < _HEADER:
                    break
                n = int.from_bytes(self._buf[:_HEADER], "big")
                if n > MAX_FRAME_BYTES:
                    raise FramingError(f"declared frame length {n} exceeds {MAX_FRAME_BYTES} cap")
                del self._buf[:_HEADER]
                self._need = n
            if len(self._buf) < self._need:
                break
            out.append(bytes(self._buf[: self._need]))
            del self._buf[: self._need]
            self._need = None
        return out


async def read_frame(reader: asyncio.StreamReader) -> bytes | None:
    """Read one length-prefixed frame from `reader`. Returns the payload, or
    None on a clean EOF at a frame boundary. Raises FramingError on an oversize
    declared length, a header truncated by EOF, or a body truncated by EOF."""
    try:
        header = await reader.readexactly(_HEADER)
    except asyncio.IncompleteReadError as exc:
        if not exc.partial:
            return None  # clean EOF between frames
        raise FramingError("truncated frame header") from exc
    n = int.from_bytes(header, "big")
    if n > MAX_FRAME_BYTES:
        raise FramingError(f"declared frame length {n} exceeds {MAX_FRAME_BYTES} cap")
    try:
        return await reader.readexactly(n)
    except asyncio.IncompleteReadError as exc:
        raise FramingError("truncated frame body") from exc


async def write_frame(writer: asyncio.StreamWriter, payload: bytes) -> None:
    """Encode and flush one frame to `writer`."""
    writer.write(encode_frame(payload))
    await writer.drain()
