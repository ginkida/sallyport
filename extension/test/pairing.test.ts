import { describe, expect, it } from 'vitest';
import { classifySecretInput, EXPECTED_SECRET_BYTES, extractSecret } from '../src/pairing.js';

// A 32-byte secret base64-encodes to exactly 44 chars ending in '='.
const SECRET_32 = 'A'.repeat(43) + '=';
// A shorter but still-valid 16-byte secret (the daemon's documented floor).
const SECRET_16 = 'B'.repeat(22) + '==';

describe('extractSecret', () => {
  it('returns the raw secret when pasted alone', () => {
    const out = extractSecret(SECRET_32);
    expect(out?.token).toBe(SECRET_32);
    expect(out?.bytes).toBe(32);
  });

  it('trims surrounding whitespace', () => {
    const out = extractSecret(`   ${SECRET_32}   \n`);
    expect(out?.token).toBe(SECRET_32);
  });

  it('extracts secret from the full daemon banner', () => {
    const banner = `
      ${'='.repeat(70)}
      Sallyport: new secret generated at /home/u/.config/sallyport/secret
      Paste this into the extension popup (Pair tab):

        ${SECRET_32}

      ${'='.repeat(70)}
    `;
    const out = extractSecret(banner);
    expect(out?.token).toBe(SECRET_32);
    expect(out?.bytes).toBe(32);
  });

  it('returns null when there is no plausible secret', () => {
    expect(extractSecret('')).toBeNull();
    expect(extractSecret('hello world')).toBeNull();
    expect(extractSecret('paste the secret here')).toBeNull();
  });

  it('rejects tokens shorter than 16 decoded bytes', () => {
    // 4-char b64 = 3 bytes — far below the floor.
    expect(extractSecret('abcd')).toBeNull();
    // 20-char b64 = 15 bytes — one byte short.
    expect(extractSecret('A'.repeat(19) + '=')).toBeNull();
  });

  it('rejects the daemon banner ===== rule lines', () => {
    expect(extractSecret('='.repeat(70))).toBeNull();
  });

  it('rejects file paths with dots / dashes', () => {
    expect(extractSecret('/home/.config/sallyport/secret')).toBeNull();
    expect(extractSecret('~/.config/sallyport/secret-file')).toBeNull();
  });

  it('prefers the longest valid candidate when several match', () => {
    // A long alphanumeric path that happens to decode > 16 bytes, plus the
    // real secret. We want the longer one (the actual secret).
    const fakePath = 'Users' + 'A'.repeat(35); // 40 chars → 30 bytes
    const out = extractSecret(`${fakePath} something ${SECRET_32}`);
    expect(out?.token).toBe(SECRET_32);
  });

  it('handles 16-byte secrets (the documented minimum)', () => {
    const out = extractSecret(SECRET_16);
    expect(out?.token).toBe(SECRET_16);
    expect(out?.bytes).toBe(16);
  });

  it('ignores tokens that fail base64 decode (bad length)', () => {
    // 25 chars — not a multiple of 4. Even if the chars are all valid b64
    // alphabet, the length disqualifies it before atob is called.
    expect(extractSecret('A'.repeat(25))).toBeNull();
  });
});

describe('classifySecretInput (#15 — non-32-byte warning)', () => {
  it('reports empty for whitespace-only input', () => {
    expect(classifySecretInput('')).toEqual({ kind: 'empty' });
    expect(classifySecretInput('   \n ')).toEqual({ kind: 'empty' });
  });

  it('reports none when no plausible secret is present', () => {
    expect(classifySecretInput('paste the secret here')).toEqual({ kind: 'none' });
  });

  it('reports ok for exactly the daemon 32-byte secret', () => {
    expect(classifySecretInput(SECRET_32)).toEqual({
      kind: 'ok',
      token: SECRET_32,
      bytes: EXPECTED_SECRET_BYTES,
    });
  });

  it('flags a plausible but wrong-length secret (truncated paste) yet keeps the token', () => {
    // 16 decoded bytes — valid base64, below the daemon's 32, so pairing would
    // mac-mismatch. Warn, but still carry the token so the user may try.
    const out = classifySecretInput(SECRET_16);
    expect(out).toEqual({ kind: 'wrong_length', token: SECRET_16, bytes: 16 });
  });

  it('extracts + classifies the 32-byte secret out of the full banner', () => {
    const banner = `Sallyport secret:\n\n  ${SECRET_32}\n\n${'='.repeat(40)}`;
    expect(classifySecretInput(banner)).toMatchObject({ kind: 'ok', bytes: 32 });
  });
});
