import {
  canonicalJson,
  MAX_CLOCK_SKEW_S,
  NONCE_CACHE_SIZE,
  PROTOCOL_VERSION,
  type SignedEnvelope,
} from './protocol.js';

function b64encode(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function decodeSecret(b64: string): Uint8Array {
  const trimmed = b64.trim();
  if (!trimmed) throw new Error('secret is empty');
  try {
    const bytes = b64decode(trimmed);
    if (bytes.length < 16) throw new Error('secret too short');
    return bytes;
  } catch (e) {
    throw new Error('invalid secret (base64): ' + (e as Error).message);
  }
}

async function importKey(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    secret as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function macInputBytes(env: Omit<SignedEnvelope, 'mac'>): Uint8Array {
  // Body for MAC excludes `mac` itself but includes everything else, canonical.
  const input: Record<string, unknown> = {
    v: env.v,
    ts: env.ts,
    nonce: env.nonce,
    type: env.type,
    body: env.body,
  };
  if (env.id !== undefined) input.id = env.id;
  return new TextEncoder().encode(canonicalJson(input));
}

function constantTimeEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc |= a[i] ^ b[i];
  return acc === 0;
}

export class Signer {
  private key: CryptoKey | null = null;
  private seenNonces: string[] = [];
  private seenSet = new Set<string>();

  async setSecret(secret: Uint8Array): Promise<void> {
    this.key = await importKey(secret);
    this.seenNonces = [];
    this.seenSet.clear();
  }

  clear(): void {
    this.key = null;
    this.seenNonces = [];
    this.seenSet.clear();
  }

  hasSecret(): boolean {
    return this.key !== null;
  }

  async sign(type: string, body: unknown, id?: string): Promise<SignedEnvelope> {
    if (!this.key) throw new Error('signer has no secret');
    const nonceBytes = new Uint8Array(16);
    crypto.getRandomValues(nonceBytes);
    const env: Omit<SignedEnvelope, 'mac'> = {
      v: PROTOCOL_VERSION,
      ts: Math.floor(Date.now() / 1000),
      nonce: b64encode(nonceBytes),
      type,
      body,
    };
    if (id !== undefined) env.id = id;
    const sig = await crypto.subtle.sign(
      'HMAC',
      this.key,
      macInputBytes(env) as unknown as BufferSource,
    );
    return { ...env, mac: b64encode(sig) };
  }

  async verify(raw: unknown): Promise<SignedEnvelope> {
    if (!this.key) throw new Error('signer has no secret');
    if (!raw || typeof raw !== 'object') throw new Error('not an object');
    const env = raw as SignedEnvelope;

    if (env.v !== PROTOCOL_VERSION) throw new Error(`bad version: ${env.v}`);
    if (typeof env.ts !== 'number') throw new Error('bad ts');
    if (typeof env.nonce !== 'string' || !env.nonce) throw new Error('bad nonce');
    if (typeof env.type !== 'string' || !env.type) throw new Error('bad type');
    if (typeof env.mac !== 'string' || !env.mac) throw new Error('bad mac');
    // Mirrors the daemon's guard: tool routing treats id as an opaque
    // string key; any other type is a malformed frame, not a crash.
    if (env.id !== undefined && typeof env.id !== 'string') throw new Error('bad id');

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - env.ts) > MAX_CLOCK_SKEW_S) {
      throw new Error(`timestamp skew: ${now - env.ts}s`);
    }

    if (this.seenSet.has(env.nonce)) {
      throw new Error('nonce replay');
    }

    const expected = await crypto.subtle.sign(
      'HMAC',
      this.key,
      macInputBytes(env) as unknown as BufferSource,
    );
    let provided: Uint8Array;
    try {
      provided = b64decode(env.mac);
    } catch {
      throw new Error('mac not base64');
    }
    if (!constantTimeEq(new Uint8Array(expected), provided)) {
      throw new Error('mac mismatch');
    }

    this.seenSet.add(env.nonce);
    this.seenNonces.push(env.nonce);
    if (this.seenNonces.length > NONCE_CACHE_SIZE) {
      const evicted = this.seenNonces.shift();
      if (evicted !== undefined) this.seenSet.delete(evicted);
    }

    return env;
  }
}
