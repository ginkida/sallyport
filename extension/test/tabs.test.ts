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
import {
  closeTab,
  isBlankTarget,
  listTabs,
  navigate,
  reload,
  resolveTab,
  waitForLoad,
} from '../src/tools/tabs.js';
import { setAllowlist } from '../src/storage.js';
import { clearAllEpochs, getEpoch, mintEpoch, setBrokerMode } from '../src/tools/ownership.js';
import { resetAgentWindow } from '../src/tools/agent-window.js';
import { resetAttachedTabs } from '../src/tools/cdp.js';

type MockTab = { id: number; url: string; status?: string; windowId?: number };

type Calls = {
  update: Array<{ tabId: number; url: string }>;
  create: Array<{ url: string }>;
  // Broker-mode focus mitigation: dedicated agent window + windowed tab creates.
  windowsCreate: Array<{ url: string; focused?: boolean; incognito?: boolean }>;
  tabCreate: Array<{ url: string; windowId?: number; active?: boolean }>;
  muted: Array<{ tabId: number; muted: boolean }>;
  windowsFocus: Array<{ windowId: number; focused?: boolean }>;
  // Which tabs got a chrome.debugger.attach — navigate/reload now attach
  // unconditionally (not just when a waitFor is given) so opted-in capture
  // (dialog handling above all) is live for the page's own load.
  debuggerAttach: number[];
};

function installChromeMock(opts: { active?: MockTab; tabs?: MockTab[] }): Calls {
  const store = new Map<string, unknown>();
  const calls: Calls = {
    update: [],
    create: [],
    windowsCreate: [],
    tabCreate: [],
    muted: [],
    windowsFocus: [],
    debuggerAttach: [],
  };
  const byId = new Map<number, MockTab>();
  const windows = new Set<number>();
  let nextTabId = 999;
  let nextWindowId = 5000;
  let focusedWindowId = 1;
  for (const t of opts.tabs ?? []) byId.set(t.id, t);
  if (opts.active) byId.set(opts.active.id, opts.active);

  function getTab(tabId: number): MockTab {
    return byId.get(tabId) ?? { id: tabId, url: 'https://done.example/', status: 'complete' };
  }

  const sessionStore = new Map<string, unknown>();
  const localApi = {
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
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: localApi,
      session: {
        async get(key: string) {
          return sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {};
        },
        async set(obj: Record<string, unknown>) {
          for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v);
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
      update(tabId: number, info: { url?: string; muted?: boolean; active?: boolean }) {
        // MERGE, don't replace: agent tabs get a mute-only update after
        // creation, and a replacing mock would blank the url and hang
        // waitForLoad forever.
        if (info.url !== undefined) calls.update.push({ tabId, url: info.url });
        if (info.muted !== undefined) calls.muted.push({ tabId, muted: info.muted });
        const cur = getTab(tabId);
        // A url update completes the load (as before); other fields merge.
        const next = { ...cur, ...(info.url !== undefined ? { url: info.url } : {}) };
        next.status = 'complete';
        byId.set(tabId, next);
        return Promise.resolve(next);
      },
      reload(tabId: number, _info?: { bypassCache?: boolean }) {
        // Real Chrome flips status to 'loading' then back to 'complete'; the
        // mock only needs the end state so waitForLoad's fast path resolves.
        const cur = getTab(tabId);
        byId.set(tabId, { ...cur, status: 'complete' });
        return Promise.resolve();
      },
      create(info: { url: string; windowId?: number; active?: boolean }) {
        calls.create.push({ url: info.url });
        calls.tabCreate.push({ url: info.url, windowId: info.windowId, active: info.active });
        const id = nextTabId++;
        const next: MockTab = {
          id,
          url: info.url,
          status: 'complete',
          windowId: info.windowId,
        };
        byId.set(id, next);
        return Promise.resolve(next);
      },
      onUpdated: { addListener() {}, removeListener() {} },
      onRemoved: { addListener() {} },
    },
    debugger: {
      attach(target: { tabId: number }) {
        calls.debuggerAttach.push(target.tabId);
        return Promise.resolve();
      },
      sendCommand() {
        return Promise.resolve({});
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
    windows: {
      create(info: { url: string; focused?: boolean; incognito?: boolean }) {
        calls.windowsCreate.push({
          url: info.url,
          focused: info.focused,
          ...(info.incognito !== undefined ? { incognito: info.incognito } : {}),
        });
        const winId = nextWindowId++;
        windows.add(winId);
        const id = nextTabId++;
        const tab: MockTab = { id, url: info.url, status: 'complete', windowId: winId };
        byId.set(id, tab);
        return Promise.resolve({ id: winId, tabs: [tab] });
      },
      get(windowId: number) {
        if (windows.has(windowId)) return Promise.resolve({ id: windowId });
        return Promise.reject(new Error('no such window'));
      },
      getLastFocused() {
        return Promise.resolve({ id: focusedWindowId });
      },
      update(windowId: number, info: { focused?: boolean }) {
        calls.windowsFocus.push({ windowId, focused: info.focused });
        if (info.focused) focusedWindowId = windowId;
        return Promise.resolve({ id: windowId });
      },
    },
  };
  return calls;
}

const ALLOW = 'https://allowed.example/next';

beforeEach(async () => {
  installChromeMock({});
  clearAllEpochs(); // resets broker mode + epoch map between tests
  resetAgentWindow(); // forget the dedicated agent window between tests
  resetAttachedTabs(); // forget which tabIds were CDP-attached between tests
});

describe('waitForLoad — vanished tab', () => {
  it('fails fast with tab_gone (not a 30s timeout) when the tab is gone', async () => {
    installChromeMock({});
    // Chrome invokes the get callback with no tab (closed/recycled) instead of
    // throwing; without the guard, ready(undefined) throws inside the callback,
    // is swallowed, and the promise hangs to the timeout with code:'timeout'.
    (
      globalThis as unknown as {
        chrome: { tabs: { get: (id: number, cb: (t?: unknown) => void) => void } };
      }
    ).chrome.tabs.get = (_id, cb) => cb(undefined);
    await expect(waitForLoad(999, 'navigate', 5000)).rejects.toMatchObject({ code: 'tab_gone' });
  });
});

describe('waitForLoad — timeout message names the calling tool', () => {
  it('embeds the passed toolName, not a hardcoded "navigate"', async () => {
    installChromeMock({});
    // A tab that never reaches 'complete' and no onUpdated event ever fires
    // (the mock's addListener is a no-op) — the watchdog is the only way out.
    (
      globalThis as unknown as {
        chrome: { tabs: { get: (id: number, cb: (t?: unknown) => void) => void } };
      }
    ).chrome.tabs.get = (_id, cb) => cb({ status: 'loading', url: 'https://x.example/' });
    await expect(waitForLoad(1, 'history_go', 5)).rejects.toMatchObject({
      code: 'timeout',
      message: 'history_go: page load timeout',
    });
  });
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

describe('navigate/reload — attach unconditionally (dialogs on the FRESH page must be caught)', () => {
  // An unhandled dialog on load freezes the page; attach() is what lazily
  // turns on capture (console/network/dialog). Before this fix it only ran
  // when a waitFor was passed, so a plain navigate/reload never caught a
  // dialog that opened immediately — this pins that it now always does.
  it('navigate attaches even with no waitFor, for an in-place update', async () => {
    const calls = installChromeMock({ tabs: [{ id: 7, url: 'https://allowed.example/old' }] });
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    await navigate({ tabId: 7, url: ALLOW });
    expect(calls.debuggerAttach).toContain(7);
  });

  it('navigate attaches even with no waitFor, for a newly created tab', async () => {
    const calls = installChromeMock({ active: { id: 3, url: 'https://allowed.example/old' } });
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    await navigate({ url: ALLOW, newTab: true });
    expect(calls.debuggerAttach.length).toBeGreaterThan(0);
  });

  it('reload attaches even with no explicit trigger for it', async () => {
    const calls = installChromeMock({ tabs: [{ id: 7, url: 'https://allowed.example/old' }] });
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    await reload({ tabId: 7 });
    expect(calls.debuggerAttach).toContain(7);
  });
});

describe('navigate/reload — attach is BEST-EFFORT (a debugger conflict must not block the navigation)', () => {
  // Regression: making attach() unconditional must not make navigate/reload
  // hard-depend on chrome.debugger.attach succeeding — a human with DevTools
  // open on the very tab being automated (a routine situation given this
  // project's own usage model: driving the user's own live Chrome profile)
  // would otherwise turn every navigate/reload into a hard failure, where
  // before this feature existed they worked fine without CDP at all.
  function failDebuggerAttach(): void {
    (
      globalThis as unknown as {
        chrome: { debugger: { attach: () => Promise<void> } };
      }
    ).chrome.debugger.attach = () =>
      Promise.reject(new Error('Another debugger is already attached to the tab'));
  }

  it('navigate still succeeds (in-place update) when chrome.debugger.attach fails', async () => {
    const calls = installChromeMock({ tabs: [{ id: 7, url: 'https://allowed.example/old' }] });
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    failDebuggerAttach();
    const result = await navigate({ tabId: 7, url: ALLOW });
    expect(result.data).toMatchObject({ url: ALLOW });
    expect(calls.update).toEqual([{ tabId: 7, url: ALLOW }]);
  });

  it('navigate still succeeds (new tab) when chrome.debugger.attach fails', async () => {
    const calls = installChromeMock({ active: { id: 3, url: 'https://allowed.example/old' } });
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    failDebuggerAttach();
    const result = await navigate({ url: ALLOW, newTab: true });
    expect(result.data).toMatchObject({ url: ALLOW });
    expect(calls.create).toEqual([{ url: ALLOW }]);
  });

  it('reload still succeeds when chrome.debugger.attach fails', async () => {
    const calls = installChromeMock({ tabs: [{ id: 7, url: 'https://allowed.example/old' }] });
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    failDebuggerAttach();
    const result = await reload({ tabId: 7 });
    expect(result.data).toMatchObject({ tabId: 7 });
    expect(calls.update).toHaveLength(0); // reload doesn't call tabs.update
  });

  it('broker mode: a new tab is still owned (epoch minted) even when attach fails', async () => {
    setBrokerMode(true);
    installChromeMock({ active: { id: 3, url: 'https://allowed.example/old' } });
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    failDebuggerAttach();
    const result = (await navigate({ url: ALLOW, newTab: true })) as { data: { epoch?: string } };
    // The whole point: attach() throwing must not abort the call before
    // mintEpoch/persistEpochs run — otherwise the created tab is orphaned
    // (open, but unowned on both extension and daemon sides).
    expect(result.data.epoch).toBeTruthy();
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

describe('navigate — broker-mode create-own + epoch (invariant #13)', () => {
  it('a tabId-less navigate opens an owned tab in a non-focused agent window', async () => {
    const calls = installChromeMock({ active: { id: 3, url: 'https://bank.example/account' } });
    resetAgentWindow();
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    setBrokerMode(true);
    const res = await navigate({ url: ALLOW });
    // A dedicated, non-focused window — never the human's focused bank tab.
    expect(calls.windowsCreate).toEqual([{ url: ALLOW, focused: false }]);
    expect(calls.create).toHaveLength(0); // window create makes the tab, not tabs.create
    expect(calls.update).toHaveLength(0);
    const data = res.data as { tabId?: number; epoch?: string };
    expect(typeof data.epoch).toBe('string');
    expect(getEpoch(999)).toBe(data.epoch); // first created tab id
  });

  it("opens agent tabs in the human's OWN profile — never incognito", async () => {
    // Load-bearing, not cosmetic: the whole point of driving the user's own
    // Chrome is that an agent inherits the sessions they are already signed
    // into. An incognito (or otherwise separate-profile) window would have its
    // own cookie jar, so every agent tab would land on a login page. The
    // separation this project provides is about WHO MAY DRIVE WHICH TAB, never
    // about identity.
    const calls = installChromeMock({});
    resetAgentWindow();
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    setBrokerMode(true);
    await navigate({ url: ALLOW });
    expect(calls.windowsCreate).toHaveLength(1);
    expect(calls.windowsCreate[0].incognito).toBeUndefined();
  });

  it('gives each session its own agent window, and mutes agent tabs', async () => {
    const calls = installChromeMock({});
    resetAgentWindow();
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    setBrokerMode(true);
    await navigate({ url: ALLOW }, { client: 'alpha' });
    await navigate({ url: ALLOW }, { client: 'beta' });
    await navigate({ url: ALLOW }, { client: 'alpha' });
    // Two windows for two sessions; alpha's second tab reuses alpha's window.
    expect(calls.windowsCreate).toHaveLength(2);
    expect(calls.tabCreate).toHaveLength(1);
    expect(calls.tabCreate[0].active).toBe(false);
    // Every agent tab is muted: an agent has no use for audio, and a page
    // autoplaying from a window nobody is looking at is hard to track down.
    expect(calls.muted.length).toBeGreaterThanOrEqual(3);
    expect(calls.muted.every((m) => m.muted)).toBe(true);
  });

  it('reuses the agent window (non-active tab) for a second create-own', async () => {
    const calls = installChromeMock({});
    resetAgentWindow();
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    setBrokerMode(true);
    await navigate({ url: ALLOW }); // creates the window (tab 999 in window 5000)
    await navigate({ url: ALLOW }); // reuses it
    expect(calls.windowsCreate).toHaveLength(1); // only one window ever created
    expect(calls.tabCreate).toEqual([{ url: ALLOW, windowId: 5000, active: false }]);
  });

  it('an in-place navigate echoes the existing epoch and does not re-mint', async () => {
    const calls = installChromeMock({ tabs: [{ id: 7, url: 'about:blank' }] });
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    setBrokerMode(true);
    const minted = mintEpoch(7);
    const res = await navigate({ tabId: 7, url: ALLOW });
    expect(calls.update).toEqual([{ tabId: 7, url: ALLOW }]);
    expect((res.data as { epoch?: string }).epoch).toBe(minted);
    expect(getEpoch(7)).toBe(minted); // unchanged by an in-place navigate
  });

  it('does not mint or echo an epoch in standalone mode', async () => {
    const calls = installChromeMock({ active: { id: 3, url: 'about:blank' } });
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    const res = await navigate({ url: ALLOW }); // brokerMode false (reset in beforeEach)
    expect((res.data as { epoch?: string }).epoch).toBeUndefined();
    // Standalone keeps the active-tab path: a tabId-less navigate updates it.
    expect(calls.update).toEqual([{ tabId: 3, url: ALLOW }]);
  });
});

describe('list_tabs — owner-scoped in broker mode (invariant #13)', () => {
  function mockProfileTabs(tabs: Array<{ id: number; url: string }>): void {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      tabs: {
        async query() {
          return tabs.map((t) => ({ ...t, title: '', active: false, windowId: 1 }));
        },
      },
    };
  }

  it('returns the whole profile in standalone mode', async () => {
    mockProfileTabs([
      { id: 1, url: 'a' },
      { id: 2, url: 'b' },
    ]);
    const res = await listTabs({});
    expect((res.data as { tabs: unknown[] }).tabs).toHaveLength(2);
  });

  it('returns only agent-created tabs in broker mode', async () => {
    mockProfileTabs([
      { id: 1, url: 'human' },
      { id: 2, url: 'agent' },
      { id: 3, url: 'human2' },
    ]);
    setBrokerMode(true);
    mintEpoch(2);
    const res = await listTabs({});
    const ids = (res.data as { tabs: Array<{ tabId: number }> }).tabs.map((t) => t.tabId);
    expect(ids).toEqual([2]);
  });

  it('returns nothing when the agent owns no tabs (fail-closed)', async () => {
    mockProfileTabs([{ id: 1, url: 'human' }]);
    setBrokerMode(true);
    const res = await listTabs({});
    expect((res.data as { tabs: unknown[] }).tabs).toEqual([]);
  });
});

describe('vanished tab fast-fails with tab_gone (#12)', () => {
  // Real chrome.tabs.get rejects with "No tab with id: N" for a closed/recycled
  // id; the shared mock hands back a synthetic tab, so override it to reject.
  function makeTabGone(id: number): void {
    installChromeMock({});
    const chromeMock = (
      globalThis as unknown as {
        chrome: { tabs: { get: (tabId: number) => Promise<unknown> } };
      }
    ).chrome;
    chromeMock.tabs.get = (tabId: number) =>
      tabId === id
        ? Promise.reject(new Error(`No tab with id: ${tabId}.`))
        : Promise.resolve({ id: tabId, url: 'https://done.example/', status: 'complete' });
  }

  it('resolveTab maps a missing explicit tabId to tab_gone (not a raw error)', async () => {
    makeTabGone(42);
    await expect(resolveTab({ tabId: 42 })).rejects.toMatchObject({ code: 'tab_gone' });
  });

  it('close_tab on a vanished tab reports tab_gone before the allowlist check', async () => {
    makeTabGone(42);
    await expect(closeTab({ tabId: 42 })).rejects.toMatchObject({ code: 'tab_gone' });
  });

  it('navigate over a vanished explicit tab reports tab_gone', async () => {
    makeTabGone(42);
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    await expect(navigate({ tabId: 42, url: ALLOW })).rejects.toMatchObject({ code: 'tab_gone' });
  });

  it('still resolves a live explicit tab (no false positive)', async () => {
    installChromeMock({ tabs: [{ id: 7, url: 'https://live.example/' }] });
    const tab = await resolveTab({ tabId: 7 });
    expect(tab.id).toBe(7);
  });
});
