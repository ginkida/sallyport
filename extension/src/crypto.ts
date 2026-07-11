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

export type ReplayCacheSnapshot = {
  secretId: string;
  nonces: string[];
};

/** Optional persistence for the receive-side nonce cache. Production uses
 * chrome.storage.session so replay protection survives MV3 worker eviction;
 * keeping the port injectable leaves the protocol code runnable in Node. */
export type ReplayCacheStore = {
  load(): Promise<unknown>;
  save(snapshot: ReplayCacheSnapshot): Promise<void>;
  clear(): Promise<void>;
};

export class Signer {
  private key: CryptoKey | null = null;
  private secretBytes: Uint8Array | null = null;
  private seenNonces: string[] = [];
  private seenSet = new Set<string>();
  private secretId: string | null = null;
  // Every key/cache operation shares one queue. WebCrypto and session-storage
  // calls yield, so verification alone is not enough: an overlapping unpair
  // could otherwise clear the signer and then a stale setSecret() could resume
  // and resurrect the old key; a re-pair could also swap caches while an old
  // frame was still being verified. Invocation order is the linearization
  // order for sign / verify / setSecret / clear.
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private replayCache?: ReplayCacheStore) {}

  async setSecret(secret: Uint8Array): Promise<void> {
    await this.exclusive(() => this.setSecretOnce(secret));
  }

  private async setSecretOnce(secret: Uint8Array): Promise<void> {
    // Re-setting the *same* secret — the common reconnect case (daemon
    // restart, network blip, popup-triggered Reconnect) — must NOT wipe the
    // nonce cache. Clearing it reopens a replay window for any frame
    // captured within the ±MAX_CLOCK_SKEW_S tolerance. Only a genuine secret
    // change (re-pairing) resets replay state. Session persistence restores
    // this cache after an MV3 worker restart.
    if (this.key && this.secretBytes && constantTimeEq(this.secretBytes, secret)) {
      return;
    }
    const key = await importKey(secret);
    const secretId = b64encode(
      await crypto.subtle.digest('SHA-256', secret as unknown as BufferSource),
    );
    let restored: string[] = [];
    try {
      const snapshot = await this.replayCache?.load();
      if (
        snapshot &&
        typeof snapshot === 'object' &&
        (snapshot as ReplayCacheSnapshot).secretId === secretId &&
        Array.isArray((snapshot as ReplayCacheSnapshot).nonces)
      ) {
        // Session storage is not a trust boundary. Validate and bound it so
        // corrupt state cannot grow the in-memory cache or inject non-keys.
        const candidates = (snapshot as ReplayCacheSnapshot).nonces.filter(
          (nonce): nonce is string => typeof nonce === 'string' && nonce.length > 0,
        );
        restored = [...new Set(candidates.slice(-NONCE_CACHE_SIZE))];
      }
    } catch {
      // Persistence is defence-in-depth; a storage outage must not prevent
      // pairing or authenticated transport from coming up.
    }
    this.key = key;
    this.secretBytes = new Uint8Array(secret); // own copy; caller may reuse its buffer
    this.secretId = secretId;
    this.seenNonces = restored;
    this.seenSet = new Set(restored);
    if (restored.length === 0) await this.persistReplayCache();
  }

  async clear(): Promise<void> {
    await this.exclusive(() => this.clearOnce());
  }

  private async clearOnce(): Promise<void> {
    this.key = null;
    this.secretBytes = null;
    this.secretId = null;
    this.seenNonces = [];
    this.seenSet.clear();
    try {
      await this.replayCache?.clear();
    } catch {
      // Clearing the pairing remains authoritative even if transient session
      // storage is unavailable.
    }
  }

  hasSecret(): boolean {
    return this.key !== null;
  }

  async sign(type: string, body: unknown, id?: string): Promise<SignedEnvelope> {
    return await this.exclusive(() => this.signOnce(type, body, id));
  }

  private async signOnce(type: string, body: unknown, id?: string): Promise<SignedEnvelope> {
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
    return await this.exclusive(() => this.verifyOnce(raw));
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async verifyOnce(raw: unknown): Promise<SignedEnvelope> {
    if (!this.key) throw new Error('signer has no secret');
    if (!raw || typeof raw !== 'object') throw new Error('not an object');
    const env = raw as SignedEnvelope;

    if (env.v !== PROTOCOL_VERSION) throw new Error(`bad version: ${env.v}`);
    // Integer seconds only — the daemon rejects a non-int `ts` (`isinstance(ts,
    // int)` in protocol.py), so accepting a fractional one here would let the
    // two halves disagree on which frames are well-formed. Both signers always
    // emit integers (`Math.floor` / `int(time.time())`), so this never rejects
    // a legitimate frame; it only closes the conformance gap.
    if (typeof env.ts !== 'number' || !Number.isInteger(env.ts)) throw new Error('bad ts');
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

    await this.persistReplayCache();

    return env;
  }

  private async persistReplayCache(): Promise<void> {
    if (!this.replayCache || !this.secretId) return;
    try {
      await this.replayCache.save({ secretId: this.secretId, nonces: [...this.seenNonces] });
    } catch {
      // Keep the live connection usable if chrome.storage.session is
      // temporarily unavailable; the in-memory replay gate still applies.
    }
  }
}
