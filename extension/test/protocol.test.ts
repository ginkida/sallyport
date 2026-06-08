import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/protocol.js';

describe('canonicalJson', () => {
  it('sorts keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('handles nested objects', () => {
    expect(canonicalJson({ outer: { z: 1, a: [3, 2, 1] } })).toBe('{"outer":{"a":[3,2,1],"z":1}}');
  });

  it('emits no whitespace', () => {
    expect(canonicalJson([1, 2, { k: 'v' }])).toBe('[1,2,{"k":"v"}]');
  });

  it('passes unicode through', () => {
    expect(canonicalJson({ k: 'тест' })).toBe('{"k":"тест"}');
  });

  it('matches the known vector pinned in daemon tests', () => {
    // The Python side has the same vector in test_protocol.py
    // (test_canonical_json_known_vector). Both implementations MUST
    // produce these bytes byte-for-byte. If you change this string, change
    // the Python test too.
    const env = {
      v: 1,
      ts: 1700000000,
      nonce: 'AAAAAAAAAAAAAAAAAAAAAA==',
      type: 'tool_call',
      id: 'req1',
      body: { name: 'navigate', args: { url: 'https://example.com/' } },
    };
    const expected =
      '{"body":{"args":{"url":"https://example.com/"},"name":"navigate"},' +
      '"id":"req1","nonce":"AAAAAAAAAAAAAAAAAAAAAA==","ts":1700000000,' +
      '"type":"tool_call","v":1}';
    expect(canonicalJson(env)).toBe(expected);
  });

  it('handles null and primitives', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('hi')).toBe('"hi"');
  });

  it('handles empty containers', () => {
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });
});

describe('canonicalJson — numbers (Python repr is the cross-language reference)', () => {
  it('formats non-integral (and ≥1e21) floats exactly like CPython repr', () => {
    // Same IEEE-754 doubles, divergent native formatting: JS toString says
    // '1e-7' / '0.000001' where Python repr says '1e-07' / '1e-06'. The
    // fixture vectors pin these cross-language; these are the fast local
    // checks.
    expect(canonicalJson(0.5)).toBe('0.5');
    expect(canonicalJson(0.1)).toBe('0.1');
    expect(canonicalJson(3.141592653589793)).toBe('3.141592653589793');
    expect(canonicalJson(0.0001)).toBe('0.0001'); // last fixed-notation magnitude
    expect(canonicalJson(1e-5)).toBe('1e-05');
    expect(canonicalJson(1e-6)).toBe('1e-06');
    expect(canonicalJson(1e-7)).toBe('1e-07');
    expect(canonicalJson(-1.5e-7)).toBe('-1.5e-07');
    expect(canonicalJson(1e21)).toBe('1e+21');
    expect(canonicalJson(1.5e22)).toBe('1.5e+22');
    expect(canonicalJson(1e100)).toBe('1e+100');
    expect(canonicalJson(5e-324)).toBe('5e-324'); // smallest subnormal
    expect(canonicalJson(1000000000000000.5)).toBe('1000000000000000.5');
  });

  it('renders integral doubles below 1e21 as bare digits', () => {
    // EXACTLY the bytes JSON.stringify puts on the wire frame, so the
    // daemon's re-parse recanonicalises to the same MAC input. Python
    // renders the same shortest-digit form (protocol.py:_format_number).
    expect(canonicalJson(2)).toBe('2');
    expect(canonicalJson(-0)).toBe('0'); // matches Python
    expect(canonicalJson(1e15)).toBe('1000000000000000');
    expect(canonicalJson(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
    expect(canonicalJson(-Number.MAX_SAFE_INTEGER)).toBe('-9007199254740991');
    // The window [2^53, 1e21): CPython repr would say '9007199254740992.0'
    // or '1e+16', but the wire carries bare integers there.
    expect(canonicalJson(9007199254740992)).toBe('9007199254740992'); // 2^53
    expect(canonicalJson(1e16)).toBe('10000000000000000');
    expect(canonicalJson(1.2e16)).toBe('12000000000000000');
    expect(canonicalJson(1.7e18)).toBe('1700000000000000000'); // snowflake-style ID
    expect(canonicalJson(2 ** 60)).toBe('1152921504606847000'); // shortest, not exact
    expect(canonicalJson(-(2 ** 60))).toBe('-1152921504606847000');
    expect(canonicalJson(9.999999999999999e20)).toBe('999999999999999900000');
  });

  it('agrees with JSON.stringify for every number form (wire parity)', () => {
    // The wire frame is JSON.stringify(env); for NUMBERS the daemon parses
    // the wire text and recanonicalises. Integral doubles < 1e21 must
    // therefore canonicalise to the exact wire bytes. (Non-integral floats
    // may differ in FORM — '1e-07' vs '1e-7' — but parse to the same
    // double, which recanonicalises identically; integers parse as Python
    // ints, where only the digit string itself survives.)
    const integralCases = [
      0,
      -0,
      2,
      1e15,
      9007199254740991,
      9007199254740992,
      1e16,
      1.7e18,
      2 ** 60,
      9.999999999999999e20,
    ];
    for (const x of integralCases) {
      expect(canonicalJson(x)).toBe(JSON.stringify(x));
    }
    // At/above 1e21 JSON.stringify itself uses exponent notation and the
    // daemon parses a float again — forms must still agree.
    expect(canonicalJson(1e21)).toBe(JSON.stringify(1e21));
    expect(canonicalJson(1.5e22)).toBe(JSON.stringify(1.5e22));
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ k: NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ k: Infinity })).toThrow(/non-finite/);
    expect(() => canonicalJson({ k: -Infinity })).toThrow(/non-finite/);
  });
});

describe('canonicalJson — key ordering and strings', () => {
  it('sorts keys by Unicode code point, not UTF-16 code units', () => {
    // U+FFFD (0xFFFD) < U+1F600 (0x1F600) by code point, but the emoji's
    // lead surrogate (0xD83D) sorts first under a plain Array.sort().
    // Python's sort_keys is the reference (same vectors in the fixture).
    expect(canonicalJson({ '\u{1F600}': 2, '�': 1 })).toBe('{"�":1,"\u{1F600}":2}');
    expect(canonicalJson({ '\u{10000}': 2, '\uE000': 1 })).toBe('{"\uE000":1,"\u{10000}":2}');
  });

  it('rejects lone surrogates', () => {
    // No UTF-8 encoding exists, so the daemon could never verify the MAC.
    expect(() => canonicalJson({ k: '\uD800' })).toThrow(/lone surrogate/);
    expect(() => canonicalJson({ k: 'tail\uDFFF' })).toThrow(/lone surrogate/);
    expect(() => canonicalJson({ '\uD800': 1 })).toThrow(/lone surrogate/);
    // A valid pair is fine.
    expect(canonicalJson({ k: '😀' })).toBe('{"k":"😀"}');
  });

  it('rejects unsupported types', () => {
    expect(() => canonicalJson({ k: 10n })).toThrow(/unsupported type/);
    expect(() => canonicalJson(undefined)).toThrow(/unsupported type/);
  });
});

describe('canonicalJson — wire (JSON.stringify) parity', () => {
  // The wire frame is JSON.stringify(env) and the peer recomputes the MAC
  // from the *parsed* frame — so canonical bytes must agree with what
  // JSON.stringify actually puts on the wire.
  it('drops undefined-valued object entries like JSON.stringify does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('renders undefined array elements as null like JSON.stringify does', () => {
    expect(canonicalJson([1, undefined, 2])).toBe('[1,null,2]');
  });

  it('honours toJSON like JSON.stringify does', () => {
    const date = new Date('2026-01-02T03:04:05.000Z');
    expect(canonicalJson({ at: date })).toBe('{"at":"2026-01-02T03:04:05.000Z"}');
  });
});
