#!/usr/bin/env python3
"""Generate the cross-language canonical-JSON / HMAC vector fixtures.

This script is the source of truth for `fixtures/canonical-vectors.json`.
Both the daemon's pytest suite and the extension's vitest suite read that
file and assert that their own canonical-JSON and HMAC implementations
produce the same bytes.

If you change the canonicalisation rules in `protocol.py`, also update the
matching code in `extension/src/protocol.ts`, regenerate this file, and let
both test suites re-pin.

Run from repo root:

    python3 fixtures/generate.py
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import sys
from pathlib import Path

# Add daemon's source to PYTHONPATH so we use the production canonical_json.
REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "daemon" / "src"))

from sallyport_daemon.protocol import canonical_json  # noqa: E402

# A 32-byte secret of all-zeros — same as the unit tests use.
SECRET = bytes(32)

CASES: list[dict[str, object]] = [
    # ── primitives ────────────────────────────────────────────────────────
    {"name": "null", "input": None},
    {"name": "bool_true", "input": True},
    {"name": "bool_false", "input": False},
    {"name": "int_zero", "input": 0},
    {"name": "int_positive", "input": 42},
    {"name": "int_negative", "input": -7},
    {"name": "string_empty", "input": ""},
    {"name": "string_simple", "input": "hello"},
    # ── containers ────────────────────────────────────────────────────────
    {"name": "object_empty", "input": {}},
    {"name": "array_empty", "input": []},
    # ── key ordering (the heart of "canonical") ──────────────────────────
    {"name": "object_reverse_keys", "input": {"z": 1, "a": 2, "m": 3}},
    {
        "name": "object_numeric_string_keys",
        # Sorted as strings, so "10" < "2".
        "input": {"2": "two", "10": "ten", "1": "one"},
    },
    {
        "name": "object_unicode_keys",
        "input": {"тест": 1, "abc": 2, "🔑": 3},
    },
    # ── nested ───────────────────────────────────────────────────────────
    {
        "name": "nested_three_deep",
        "input": {"outer": {"middle": {"inner": [1, 2, 3]}}},
    },
    {
        "name": "array_of_mixed",
        "input": [1, "two", None, True, {"k": "v"}],
    },
    # ── unicode payloads ─────────────────────────────────────────────────
    {"name": "string_cyrillic", "input": {"k": "тест"}},
    {"name": "string_emoji", "input": {"k": "💀🔐🚀"}},
    {"name": "string_with_quote", "input": {"k": 'has "quote" inside'}},
    {"name": "string_with_backslash", "input": {"k": "back\\slash"}},
    {"name": "string_with_newline", "input": {"k": "line\nbreak"}},
    # ── tricky numbers ───────────────────────────────────────────────────
    {"name": "negative_zero", "input": {"k": -0}},
    {"name": "large_int", "input": {"k": 9007199254740991}},  # Number.MAX_SAFE_INTEGER
    {"name": "large_int_negative", "input": {"k": -9007199254740991}},
    # ── floats (Python repr formatting is the cross-language reference) ──
    # These pin exactly the cases where a naive JSON.stringify diverges
    # from Python json.dumps: exponent-notation thresholds differ (Python
    # switches at 1e-4 and 1e16, JS at 1e-6 and 1e21) and Python pads the
    # exponent to two digits ('1e-07' vs JS '1e-7').
    {"name": "float_half", "input": {"k": 0.5}},
    {"name": "float_pi", "input": {"k": 3.141592653589793}},
    {"name": "float_tenths_array", "input": [0.1, 0.2, 0.3]},
    {"name": "float_fixed_low_boundary", "input": {"k": 0.0001}},
    {"name": "float_sci_1e-5", "input": {"k": 1e-05}},
    {"name": "float_sci_1e-6", "input": {"k": 1e-06}},
    {"name": "float_sci_1e-7", "input": {"k": 1e-07}},
    {"name": "float_sci_negative_mantissa", "input": {"k": -1.5e-07}},
    {"name": "float_sci_1e21", "input": {"k": 1e21}},
    {"name": "float_subnormal_min", "input": {"k": 5e-324}},
    {"name": "float_fixed_long_fraction", "input": {"k": 1000000000000000.5}},
    # Integral doubles below 1e21 canonicalise as bare shortest digits —
    # exactly what the extension's JSON.stringify puts on the wire, so the
    # daemon's re-parse recanonicalises to the same MAC input. These pin
    # the whole window [2^53, 1e21) where JS wire output is a bare integer
    # while CPython repr would use '.0' / exponent forms.
    {"name": "float_integral_normalises", "input": {"k": 2.0}},
    {"name": "float_negative_zero_normalises", "input": {"k": -0.0}},
    {"name": "float_integral_2pow53", "input": {"k": 9007199254740992.0}},
    {"name": "float_integral_1e16", "input": {"k": 1e16}},
    {"name": "float_integral_1p2e16", "input": {"k": 1.2e16}},
    {"name": "float_integral_snowflake", "input": {"k": 1.7e18}},
    {"name": "float_integral_just_below_1e21", "input": {"k": 999999999999999916544.0}},
    # Ints above 2^53-1 are accepted iff double-exact (2^60) or already in
    # the shortest-digit form JS emits; both canonicalise to the SAME
    # shortest rendering. 10^21 is double-exact and crosses into the
    # exponent-notation range.
    {"name": "int_exact_2pow60", "input": {"k": 1152921504606846976}},
    {"name": "int_shortest_2pow60", "input": {"k": 1152921504606847000}},
    {"name": "int_exact_1e21", "input": {"k": 10**21}},
    # ── key ordering across the BMP boundary ─────────────────────────────
    # U+FFFD < U+1F600 by code point, but a UTF-16 code-unit sort would put
    # the surrogate pair (0xD83D…) first. Pins the code-point rule.
    {"name": "object_keys_astral_vs_bmp", "input": {"\U0001f600": 2, "\ufffd": 1}},
    {"name": "object_keys_private_use_vs_astral", "input": {"\U00010000": 2, "\ue000": 1}},
    # ── realistic envelope (echoes the existing pinned vector) ───────────
    {
        "name": "envelope_tool_call",
        "input": {
            "v": 1,
            "ts": 1700000000,
            "nonce": "AAAAAAAAAAAAAAAAAAAAAA==",
            "type": "tool_call",
            "id": "req1",
            "body": {"name": "navigate", "args": {"url": "https://example.com/"}},
        },
    },
    {
        "name": "envelope_tool_result_ok",
        "input": {
            "v": 1,
            "ts": 1700000001,
            "nonce": "BBBBBBBBBBBBBBBBBBBBBB==",
            "type": "tool_result",
            "id": "req1",
            "body": {"ok": True, "data": {"tabId": 7, "url": "https://example.com/"}},
        },
    },
    {
        "name": "envelope_tool_result_error",
        "input": {
            "v": 1,
            "ts": 1700000002,
            "nonce": "CCCCCCCCCCCCCCCCCCCCCC==",
            "type": "tool_result",
            "id": "req2",
            "body": {"ok": False, "error": "evil.com is not in the allowlist",
                     "code": "domain_not_allowed"},
        },
    },
]


def main() -> None:
    out_path = Path(__file__).parent / "canonical-vectors.json"
    out: list[dict[str, object]] = []
    for case in CASES:
        canonical = canonical_json(case["input"])
        mac_bytes = hmac.new(SECRET, canonical.encode("utf-8"), hashlib.sha256).digest()
        mac_b64 = base64.b64encode(mac_bytes).decode("ascii")
        out.append({
            "name": case["name"],
            "input": case["input"],
            "canonical": canonical,
            "mac_b64": mac_b64,
        })
    # Pretty so diffs are readable; the canonical/mac fields stay byte-stable.
    out_path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(out)} vectors to {out_path}")


if __name__ == "__main__":
    main()
