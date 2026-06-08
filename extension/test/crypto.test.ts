import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { Signer, decodeSecret } from '../src/crypto.js';
import { canonicalJson, MAX_CLOCK_SKEW_S } from '../src/protocol.js';

const SECRET_BYTES = new Uint8Array(32);
for (let i = 0; i < 32; i++) SECRET_BYTES[i] = 0;
const SECRET_OTHER_BYTES = new Uint8Array(32);
for (let i = 0; i < 32; i++) SECRET_OTHER_BYTES[i] = 0x11;

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

async function makeSigner(secret: Uint8Array): Promise<Signer> {
  const s = new Signer();
  await s.setSecret(secret);
  return s;
}

describe('decodeSecret', () => {
  it('round-trips base64', () => {
    expect(decodeSecret(b64(SECRET_BYTES))).toEqual(SECRET_BYTES);
  });

  it('throws on empty', () => {
    expect(() => decodeSecret('')).toThrow(/empty/);
  });

  it('throws on short secret', () => {
    const short = b64(new Uint8Array(8));
    expect(() => decodeSecret(short)).toThrow(/too short/);
  });

  it('throws on non-base64', () => {
    expect(() => decodeSecret('!!!not base64!!!')).toThrow(/invalid/);
  });

  it('strips whitespace', () => {
    const padded = '  ' + b64(SECRET_BYTES) + '\n';
    expect(decodeSecret(padded)).toEqual(SECRET_BYTES);
  });
});

describe('Signer.sign / verify roundtrip', () => {
  it('signs and verifies a simple envelope', async () => {
    const s = await makeSigner(SECRET_BYTES);
    const signed = await s.sign('hello', { v: '1' });
    const verifier = await makeSigner(SECRET_BYTES);
    const v = await verifier.verify(signed);
    expect(v.type).toBe('hello');
    expect(v.body).toEqual({ v: '1' });
  });

  it('preserves id', async () => {
    const s = await makeSigner(SECRET_BYTES);
    const signed = await s.sign('tool_call', { name: 'x' }, 'abc');
    const v = await makeSigner(SECRET_BYTES);
    const verified = await v.verify(signed);
    expect(verified.id).toBe('abc');
  });

  it('produces all required fields', async () => {
    const s = await makeSigner(SECRET_BYTES);
    const out = await s.sign('ping', {});
    for (const k of ['v', 'ts', 'nonce', 'type', 'body', 'mac']) {
      expect(out, k).toHaveProperty(k);
    }
    expect(out.v).toBe(1);
  });

  it('omits id when not given', async () => {
    const s = await makeSigner(SECRET_BYTES);
    const out = await s.sign('ping', {});
    expect(out.id).toBeUndefined();
  });
});

describe('Signer.verify authentication failures', () => {
  it('rejects wrong secret', async () => {
    const a = await makeSigner(SECRET_BYTES);
    const b = await makeSigner(SECRET_OTHER_BYTES);
    const signed = await a.sign('ping', {});
    await expect(b.verify(signed)).rejects.toThrow(/mac mismatch/);
  });

  it('rejects tampered body', async () => {
    const a = await makeSigner(SECRET_BYTES);
    const v = await makeSigner(SECRET_BYTES);
    const signed = await a.sign('tool_call', { name: 'navigate' });
    signed.body = { name: 'exfiltrate' };
    await expect(v.verify(signed)).rejects.toThrow(/mac mismatch/);
  });

  it('rejects tampered type', async () => {
    const a = await makeSigner(SECRET_BYTES);
    const v = await makeSigner(SECRET_BYTES);
    const signed = await a.sign('ping', {});
    signed.type = 'hello';
    await expect(v.verify(signed)).rejects.toThrow(/mac mismatch/);
  });

  it('rejects tampered id', async () => {
    const a = await makeSigner(SECRET_BYTES);
    const v = await makeSigner(SECRET_BYTES);
    const signed = await a.sign('tool_call', {}, 'orig');
    signed.id = 'evil';
    await expect(v.verify(signed)).rejects.toThrow(/mac mismatch/);
  });

  it('rejects id added after the fact', async () => {
    const a = await makeSigner(SECRET_BYTES);
    const v = await makeSigner(SECRET_BYTES);
    const signed = await a.sign('ping', {});
    signed.id = 'injected';
    await expect(v.verify(signed)).rejects.toThrow(/mac mismatch/);
  });
});

describe('Signer.verify field validation', () => {
  it('rejects wrong version', async () => {
    const s = await makeSigner(SECRET_BYTES);
    const signed = await s.sign('ping', {});
    signed.v = 2;
    await expect(s.verify(signed)).rejects.toThrow(/version/);
  });

  it('rejects missing ts', async () => {
    const s = await makeSigner(SECRET_BYTES);
    const signed = await s.sign('ping', {});
    delete (signed as Record<string, unknown>).ts;
    await expect(s.verify(signed)).rejects.toThrow(/ts/);
  });

  it('rejects non-object input', async () => {
    const s = await makeSigner(SECRET_BYTES);
    await expect(s.verify('not-an-object')).rejects.toThrow(/object/);
  });

  it('rejects empty type', async () => {
    const s = await makeSigner(SECRET_BYTES);
    const signed = await s.sign('ping', {});
    signed.type = '';
    await expect(s.verify(signed)).rejects.toThrow(/type/);
  });

  it('rejects non-base64 mac', async () => {
    const s = await makeSigner(SECRET_BYTES);
    const signed = await s.sign('ping', {});
    signed.mac = '!!!not base64!!!';
    await expect(s.verify(signed)).rejects.toThrow();
  });

  it('rejects non-string id', async () => {
    // Mirrors the daemon's guard: tool routing treats id as an opaque
    // string key; a dict/number id from an authenticated-but-buggy peer
    // must be a malformed frame, not a crash deeper in the pipeline.
    const s = await makeSigner(SECRET_BYTES);
    for (const badId of [{ a: 1 }, [1, 2], 7, null]) {
      const signed = await s.sign('tool_call', { name: 'x', args: {} });
      (signed as Record<string, unknown>).id = badId;
      await expect(s.verify(signed)).rejects.toThrow(/bad id/);
    }
  });
});

describe('Signer.verify timestamp skew', () => {
  it('rejects timestamps too far in the past', async () => {
    const s = await makeSigner(SECRET_BYTES);
    const signed = await s.sign('ping', {});
    signed.ts = signed.ts - MAX_CLOCK_SKEW_S - 5;
    // Re-sign with the tampered ts to get a valid MAC for the bad ts.
    const reSigned = await reSign(signed);
    await expect(s.verify(reSigned)).rejects.toThrow(/skew/);
  });

  it('rejects timestamps too far in the future', async () => {
    const s = await makeSigner(SECRET_BYTES);
    const signed = await s.sign('ping', {});
    signed.ts = signed.ts + MAX_CLOCK_SKEW_S + 5;
    const reSigned = await reSign(signed);
    await expect(s.verify(reSigned)).rejects.toThrow(/skew/);
  });
});

describe('Signer.verify replay protection', () => {
  it('rejects a replayed nonce', async () => {
    const s = await makeSigner(SECRET_BYTES);
    const signed = await s.sign('ping', {});
    const v = await makeSigner(SECRET_BYTES);
    await v.verify(signed);
    await expect(v.verify(signed)).rejects.toThrow(/replay/);
  });
});

describe('cross-language compatibility', () => {
  // PINNED VECTOR: HMAC-SHA256 of a known canonical envelope with a known
  // 32-zero-byte secret. The daemon's pytest suite pins the SAME bytes
  // (test_known_cross_language_mac). If you change this, change both.
  const FIXED_ENV = {
    v: 1,
    ts: 1700000000,
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA==',
    type: 'tool_call',
    id: 'req1',
    body: { name: 'navigate', args: { url: 'https://example.com/' } },
  };
  const EXPECTED_MAC = '/OcAjJGftRL4Aq+yomTyrqJCPIZWNINfGFYVbLUerM0=';

  it('Node node:crypto reproduces the pinned MAC', () => {
    const mac = createHmac('sha256', Buffer.from(SECRET_BYTES))
      .update(canonicalJson(FIXED_ENV))
      .digest('base64');
    expect(mac).toBe(EXPECTED_MAC);
  });

  it('our WebCrypto Signer accepts an envelope MACed with the pinned bytes', async () => {
    const s = await makeSigner(SECRET_BYTES);
    const env = { ...FIXED_ENV, mac: EXPECTED_MAC };
    // The fixed ts is in the past, so verify rejects on skew. Adjust ts and
    // re-MAC to exercise the MAC path itself.
    const live = {
      ...FIXED_ENV,
      ts: Math.floor(Date.now() / 1000),
    };
    const liveMac = createHmac('sha256', Buffer.from(SECRET_BYTES))
      .update(canonicalJson(live))
      .digest('base64');
    await expect(s.verify({ ...live, mac: liveMac })).resolves.toBeTruthy();
    // And the historical envelope is rejected for the right reason.
    await expect(s.verify(env)).rejects.toThrow(/skew/);
  });
});

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

async function reSign(env: Record<string, unknown>): Promise<Record<string, unknown>> {
  const macInput = canonicalJson({
    v: env.v,
    ts: env.ts,
    nonce: env.nonce,
    type: env.type,
    ...(env.id !== undefined ? { id: env.id } : {}),
    body: env.body,
  });
  const mac = createHmac('sha256', Buffer.from(SECRET_BYTES)).update(macInput).digest('base64');
  return { ...env, mac };
}
