/**
 * Allowlist gates. These are the door between an incoming tool_call and
 * any CDP call that touches the page, so the tests below pin every
 * outcome (allow / domain reject / evaluate reject / missing URL).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAllowed, ensureEvaluateAllowed, hostnameOf } from '../src/tools/gates.js';
import { setAllowlist } from '../src/storage.js';
import { BridgeError } from '../src/tools/errors.js';

function installChromeMock(): void {
  const store = new Map<string, unknown>();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        async get(keys: string | string[]) {
          const out: Record<string, unknown> = {};
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) {
            if (store.has(k)) out[k] = store.get(k);
          }
          return out;
        },
        async set(obj: Record<string, unknown>) {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
        async remove(keys: string | string[]) {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) store.delete(k);
        },
      },
    },
  };
}

beforeEach(() => {
  installChromeMock();
});

// ---------------------------------------------------------------------------
// hostnameOf
// ---------------------------------------------------------------------------

describe('hostnameOf', () => {
  it('extracts the hostname from a full URL', () => {
    expect(hostnameOf('https://api.example.com/x?y=1')).toBe('api.example.com');
  });

  it('returns the input unchanged when it cannot parse', () => {
    expect(hostnameOf('not a url')).toBe('not a url');
  });
});

// ---------------------------------------------------------------------------
// ensureAllowed
// ---------------------------------------------------------------------------

describe('ensureAllowed', () => {
  it('passes when the hostname matches an entry', async () => {
    await setAllowlist([{ pattern: 'example.com', allowEvaluate: false, addedAt: 0 }]);
    await expect(ensureAllowed('https://example.com/page')).resolves.toBeUndefined();
  });

  it('rejects with domain_not_allowed when the host is not in the list', async () => {
    await setAllowlist([{ pattern: 'example.com', allowEvaluate: false, addedAt: 0 }]);
    await expect(ensureAllowed('https://evil.com/x')).rejects.toMatchObject({
      code: 'domain_not_allowed',
    });
  });

  it('rejects with no_url when url is empty/undefined', async () => {
    await expect(ensureAllowed(undefined)).rejects.toMatchObject({ code: 'no_url' });
    await expect(ensureAllowed('')).rejects.toMatchObject({ code: 'no_url' });
  });

  it('rejects chrome:// pages even with permissive allowlist', async () => {
    await setAllowlist([{ pattern: '*.example.com', allowEvaluate: false, addedAt: 0 }]);
    // The allowlist matcher rejects non-http(s) protocols, so chrome:// is
    // never "matched".
    await expect(ensureAllowed('chrome://settings')).rejects.toMatchObject({
      code: 'domain_not_allowed',
    });
  });

  it('throws a real BridgeError instance with the right code', async () => {
    let caught: unknown;
    try {
      await ensureAllowed('https://blocked.com/x');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BridgeError);
    expect((caught as BridgeError).code).toBe('domain_not_allowed');
  });

  it('accepts a pre-fetched list instead of re-fetching (a caller with a second check to make against the same list, e.g. history_go, can avoid a double storage round-trip)', async () => {
    // Deliberately do NOT setAllowlist a matching entry — if the passed list
    // were ignored and a fresh (empty) fetch happened instead, this would
    // reject with domain_not_allowed.
    const list = [{ pattern: 'example.com', allowEvaluate: false, addedAt: 0 }];
    await expect(ensureAllowed('https://example.com/page', list)).resolves.toBeUndefined();
  });

  it('an empty/mismatched pre-fetched list still rejects domain_not_allowed', async () => {
    await setAllowlist([{ pattern: 'example.com', allowEvaluate: false, addedAt: 0 }]);
    // Even though the STORED allowlist would match, the passed list wins.
    await expect(ensureAllowed('https://example.com/page', [])).rejects.toMatchObject({
      code: 'domain_not_allowed',
    });
  });
});

// ---------------------------------------------------------------------------
// ensureEvaluateAllowed
// ---------------------------------------------------------------------------

describe('ensureEvaluateAllowed', () => {
  it('passes only when the matched entry has allowEvaluate=true', async () => {
    await setAllowlist([
      { pattern: 'safe.com', allowEvaluate: false, addedAt: 0 },
      { pattern: 'trusted.com', allowEvaluate: true, addedAt: 0 },
    ]);
    await expect(ensureEvaluateAllowed('https://trusted.com/')).resolves.toBeUndefined();
  });

  it('rejects evaluate_not_allowed when entry exists but allowEvaluate=false', async () => {
    await setAllowlist([{ pattern: 'safe.com', allowEvaluate: false, addedAt: 0 }]);
    await expect(ensureEvaluateAllowed('https://safe.com/x')).rejects.toMatchObject({
      code: 'evaluate_not_allowed',
    });
  });

  it('rejects domain_not_allowed (not evaluate_not_allowed) when host is not in list', async () => {
    await setAllowlist([{ pattern: 'trusted.com', allowEvaluate: true, addedAt: 0 }]);
    await expect(ensureEvaluateAllowed('https://evil.com/x')).rejects.toMatchObject({
      code: 'domain_not_allowed',
    });
  });

  it('rejects no_url for empty url', async () => {
    await expect(ensureEvaluateAllowed(undefined)).rejects.toMatchObject({ code: 'no_url' });
  });
});
