/**
 * Storage layer — secret, allowlist, audit log, settings.
 *
 * Audit log rotation is the load-bearing piece: if the cap stops working,
 * every popup open gets slower until Chrome storage starts refusing writes.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIT_LIMIT,
  DEFAULT_SERVER_URL,
  appendAudit,
  clearAudit,
  clearSecret,
  getAllowlist,
  getAudit,
  getSecret,
  getSettings,
  setAllowlist,
  setSecret,
  setSettings,
  type AllowEntry,
  type AuditEntry,
} from '../src/storage.js';

// Minimal in-memory chrome.storage.local mock. Good enough for these
// tests — preserves the get/set/remove semantics we actually use.
function installChromeMock(): { store: Map<string, unknown> } {
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
  return { store };
}

beforeEach(() => {
  installChromeMock();
});

// ---------------------------------------------------------------------------
// secret
// ---------------------------------------------------------------------------

describe('secret', () => {
  it('returns null when nothing stored', async () => {
    expect(await getSecret()).toBeNull();
  });

  it('round-trips a base64 secret', async () => {
    await setSecret('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    expect(await getSecret()).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  });

  it('clearSecret wipes the value', async () => {
    await setSecret('something');
    await clearSecret();
    expect(await getSecret()).toBeNull();
  });

  it('getSecret treats an empty string as null (defensive)', async () => {
    // If storage somehow ends up with an empty string, we must return null
    // so callers go through the no_secret state instead of trying to use it.
    const { store } = installChromeMock();
    store.set('sallyport_secret_b64', '');
    expect(await getSecret()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// allowlist
// ---------------------------------------------------------------------------

describe('allowlist storage', () => {
  it('defaults to empty list', async () => {
    expect(await getAllowlist()).toEqual([]);
  });

  it('round-trips entries', async () => {
    const list: AllowEntry[] = [
      { pattern: 'example.com', allowEvaluate: false, addedAt: 1 },
      { pattern: '*.x.com', allowEvaluate: true, addedAt: 2 },
    ];
    await setAllowlist(list);
    expect(await getAllowlist()).toEqual(list);
  });
});

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

describe('settings', () => {
  it('returns defaults when nothing stored', async () => {
    const s = await getSettings();
    expect(s.serverUrl).toBe(DEFAULT_SERVER_URL);
    expect(s.paused).toBe(false);
    expect(s.keepAwake).toBe(true); // default on
  });

  it('merges a partial patch into existing settings', async () => {
    await setSettings({ serverUrl: 'ws://x/ws' });
    let s = await getSettings();
    expect(s.serverUrl).toBe('ws://x/ws');
    expect(s.paused).toBe(false);

    await setSettings({ paused: true });
    s = await getSettings();
    expect(s.serverUrl).toBe('ws://x/ws'); // preserved
    expect(s.paused).toBe(true);
  });

  it('keepAwake survives an explicit off and stays off across patches', async () => {
    await setSettings({ keepAwake: false });
    let s = await getSettings();
    expect(s.keepAwake).toBe(false);

    await setSettings({ paused: true });
    s = await getSettings();
    expect(s.keepAwake).toBe(false); // preserved, not reset to the default
  });
});

// ---------------------------------------------------------------------------
// audit log
// ---------------------------------------------------------------------------

function mkEntry(i: number): AuditEntry {
  return { ts: i, tool: 'snapshot', args: {}, ok: true };
}

describe('audit log', () => {
  it('defaults to empty', async () => {
    expect(await getAudit()).toEqual([]);
  });

  it('appendAudit accumulates in order', async () => {
    await appendAudit(mkEntry(1));
    await appendAudit(mkEntry(2));
    await appendAudit(mkEntry(3));
    const log = await getAudit();
    expect(log.map((e) => e.ts)).toEqual([1, 2, 3]);
  });

  it('caps the log at AUDIT_LIMIT, evicting oldest entries', async () => {
    // Push limit+5; final size must be == limit and oldest 5 should be gone.
    for (let i = 0; i < AUDIT_LIMIT + 5; i++) {
      await appendAudit(mkEntry(i));
    }
    const log = await getAudit();
    expect(log).toHaveLength(AUDIT_LIMIT);
    expect(log[0].ts).toBe(5); // entries 0..4 evicted
    expect(log.at(-1)?.ts).toBe(AUDIT_LIMIT + 4);
  });

  it('clearAudit removes everything', async () => {
    await appendAudit(mkEntry(1));
    await appendAudit(mkEntry(2));
    await clearAudit();
    expect(await getAudit()).toEqual([]);
  });

  it('survives corrupted storage by treating non-array as empty', async () => {
    const { store } = installChromeMock();
    store.set('sallyport_audit', { not: 'an array' });
    expect(await getAudit()).toEqual([]);
    // And appending after corruption recovers gracefully.
    await appendAudit(mkEntry(42));
    expect(await getAudit()).toHaveLength(1);
  });
});

import {
  MAX_AUDIT_ITEMS,
  MAX_AUDIT_STRING,
  redactAuditArgs,
  truncateAuditString,
  truncateAuditValue,
} from '../src/storage.js';

describe('redactAuditArgs — keeps typed passwords out of the audit log', () => {
  it('redacts fill.value when allowPassword=true', () => {
    const out = redactAuditArgs('fill', { selector: '#p', value: 'hunter2', allowPassword: true });
    expect(out.value).toBe('<redacted password, 7 chars>');
    expect(out.selector).toBe('#p'); // other args untouched
  });

  it('redacts key_type.text and send_keys.keys when allowPassword=true', () => {
    expect(redactAuditArgs('key_type', { text: 'secret', allowPassword: true }).text).toBe(
      '<redacted password, 6 chars>',
    );
    expect(redactAuditArgs('send_keys', { keys: 'abc', allowPassword: true }).keys).toBe(
      '<redacted password, 3 chars>',
    );
  });

  it('leaves the value verbatim when allowPassword is not set (normal field)', () => {
    const args = { selector: '#q', value: 'hello' };
    expect(redactAuditArgs('fill', args)).toBe(args); // same ref, no copy
  });

  it('does not redact tools that do not type, even with allowPassword=true', () => {
    const args = { selector: '#x', allowPassword: true };
    expect(redactAuditArgs('click', args)).toBe(args);
  });

  it('redacts a NON-string credential too (tools String()-coerce before typing)', () => {
    // A numeric PIN / array would otherwise be stored verbatim while the tool
    // still types it into the password field — the gap a reviewer found.
    expect(redactAuditArgs('fill', { value: 12345678, allowPassword: true }).value).toBe(
      '<redacted password, 8 chars>',
    );
    expect(redactAuditArgs('key_type', { text: 1234567, allowPassword: true }).text).toBe(
      '<redacted password, 7 chars>',
    );
    const arr = ['s', '3', 'c', 'r', 'e', 't'];
    // String(['s','3',...]) === 's,3,c,r,e,t' → length 11.
    expect(redactAuditArgs('fill', { value: arr, allowPassword: true }).value).toBe(
      `<redacted password, ${String(arr).length} chars>`,
    );
  });

  it('force-redacts even without allowPassword (a rejected password attempt)', () => {
    // fill('#pw','hunter2') with no allowPassword throws password_field; the
    // attempted secret must still be kept out of the log.
    expect(redactAuditArgs('fill', { value: 'hunter2' }, { force: true }).value).toBe(
      '<redacted password, 7 chars>',
    );
  });

  it('is a no-op when the typed arg is missing', () => {
    expect(redactAuditArgs('fill', { allowPassword: true }).value).toBeUndefined();
    expect(redactAuditArgs('fill', {}, { force: true }).value).toBeUndefined();
  });
});

describe('audit truncation — pure helpers', () => {
  it('passes through strings at or under the cap', () => {
    expect(truncateAuditString('')).toBe('');
    expect(truncateAuditString('hi')).toBe('hi');
    const exact = 'x'.repeat(MAX_AUDIT_STRING);
    expect(truncateAuditString(exact)).toBe(exact);
  });

  it('truncates over-cap strings with a marker that names the original length', () => {
    const over = 'x'.repeat(MAX_AUDIT_STRING + 500);
    const out = truncateAuditString(over);
    expect(out.length).toBeLessThan(over.length);
    expect(out.startsWith('x'.repeat(MAX_AUDIT_STRING))).toBe(true);
    expect(out).toContain(`${MAX_AUDIT_STRING + 500} chars total`);
  });

  it('truncateAuditValue: leaves primitives alone', () => {
    expect(truncateAuditValue(null)).toBeNull();
    expect(truncateAuditValue(undefined)).toBeUndefined();
    expect(truncateAuditValue(42)).toBe(42);
    expect(truncateAuditValue(true)).toBe(true);
  });

  it('truncateAuditValue: trims every string in a nested object/array', () => {
    const huge = 'x'.repeat(MAX_AUDIT_STRING + 1);
    const input = {
      url: 'https://example.com',
      data: huge,
      headers: { auth: huge },
      list: ['short', huge, { inner: huge }],
    };
    const out = truncateAuditValue(input) as Record<string, unknown>;
    expect(out.url).toBe('https://example.com');
    expect(out.data as string).toContain('chars total');
    expect((out.headers as Record<string, string>).auth).toContain('chars total');
    const list = out.list as unknown[];
    expect(list[0]).toBe('short');
    expect(list[1] as string).toContain('chars total');
    expect((list[2] as { inner: string }).inner).toContain('chars total');
  });

  it('truncateAuditValue: caps a wide array at MAX_AUDIT_ITEMS with a "more" marker', () => {
    const wide = Array.from({ length: MAX_AUDIT_ITEMS + 10 }, (_, i) => `item${i}`);
    const out = truncateAuditValue(wide) as unknown[];
    expect(out.length).toBe(MAX_AUDIT_ITEMS + 1); // capped items + one marker
    expect(out[MAX_AUDIT_ITEMS]).toBe('…<10 more>');
    expect(out.slice(0, MAX_AUDIT_ITEMS)).toEqual(wide.slice(0, MAX_AUDIT_ITEMS));
  });

  it('truncateAuditValue: caps a wide object at MAX_AUDIT_ITEMS keys with a "more" marker', () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < MAX_AUDIT_ITEMS + 5; i++) wide[`k${i}`] = `v${i}`;
    const out = truncateAuditValue(wide) as Record<string, unknown>;
    expect(Object.keys(out)).toHaveLength(MAX_AUDIT_ITEMS + 1); // capped keys + one marker
    expect(out['…']).toBe('5 more keys');
  });

  it('truncateAuditValue: a deeply-nested/wide structure still terminates within the shared budget', () => {
    // Adversarial shape: nesting AND width both far exceed the budget — the
    // shared running counter (not independent per-level caps) must still
    // bound the total work/output regardless of how it's distributed.
    let pathological: unknown = 'leaf';
    for (let level = 0; level < 20; level++) {
      pathological = Array.from({ length: 20 }, () => pathological);
    }
    const out = truncateAuditValue(pathological);
    // Must not throw/hang, and must not silently accept unbounded expansion —
    // a cheap proxy for "bounded total size" is a small serialised length.
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(JSON.stringify(out).length).toBeLessThan(2000);
  });
});

describe('appendAudit — truncates entries before storage', () => {
  beforeEach(() => {
    installChromeMock();
  });

  function mkBigEntry(): AuditEntry {
    const huge = 'X'.repeat(MAX_AUDIT_STRING + 1000);
    return {
      ts: 1,
      tool: 'save_to_file',
      args: { data: huge, filename: 'normal.bin' },
      ok: false,
      error: huge,
    };
  }

  it('shrinks oversized arg values before persisting', async () => {
    await appendAudit(mkBigEntry());
    const log = await getAudit();
    expect(log).toHaveLength(1);
    const entry = log[0];
    expect((entry.args.data as string).length).toBeLessThan(MAX_AUDIT_STRING + 200);
    expect(entry.args.data as string).toContain('chars total');
    expect(entry.args.filename).toBe('normal.bin');
    expect(entry.error).toBeDefined();
    expect(entry.error!.length).toBeLessThan(MAX_AUDIT_STRING + 200);
  });

  it('does not touch entries already under the cap', async () => {
    const small: AuditEntry = {
      ts: 1,
      tool: 'click',
      args: { selector: '@e1' },
      ok: true,
    };
    await appendAudit(small);
    const log = await getAudit();
    expect(log[0]).toEqual(small);
  });
});
