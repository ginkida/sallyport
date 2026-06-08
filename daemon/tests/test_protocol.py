"""Tests for the wire protocol: canonical JSON, HMAC sign/verify, replay
protection, timestamp skew, MAC tampering, version mismatch.

The bytes produced by `canonical_json` and the MAC computed by `Signer.sign`
must exactly match what the TypeScript side produces — there is a vitest
companion that pins the same vectors on the extension side. If you change
the canonicalization, change both."""

from __future__ import annotations

import base64
import hashlib
import hmac
import time

import pytest

from sallyport_daemon.protocol import (
    MAX_CLOCK_SKEW_S,
    NONCE_CACHE_SIZE,
    PROTOCOL_VERSION,
    Envelope,
    ProtocolError,
    Signer,
    canonical_json,
)

SECRET = bytes.fromhex("00" * 32)
SECRET_OTHER = bytes.fromhex("11" * 32)


# ---------------------------------------------------------------------------
# canonical_json
# ---------------------------------------------------------------------------


def test_canonical_json_sorts_keys() -> None:
    assert canonical_json({"b": 1, "a": 2}) == '{"a":2,"b":1}'


def test_canonical_json_nested() -> None:
    assert canonical_json({"outer": {"z": 1, "a": [3, 2, 1]}}) == '{"outer":{"a":[3,2,1],"z":1}}'


def test_canonical_json_no_whitespace() -> None:
    # No spaces after , or :
    assert canonical_json([1, 2, {"k": "v"}]) == '[1,2,{"k":"v"}]'


def test_canonical_json_unicode_passthrough() -> None:
    assert canonical_json({"k": "тест"}) == '{"k":"тест"}'


def test_canonical_json_float_repr_formats() -> None:
    """Non-integral (and ≥1e21) float formatting is Python's repr — the TS
    side reimplements this exact format (pythonFloatRepr in protocol.ts).
    The fixture vectors pin the same values cross-language; these are the
    fast local checks."""
    assert canonical_json(0.5) == "0.5"
    assert canonical_json(0.1) == "0.1"
    assert canonical_json(0.0001) == "0.0001"  # last fixed-notation magnitude
    assert canonical_json(1e-05) == "1e-05"  # JS toString would say 0.00001
    assert canonical_json(1e-06) == "1e-06"  # JS toString would say 0.000001
    assert canonical_json(1e-07) == "1e-07"  # JS toString would say 1e-7
    assert canonical_json(-1.5e-07) == "-1.5e-07"
    assert canonical_json(1e21) == "1e+21"  # ES toString switches to sci here too
    assert canonical_json(1.5e22) == "1.5e+22"
    assert canonical_json(5e-324) == "5e-324"  # smallest subnormal
    assert canonical_json(1000000000000000.5) == "1000000000000000.5"


def test_canonical_json_integral_doubles_render_as_bare_digits() -> None:
    """Integral doubles below 1e21 canonicalise as bare shortest digits —
    exactly the bytes the extension's JSON.stringify puts on the wire, so
    the daemon's re-parse recanonicalises to the same MAC input. Within
    ±(2^53−1) the shortest digits are the exact digits."""
    assert canonical_json(2.0) == "2"
    assert canonical_json({"k": 2.0}) == '{"k":2}'
    assert canonical_json(-0.0) == "0"
    assert canonical_json(1e15) == "1000000000000000"
    # The window [2^53, 1e21): CPython repr would say '9007199254740992.0'
    # or '1e+16', but JS wire frames carry bare integers there.
    assert canonical_json(9007199254740992.0) == "9007199254740992"  # 2^53
    assert canonical_json(1e16) == "10000000000000000"
    assert canonical_json(1.2e16) == "12000000000000000"
    assert canonical_json(1.7e18) == "1700000000000000000"  # snowflake-style ID
    # Shortest digits, not exact digits: 2^60 prints like JS String(2**60).
    assert canonical_json(2.0**60) == "1152921504606847000"
    assert canonical_json(-(2.0**60)) == "-1152921504606847000"
    assert canonical_json(999999999999999916544.0) == "999999999999999900000"


def test_canonical_json_rejects_non_finite() -> None:
    for bad in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(ProtocolError, match="non-finite"):
            canonical_json({"k": bad})


def test_canonical_json_int_rules() -> None:
    """An int is wire-legal iff the peer's JSON.parse preserves it: either
    double-exact, or already the shortest rendering of a double (i.e. it
    came off the wire from JSON.stringify). Precision-losing ints are
    rejected at signing time — never silently corrupted."""
    assert canonical_json(2**53 - 1) == "9007199254740991"
    assert canonical_json(-(2**53) + 1) == "-9007199254740991"
    # Double-exact above 2^53: accepted, rendered as shortest digits.
    assert canonical_json(2**53) == "9007199254740992"
    assert canonical_json(2**60) == "1152921504606847000"
    # The shortest-rendering form itself (what JS emits): also accepted.
    assert canonical_json(1152921504606847000) == "1152921504606847000"
    # Double-exact and ≥1e21: crosses into exponent notation.
    assert canonical_json(10**21) == "1e+21"
    # Precision-losing ints are rejected.
    with pytest.raises(ProtocolError, match="not exactly representable"):
        canonical_json(2**53 + 1)
    with pytest.raises(ProtocolError, match="not exactly representable"):
        canonical_json(10**16 + 1)
    with pytest.raises(ProtocolError, match="not exactly representable"):
        canonical_json(10**21 + 1)
    with pytest.raises(ProtocolError, match="too large"):
        canonical_json(10**400)


def test_canonical_json_rejects_lone_surrogate() -> None:
    with pytest.raises(ProtocolError, match="lone surrogate"):
        canonical_json({"k": "\ud800"})
    with pytest.raises(ProtocolError, match="lone surrogate"):
        canonical_json({"\udfff": 1})


def test_canonical_json_rejects_non_string_keys() -> None:
    with pytest.raises(ProtocolError, match="non-string"):
        canonical_json({1: "a"})


def test_canonical_json_rejects_unsupported_types() -> None:
    with pytest.raises(ProtocolError, match="unsupported type"):
        canonical_json({"k": object()})
    with pytest.raises(ProtocolError, match="unsupported type"):
        canonical_json({"k": {1, 2}})


def test_canonical_json_sorts_keys_by_code_point_not_utf16() -> None:
    """U+FFFD (0xFFFD) < U+1F600 (0x1F600) by code point, but the emoji's
    UTF-16 lead surrogate (0xD83D) sorts first under a code-unit sort.
    Python's sort_keys is the reference; the TS side must match."""
    assert canonical_json({"\U0001f600": 2, "\ufffd": 1}) == '{"\ufffd":1,"\U0001f600":2}'
    assert canonical_json({"\U00010000": 2, "\ue000": 1}) == '{"\ue000":1,"\U00010000":2}'


def test_sign_rejects_unserialisable_body() -> None:
    """Signing must fail fast on a body the canonical encoding rejects —
    not produce a frame the peer can never verify."""
    s = Signer(SECRET)
    with pytest.raises(ProtocolError, match="non-finite"):
        s.sign(Envelope(type="tool_call", body={"k": float("nan")}, id="r1"))


def test_canonical_json_known_vector() -> None:
    # This exact byte sequence is what the extension's canonicalJson() must
    # produce for the equivalent input. The vitest companion pins the same
    # vector. Do NOT change this string without updating both implementations.
    env = {
        "v": 1,
        "ts": 1700000000,
        "nonce": "AAAAAAAAAAAAAAAAAAAAAA==",
        "type": "tool_call",
        "id": "req1",
        "body": {"name": "navigate", "args": {"url": "https://example.com/"}},
    }
    expected = (
        '{"body":{"args":{"url":"https://example.com/"},"name":"navigate"},'
        '"id":"req1","nonce":"AAAAAAAAAAAAAAAAAAAAAA==","ts":1700000000,'
        '"type":"tool_call","v":1}'
    )
    assert canonical_json(env) == expected


# ---------------------------------------------------------------------------
# Signer.sign / verify roundtrip
# ---------------------------------------------------------------------------


def test_sign_verify_roundtrip_simple() -> None:
    s = Signer(SECRET)
    signed = s.sign(Envelope(type="hello", body={"v": "1"}))
    verified = s.verify(signed)
    assert verified.type == "hello"
    assert verified.body == {"v": "1"}


def test_sign_verify_roundtrip_with_id() -> None:
    s = Signer(SECRET)
    signed = s.sign(Envelope(type="tool_call", body={"name": "x"}, id="abc"))
    # Use a fresh verifier — the same signer reuses its own nonces.
    v = Signer(SECRET)
    verified = v.verify(signed)
    assert verified.id == "abc"


def test_sign_envelope_has_required_fields() -> None:
    s = Signer(SECRET)
    out = s.sign(Envelope(type="ping", body={}))
    for key in ("v", "ts", "nonce", "type", "body", "mac"):
        assert key in out, key
    assert out["v"] == PROTOCOL_VERSION


def test_sign_includes_id_when_set() -> None:
    s = Signer(SECRET)
    out = s.sign(Envelope(type="x", body={}, id="r1"))
    assert out["id"] == "r1"


def test_sign_omits_id_when_unset() -> None:
    s = Signer(SECRET)
    out = s.sign(Envelope(type="x", body={}))
    assert "id" not in out


def test_signers_with_same_secret_interop() -> None:
    a = Signer(SECRET)
    b = Signer(SECRET)
    signed = a.sign(Envelope(type="ping", body={}))
    assert b.verify(signed).type == "ping"


# ---------------------------------------------------------------------------
# Authentication failures
# ---------------------------------------------------------------------------


def test_verify_rejects_wrong_secret() -> None:
    a = Signer(SECRET)
    b = Signer(SECRET_OTHER)
    signed = a.sign(Envelope(type="ping", body={}))
    with pytest.raises(ProtocolError, match="mac mismatch"):
        b.verify(signed)


def test_verify_rejects_tampered_body() -> None:
    a = Signer(SECRET)
    b = Signer(SECRET)
    signed = a.sign(Envelope(type="tool_call", body={"name": "navigate"}))
    signed["body"] = {"name": "exfiltrate"}
    with pytest.raises(ProtocolError, match="mac mismatch"):
        b.verify(signed)


def test_verify_rejects_tampered_type() -> None:
    a = Signer(SECRET)
    b = Signer(SECRET)
    signed = a.sign(Envelope(type="ping", body={}))
    signed["type"] = "hello"
    with pytest.raises(ProtocolError, match="mac mismatch"):
        b.verify(signed)


def test_verify_rejects_tampered_ts() -> None:
    a = Signer(SECRET)
    b = Signer(SECRET)
    signed = a.sign(Envelope(type="ping", body={}))
    signed["ts"] = signed["ts"] + 1
    with pytest.raises(ProtocolError, match="mac mismatch"):
        b.verify(signed)


def test_verify_rejects_tampered_id() -> None:
    a = Signer(SECRET)
    b = Signer(SECRET)
    signed = a.sign(Envelope(type="tool_call", id="orig", body={}))
    signed["id"] = "evil"
    with pytest.raises(ProtocolError, match="mac mismatch"):
        b.verify(signed)


def test_verify_rejects_id_addition() -> None:
    # If we sign without an id, an attacker who adds one must be rejected.
    a = Signer(SECRET)
    b = Signer(SECRET)
    signed = a.sign(Envelope(type="ping", body={}))
    signed["id"] = "injected"
    with pytest.raises(ProtocolError, match="mac mismatch"):
        b.verify(signed)


# ---------------------------------------------------------------------------
# Field validation
# ---------------------------------------------------------------------------


def test_verify_rejects_wrong_version() -> None:
    s = Signer(SECRET)
    raw = s.sign(Envelope(type="ping", body={}))
    raw["v"] = PROTOCOL_VERSION + 1
    with pytest.raises(ProtocolError, match="bad version"):
        s.verify(raw)


def test_verify_rejects_missing_ts() -> None:
    s = Signer(SECRET)
    raw = s.sign(Envelope(type="ping", body={}))
    del raw["ts"]
    with pytest.raises(ProtocolError, match="bad ts"):
        s.verify(raw)


def test_verify_rejects_missing_body() -> None:
    """_mac_input reads env["body"]; a frame without it must be a clean
    ProtocolError (skipped), not a KeyError that tears down the read loop."""
    s = Signer(SECRET)
    raw = s.sign(Envelope(type="ping", body={}))
    del raw["body"]
    with pytest.raises(ProtocolError, match="missing body"):
        s.verify(raw)


def test_verify_rejects_non_string_id() -> None:
    """The read loop uses id as a dict key (_pending.pop); an unhashable id
    must be a clean ProtocolError, not a TypeError teardown. The MAC can be
    valid here — the guard targets authenticated-but-buggy peers."""
    s = Signer(SECRET)
    for bad_id in ({"a": 1}, [1, 2], 7, None):
        signer = Signer(SECRET)
        raw = signer.sign(Envelope(type="tool_result", body={"ok": True}))
        raw["id"] = bad_id
        # Recompute a valid MAC over the tampered envelope so the id check
        # itself is what rejects (not the MAC comparison).
        env_no_mac = {k: v for k, v in raw.items() if k != "mac"}
        mac = hmac.new(SECRET, canonical_json(env_no_mac).encode(), hashlib.sha256).digest()
        raw["mac"] = base64.b64encode(mac).decode()
        with pytest.raises(ProtocolError, match="bad id"):
            s.verify(raw)


def test_verify_rejects_non_dict() -> None:
    s = Signer(SECRET)
    with pytest.raises(ProtocolError, match="not an object"):
        s.verify("not-a-dict")  # type: ignore[arg-type]


def test_verify_rejects_empty_type() -> None:
    s = Signer(SECRET)
    raw = s.sign(Envelope(type="ping", body={}))
    raw["type"] = ""
    with pytest.raises(ProtocolError, match="bad type"):
        s.verify(raw)


def test_verify_rejects_non_base64_mac() -> None:
    s = Signer(SECRET)
    raw = s.sign(Envelope(type="ping", body={}))
    raw["mac"] = "!!!not_base64!!!"
    with pytest.raises(ProtocolError, match="mac"):
        s.verify(raw)


# ---------------------------------------------------------------------------
# Timestamp skew
# ---------------------------------------------------------------------------


def test_verify_rejects_old_timestamp() -> None:
    s = Signer(SECRET)
    old_ts = int(time.time()) - MAX_CLOCK_SKEW_S - 5
    env = Envelope(type="ping", body={}, ts=old_ts)
    signed = s.sign(env)
    with pytest.raises(ProtocolError, match="skew"):
        s.verify(signed)


def test_verify_rejects_future_timestamp() -> None:
    s = Signer(SECRET)
    future_ts = int(time.time()) + MAX_CLOCK_SKEW_S + 5
    signed = s.sign(Envelope(type="ping", body={}, ts=future_ts))
    with pytest.raises(ProtocolError, match="skew"):
        s.verify(signed)


def test_verify_accepts_recent_timestamp() -> None:
    s = Signer(SECRET)
    just_within_ts = int(time.time()) - MAX_CLOCK_SKEW_S + 1
    signed = s.sign(Envelope(type="ping", body={}, ts=just_within_ts))
    # Use a fresh verifier so nonce isn't already seen.
    Signer(SECRET).verify(signed)


# ---------------------------------------------------------------------------
# Replay protection
# ---------------------------------------------------------------------------


def test_verify_rejects_replayed_nonce() -> None:
    s = Signer(SECRET)
    signed = s.sign(Envelope(type="ping", body={}))
    Signer(SECRET).verify(signed)  # first time on a fresh signer: ok
    # Same signed message again on the SAME signer instance: must reject.
    verifier = Signer(SECRET)
    verifier.verify(signed)
    with pytest.raises(ProtocolError, match="replay"):
        verifier.verify(signed)


def test_nonce_cache_evicts() -> None:
    # Push more than NONCE_CACHE_SIZE distinct nonces through verify; the
    # earliest ones should be evicted and would no longer trigger replay.
    v = Signer(SECRET)

    def sign_with_nonce(nonce: str) -> dict[str, object]:
        ts = int(time.time())
        env = {
            "v": PROTOCOL_VERSION,
            "ts": ts,
            "nonce": nonce,
            "type": "ping",
            "body": {},
        }
        mac = hmac.new(
            SECRET,
            canonical_json(env).encode(),
            hashlib.sha256,
        ).digest()
        env["mac"] = base64.b64encode(mac).decode()
        return env

    first_nonce = "n-0"
    v.verify(sign_with_nonce(first_nonce))
    for i in range(1, NONCE_CACHE_SIZE + 1):
        v.verify(sign_with_nonce(f"n-{i}"))
    # `first_nonce` has fallen out of the cache; replaying it must now succeed.
    v.verify(sign_with_nonce(first_nonce))


# ---------------------------------------------------------------------------
# Short secrets
# ---------------------------------------------------------------------------


def test_signer_rejects_short_secret() -> None:
    with pytest.raises(ValueError, match="too short"):
        Signer(b"\x00" * 8)


def test_signer_accepts_min_length_secret() -> None:
    s = Signer(b"\x00" * 16)
    Signer(b"\x00" * 16).verify(s.sign(Envelope(type="ping", body={})))


# ---------------------------------------------------------------------------
# Cross-language compatibility
# ---------------------------------------------------------------------------


def test_known_cross_language_mac() -> None:
    """The same vector is pinned in extension/test/crypto.test.ts.
    Both implementations must produce these exact bytes."""
    secret = bytes(32)
    env = {
        "v": 1,
        "ts": 1700000000,
        "nonce": "AAAAAAAAAAAAAAAAAAAAAA==",
        "type": "tool_call",
        "id": "req1",
        "body": {"name": "navigate", "args": {"url": "https://example.com/"}},
    }
    expected_mac = "/OcAjJGftRL4Aq+yomTyrqJCPIZWNINfGFYVbLUerM0="
    mac = base64.b64encode(
        hmac.new(secret, canonical_json(env).encode(), hashlib.sha256).digest()
    ).decode()
    assert mac == expected_mac
