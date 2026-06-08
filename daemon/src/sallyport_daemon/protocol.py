"""Wire format shared with the extension.

Every WS frame is JSON with this shape:

    {v, ts, nonce, type, id?, body, mac}

where mac = HMAC-SHA256(secret, canonical_json({v, ts, nonce, type, id?, body}))
encoded as base64.

Both sides:
  * reject if `ts` differs from local clock by more than MAX_CLOCK_SKEW_S,
  * reject if `nonce` is reused (within NONCE_CACHE_SIZE),
  * reject on mac mismatch (constant-time compare).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import secrets as _secrets
import time
from collections import deque
from dataclasses import dataclass
from typing import Any

PROTOCOL_VERSION = 1
MAX_CLOCK_SKEW_S = 30
NONCE_CACHE_SIZE = 4096
# ECMAScript's Number::toString switches from positional digits to exponent
# notation at 1e21. Below that bound an integral double goes on the wire
# (JSON.stringify) as bare digits, so the canonical form must be those same
# digits; at/above it both languages use the scientific repr form.
_INTEGRAL_DIGITS_BOUND = 1e21


def _format_number(x: float) -> str:
    """Render a finite double exactly as the canonical form requires.

    * integral and |x| < 1e21 → the ECMAScript integer rendering (shortest
      round-trip digits, zero-padded) — exactly what JS ``String(x)`` /
      ``JSON.stringify`` produce, so the extension's wire frames re-parse
      to the same canonical bytes. For |x| ≤ 2^53−1 these are the exact
      digits. Folds ``-0.0`` to ``"0"``.
    * everything else → CPython ``repr`` (the extension reimplements this
      exact format as ``pythonFloatRepr``).
    """
    if x == 0:
        return "0"
    if x.is_integer() and abs(x) < _INTEGRAL_DIGITS_BOUND:
        r = repr(x)
        if "e" in r:
            # e.g. '1.152921504606847e+18' → '1152921504606847000'
            mantissa, _, exp = r.partition("e")
            neg = mantissa.startswith("-")
            digits = mantissa.lstrip("-").replace(".", "")
            padded = digits + "0" * (int(exp) - (len(digits) - 1))
            return "-" + padded if neg else padded
        # Fixed form: an integral repr always ends in '.0'.
        return r[:-2]
    return repr(x)


def _encode_canonical(value: Any) -> str:
    """Recursive canonical encoder. See :func:`canonical_json` for the rules."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ProtocolError("non-finite number in canonical JSON")
        return _format_number(value)
    if isinstance(value, int):
        # An int is wire-legal iff the peer's JSON.parse (which yields an
        # IEEE-754 double) preserves it: either the double equals the int
        # exactly, or the int IS the shortest rendering of that double
        # (i.e. it came off the wire from JSON.stringify). Anything else
        # would silently change value across the bridge — reject instead.
        try:
            as_float = float(value)
        except OverflowError as exc:
            raise ProtocolError("integer too large for IEEE-754 double") from exc
        rendered = _format_number(as_float)
        if int(as_float) != value and str(value) != rendered:
            raise ProtocolError("integer not exactly representable as IEEE-754 double")
        return rendered
    if isinstance(value, str):
        # json.dumps escapes exactly like before (and like JSON.stringify).
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_encode_canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        for key in value:
            if not isinstance(key, str):
                raise ProtocolError("non-string object key in canonical JSON")
        return (
            "{"
            + ",".join(
                json.dumps(key, ensure_ascii=False) + ":" + _encode_canonical(value[key])
                for key in sorted(value)
            )
            + "}"
        )
    raise ProtocolError(f"unsupported type in canonical JSON: {type(value).__name__}")


def canonical_json(value: Any) -> str:
    """Stable JSON encoder. Must match the extension's canonicalJson() byte-for-byte.

    Rules: keys sorted by Unicode code point, no whitespace, unicode
    passthrough. Numbers: integral doubles with |x| < 1e21 render as bare
    shortest digits (matching the extension's JSON.stringify wire output);
    all other finite doubles use CPython ``repr``; ints must be exactly
    double-representable (or be the shortest rendering of a double).
    Raises :class:`ProtocolError` on values that cannot round-trip
    identically through both languages (non-finite numbers, precision-losing
    ints, lone surrogates, non-string keys).
    """
    encoded = _encode_canonical(value)
    try:
        encoded.encode("utf-8")
    except UnicodeEncodeError as exc:
        # A lone surrogate cannot be UTF-8 encoded, so the peer could never
        # verify the MAC anyway. (JS strings can carry lone surrogates too;
        # canonicalJson rejects them symmetrically.)
        raise ProtocolError("lone surrogate in canonical JSON string") from exc
    return encoded


@dataclass
class Envelope:
    type: str
    body: Any
    id: str | None = None
    ts: int | None = None
    nonce: str | None = None
    v: int = PROTOCOL_VERSION


class ProtocolError(Exception):
    pass


class Signer:
    def __init__(self, secret: bytes) -> None:
        if len(secret) < 16:
            raise ValueError("secret too short (min 16 bytes)")
        self._secret = secret
        self._seen: deque[str] = deque(maxlen=NONCE_CACHE_SIZE)
        self._seen_set: set[str] = set()

    def _mac_input(self, env: dict[str, Any]) -> bytes:
        canonical = {
            "v": env["v"],
            "ts": env["ts"],
            "nonce": env["nonce"],
            "type": env["type"],
            "body": env["body"],
        }
        if env.get("id") is not None:
            canonical["id"] = env["id"]
        return canonical_json(canonical).encode("utf-8")

    def sign(self, env: Envelope) -> dict[str, Any]:
        ts = env.ts if env.ts is not None else int(time.time())
        nonce = (
            env.nonce
            if env.nonce is not None
            else base64.b64encode(_secrets.token_bytes(16)).decode("ascii")
        )
        payload: dict[str, Any] = {
            "v": env.v,
            "ts": ts,
            "nonce": nonce,
            "type": env.type,
            "body": env.body,
        }
        if env.id is not None:
            payload["id"] = env.id
        mac = hmac.new(self._secret, self._mac_input(payload), hashlib.sha256).digest()
        payload["mac"] = base64.b64encode(mac).decode("ascii")
        return payload

    def verify(self, raw: dict[str, Any]) -> Envelope:
        if not isinstance(raw, dict):
            raise ProtocolError("not an object")
        if raw.get("v") != PROTOCOL_VERSION:
            raise ProtocolError(f"bad version: {raw.get('v')!r}")
        ts = raw.get("ts")
        nonce = raw.get("nonce")
        typ = raw.get("type")
        mac_b64 = raw.get("mac")
        if not isinstance(ts, int):
            raise ProtocolError("bad ts")
        if not isinstance(nonce, str) or not nonce:
            raise ProtocolError("bad nonce")
        if not isinstance(typ, str) or not typ:
            raise ProtocolError("bad type")
        if not isinstance(mac_b64, str) or not mac_b64:
            raise ProtocolError("bad mac")
        if "body" not in raw:
            # _mac_input reads env["body"]; a missing key must be a clean
            # ProtocolError (skipped frame), not a KeyError teardown.
            raise ProtocolError("missing body")
        if "id" in raw and not isinstance(raw["id"], str):
            # The read loop uses id as a dict key (_pending.pop); an
            # unhashable id (dict/list) from an authenticated-but-buggy
            # peer must be a skipped frame, not a TypeError teardown.
            raise ProtocolError("bad id")

        now = int(time.time())
        if abs(now - ts) > MAX_CLOCK_SKEW_S:
            raise ProtocolError(f"timestamp skew {now - ts}s")

        if nonce in self._seen_set:
            raise ProtocolError("nonce replay")

        expected = hmac.new(self._secret, self._mac_input(raw), hashlib.sha256).digest()
        try:
            provided = base64.b64decode(mac_b64, validate=True)
        except Exception as exc:
            raise ProtocolError(f"mac not base64: {exc}") from exc
        if not hmac.compare_digest(expected, provided):
            raise ProtocolError("mac mismatch")

        # Evict the oldest entry explicitly *before* appending so that
        # set and deque stay in sync. (Relying on deque.append's silent
        # auto-eviction would pop from the wrong end of the set.)
        if len(self._seen) == self._seen.maxlen:
            evicted = self._seen.popleft()
            self._seen_set.discard(evicted)
        self._seen.append(nonce)
        self._seen_set.add(nonce)

        return Envelope(
            type=typ,
            body=raw.get("body"),
            id=raw.get("id"),
            ts=ts,
            nonce=nonce,
            v=raw["v"],
        )
