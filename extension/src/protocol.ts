// Wire protocol shared with the daemon.
//
// Every envelope is JSON of the form:
//   { v, ts, nonce, type, id?, mac, body }
// where `mac = HMAC-SHA256(secret, canonical_json({v, ts, nonce, type, id, body}))`
// encoded as base64. Both sides verify mac, reject if ts is older than
// MAX_CLOCK_SKEW_S, and reject if nonce has been seen recently.

export const PROTOCOL_VERSION = 1;
export const MAX_CLOCK_SKEW_S = 30;
export const NONCE_CACHE_SIZE = 4096;

export type ToolCallBody = {
  name: string;
  args: Record<string, unknown>;
};

export type ToolResultBody =
  { ok: true; data: unknown } | { ok: false; error: string; code?: string };

export type HelloBody = {
  extensionVersion: string;
};

export type EnvelopeIn =
  | { type: 'hello_ack'; body: Record<string, never> }
  | { type: 'ping'; body: Record<string, never> }
  | { type: 'pong'; body: Record<string, never> }
  | { type: 'tool_call'; id: string; body: ToolCallBody };

export type EnvelopeOut =
  | { type: 'hello'; body: HelloBody }
  | { type: 'ping'; body: Record<string, never> }
  | { type: 'pong'; body: Record<string, never> }
  | { type: 'tool_result'; id: string; body: ToolResultBody };

export type SignedEnvelope = {
  v: number;
  ts: number;
  nonce: string;
  type: string;
  id?: string;
  body: unknown;
  mac: string;
};

// ECMAScript's Number::toString switches from positional digits to exponent
// notation at 1e21. Below that bound an integral double goes on the wire
// (JSON.stringify) as bare digits, so the canonical form must be those same
// digits; at/above it both languages use the scientific repr form. The
// daemon pins the same bound (_INTEGRAL_DIGITS_BOUND in protocol.py).
const INTEGRAL_DIGITS_BOUND = 1e21;

// A high or low surrogate code unit outside a valid pair. Such a string has
// no UTF-8 encoding, so the daemon could never verify the MAC — reject at
// signing time instead of stranding the call (protocol.py rejects likewise).
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Sort by Unicode code point — what Python's sort_keys does. A plain
// Array.sort() compares UTF-16 code units, which puts astral-plane keys
// (surrogate pairs, 0xD800+) BEFORE U+E000..U+FFFF and diverges from Python.
function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(j) as number;
    if (ca !== cb) return ca - cb;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return a.length - i - (b.length - j);
}

// Format a float exactly like CPython's float.__repr__ (which json.dumps
// uses): shortest round-trip digits, fixed notation when the decimal
// exponent is in [-4, 16), otherwise scientific with an explicit sign and
// at least two exponent digits ('1e-07', '1.5e+22'). Only called for
// non-integral doubles (which always have a fractional digit, so exp10 <
// digits.length - 1) and integral doubles ≥ 1e21 (exp10 ≥ 21 → scientific):
// integral doubles below 1e21 take the bare-digits path in canonicalNumber.
function pythonFloatRepr(x: number): string {
  const neg = x < 0;
  // toExponential() without an argument yields the shortest digit string
  // that uniquely identifies the double — the same digits CPython derives.
  const [mantissa, expPart] = Math.abs(x).toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const exp10 = parseInt(expPart, 10);
  let out: string;
  if (exp10 >= -4 && exp10 < 16) {
    if (exp10 >= 0) {
      out = digits.slice(0, exp10 + 1) + '.' + digits.slice(exp10 + 1);
    } else {
      out = '0.' + '0'.repeat(-exp10 - 1) + digits;
    }
  } else {
    const m = digits.length > 1 ? digits[0] + '.' + digits.slice(1) : digits;
    const sign = exp10 < 0 ? '-' : '+';
    out = m + 'e' + sign + String(Math.abs(exp10)).padStart(2, '0');
  }
  return neg ? '-' + out : out;
}

function canonicalNumber(x: number): string {
  if (!Number.isFinite(x)) {
    throw new Error('non-finite number in canonical JSON');
  }
  if (Number.isInteger(x) && Math.abs(x) < INTEGRAL_DIGITS_BOUND) {
    // Integral doubles below 1e21 canonicalise as bare digits — EXACTLY the
    // bytes JSON.stringify puts on the wire frame, so the daemon's re-parse
    // recanonicalises to the same MAC input. The daemon renders the same
    // shortest-digit form from CPython repr (protocol.py:_format_number).
    // Also folds -0 to '0', matching Python.
    return String(x);
  }
  return pythonFloatRepr(x);
}

function canonicalString(s: string): string {
  if (LONE_SURROGATE.test(s)) {
    throw new Error('lone surrogate in canonical JSON string');
  }
  return JSON.stringify(s);
}

// What JSON.stringify drops from objects (and nulls inside arrays). The wire
// frame is JSON.stringify(env), so the canonical bytes must agree with what
// the peer re-parses — otherwise the MAC never verifies.
function isOmitted(v: unknown): boolean {
  return v === undefined || typeof v === 'function' || typeof v === 'symbol';
}

// Canonical JSON: deterministic key ordering + number/string normalisation so
// both sides produce identical bytes. Mirrors protocol.py:canonical_json —
// change them together and regenerate fixtures/canonical-vectors.json.
// Throws on values that cannot round-trip identically through both languages
// (NaN/Infinity, lone surrogates).
export function canonicalJson(value: unknown): string {
  let v = value;
  // JSON.stringify honours toJSON (e.g. Date → ISO string); the wire frame
  // goes through JSON.stringify, so the MAC input must match.
  if (v !== null && typeof v === 'object') {
    const toJSON = (v as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') v = (toJSON as () => unknown).call(v);
  }
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      return canonicalNumber(v);
    case 'string':
      return canonicalString(v);
    case 'object':
      break;
    default:
      throw new Error(`unsupported type in canonical JSON: ${typeof v}`);
  }
  if (Array.isArray(v)) {
    return '[' + v.map((el) => (isOmitted(el) ? 'null' : canonicalJson(el))).join(',') + ']';
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => !isOmitted(obj[k]))
    .sort(compareCodePoints);
  return '{' + keys.map((k) => canonicalString(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}
