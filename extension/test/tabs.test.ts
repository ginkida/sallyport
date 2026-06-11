/**
 * `navigate`'s clobber gate. Reusing an existing tab destroys whatever it
 * holds, so navigate must refuse to replace a non-allowlisted *content* tab
 * the same way `close_tab` refuses to close one (invariant #12) — otherwise an
 * agent that found a banking/email tab via `list_tabs` could discard it behind
 * the allowlist's back by navigating it to an allowlisted URL.
 *
 * navigate is chrome-bound, so we drive it against a `chrome.tabs` mock that
 * records which mutation (update vs create) it performed.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { isBlankTarget, navigate } from '../src/tools/tabs.js';
import { setAllowlist } from '../src/storage.js';

type MockTab = { id: number; url: string; status?: string };

type Calls = {
  update: Array<{ tabId: number; url: string }>;
  create: Array<{ url: string }>;
};

function installChromeMock(opts: { active?: MockTab; tabs?: MockTab[] }): Calls {
  const store = new Map<string, unknown>();
  const calls: Calls = { update: [], create: [] };
  const byId = new Map<number, MockTab>();
  for (const t of opts.tabs ?? []) byId.set(t.id, t);
  if (opts.active) byId.set(opts.active.id, opts.active);

  function getTab(tabId: number): MockTab {
    return byId.get(tabId) ?? { id: tabId, url: 'https://done.example/', status: 'complete' };
  }

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        async get(keys: string | string[]) {
          const out: Record<string, unknown> = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            if (store.has(k)) out[k] = store.get(k);
          }
          return out;
        },
        async set(obj: Record<string, unknown>) {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
        async remove(keys: string | string[]) {
          for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
        },
      },
    },
    tabs: {
      async query() {
        return opts.active ? [opts.active] : [];
      },
      get(tabId: number, cb?: (t: MockTab) => void) {
        const tab = getTab(tabId);
        if (cb) {
          cb(tab);
          return;
        }
        return Promise.resolve(tab);
      },
      update(tabId: number, info: { url: string }) {
        calls.update.push({ tabId, url: info.url });
        const next = { id: tabId, url: info.url, status: 'complete' };
        byId.set(tabId, next);
        return Promise.resolve(next);
      },
      create(info: { url: string }) {
        calls.create.push({ url: info.url });
        const next = { id: 999, url: info.url, status: 'complete' };
        byId.set(999, next);
        return Promise.resolve(next);
      },
      onUpdated: { addListener() {}, removeListener() {} },
      onRemoved: { addListener() {} },
    },
  };
  return calls;
}

const ALLOW = 'https://allowed.example/next';

beforeEach(async () => {
  installChromeMock({});
});

describe('navigate — clobber gate (invariant #12 parity with close_tab)', () => {
  it('refuses to replace a non-allowlisted content tab found via list_tabs', async () => {
    const calls = installChromeMock({ tabs: [{ id: 7, url: 'https://bank.example/account' }] });
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    await expect(navigate({ tabId: 7, url: ALLOW })).rejects.toMatchObject({
      code: 'domain_not_allowed',
    });
    expect(calls.update).toHaveLength(0);
    expect(calls.create).toHaveLength(0);
  });

  it('also gates the active tab when no tabId is given', async () => {
    const calls = installChromeMock({ active: { id: 3, url: 'https://bank.example/account' } });
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    await expect(navigate({ url: ALLOW })).rejects.toMatchObject({ code: 'domain_not_allowed' });
    expect(calls.update).toHaveLength(0);
  });

  it('allows replacing an allowlisted content tab', async () => {
    const calls = installChromeMock({ tabs: [{ id: 7, url: 'https://allowed.example/old' }] });
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    await navigate({ tabId: 7, url: ALLOW });
    expect(calls.update).toEqual([{ tabId: 7, url: ALLOW }]);
    expect(calls.create).toHaveLength(0);
  });

  it('navigates over about:blank without an allowlist check on the source', async () => {
    const calls = installChromeMock({ tabs: [{ id: 7, url: 'about:blank' }] });
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    await navigate({ tabId: 7, url: ALLOW });
    expect(calls.update).toEqual([{ tabId: 7, url: ALLOW }]);
  });

  it('navigates over an empty-url tab without a source check', async () => {
    const calls = installChromeMock({ tabs: [{ id: 7, url: '' }] });
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    await navigate({ tabId: 7, url: ALLOW });
    expect(calls.update).toEqual([{ tabId: 7, url: ALLOW }]);
  });

  it('opens a new tab (no clobber) when newTab=true, even over a banking tab', async () => {
    const calls = installChromeMock({ active: { id: 3, url: 'https://bank.example/account' } });
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    await navigate({ url: ALLOW, newTab: true });
    expect(calls.create).toEqual([{ url: ALLOW }]);
    expect(calls.update).toHaveLength(0);
  });

  it('redirects a chrome:// source to a new tab instead of clobbering it', async () => {
    const calls = installChromeMock({ tabs: [{ id: 7, url: 'chrome://settings' }] });
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    await navigate({ tabId: 7, url: ALLOW });
    expect(calls.create).toEqual([{ url: ALLOW }]);
    expect(calls.update).toHaveLength(0);
  });

  it('still rejects a non-allowlisted target before touching any tab', async () => {
    const calls = installChromeMock({ tabs: [{ id: 7, url: 'https://allowed.example/old' }] });
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    await expect(navigate({ tabId: 7, url: 'https://evil.example/x' })).rejects.toMatchObject({
      code: 'domain_not_allowed',
    });
    expect(calls.update).toHaveLength(0);
    expect(calls.create).toHaveLength(0);
  });
});

describe('isBlankTarget', () => {
  it('treats blank/new-tab/empty as content-free', () => {
    expect(isBlankTarget('about:blank')).toBe(true);
    expect(isBlankTarget('about:newtab')).toBe(true);
    expect(isBlankTarget('')).toBe(true);
    expect(isBlankTarget(undefined)).toBe(true);
  });

  it('treats real pages (and chrome://, handled separately) as not blank', () => {
    expect(isBlankTarget('https://example.com/')).toBe(false);
    expect(isBlankTarget('http://localhost:3000/')).toBe(false);
    expect(isBlankTarget('chrome://settings')).toBe(false);
  });
});
