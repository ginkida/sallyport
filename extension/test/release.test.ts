import { beforeEach, describe, expect, it } from 'vitest';
import {
  mayClose,
  parseReleaseEntries,
  releaseAction,
  releaseStrandedTabs,
  releaseTabs,
} from '../src/tools/release.js';
import {
  agentTabInfo,
  clearAllEpochs,
  getEpoch,
  markHumanTab,
  mintEpoch,
} from '../src/tools/ownership.js';
import { resetAttachedTabs } from '../src/tools/cdp.js';
import { setSettings } from '../src/storage.js';

type Calls = {
  removed: number[];
  /** Closed through `Target.closeTarget` (no beforeunload prompt). */
  closedQuietly: number[];
  updated: Array<{ tabId: number; muted?: boolean }>;
  detached: number[];
};

/** Minimal chrome for the release path: storage (settings live in local),
 * tabs.remove/update, and a debugger whose detach we can observe. */
function installChromeMock(opts: { removeFails?: Set<number>; quietClose?: boolean } = {}): Calls {
  const calls: Calls = { removed: [], closedQuietly: [], updated: [], detached: [] };
  const removedListeners = new Set<(id: number) => void>();
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const store = (m: Map<string, unknown>) => ({
    async get(keys: string | string[]) {
      const out: Record<string, unknown> = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (m.has(k)) out[k] = m.get(k);
      return out;
    },
    async set(obj: Record<string, unknown>) {
      for (const [k, v] of Object.entries(obj)) m.set(k, v);
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) m.delete(k);
    },
  });

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: store(local), session: store(session) },
    tabs: {
      async remove(tabId: number) {
        if (opts.removeFails?.has(tabId)) throw new Error('tab refused to close');
        calls.removed.push(tabId);
      },
      async update(tabId: number, info: { muted?: boolean }) {
        calls.updated.push({ tabId, muted: info.muted });
        return { id: tabId };
      },
      onRemoved: {
        addListener(fn: (id: number) => void) {
          removedListeners.add(fn);
        },
        removeListener(fn: (id: number) => void) {
          removedListeners.delete(fn);
        },
      },
      async get(tabId: number) {
        if (calls.closedQuietly.includes(tabId)) throw new Error(`No tab with id: ${tabId}.`);
        return { id: tabId };
      },
    },
    debugger: {
      async detach(target: { tabId: number }) {
        calls.detached.push(target.tabId);
      },
      // Without `quietClose` the debugger has no getTargets — the quiet route
      // is unavailable and the plain removal runs, as on any older mock.
      ...(opts.quietClose
        ? {
            async getTargets() {
              return [11, 12, 13].map((tabId) => ({ id: `T${tabId}`, tabId, type: 'page' }));
            },
            async attach() {},
            async sendCommand(target: { tabId: number }, method: string) {
              if (method !== 'Target.closeTarget') return {};
              calls.closedQuietly.push(target.tabId);
              for (const fn of [...removedListeners]) fn(target.tabId);
              throw new Error('Detached while handling command.');
            },
          }
        : {}),
      onDetach: { addListener() {} },
      onEvent: { addListener() {} },
    },
  };
  return calls;
}

describe('releaseAction — what happens to a disconnected session tabs', () => {
  it('closes by default — nobody can reach a finished session tabs again', () => {
    expect(releaseAction(false)).toBe('close');
  });

  it('hands every tab back when the human asked to keep them', () => {
    expect(releaseAction(true)).toBe('hand-back');
    expect(releaseAction(true, true)).toBe('hand-back');
  });

  it('never closes a tab the human engaged with', () => {
    expect(releaseAction(false, true)).toBe('hand-back');
  });
});

describe('mayClose — the epoch is what makes destroying a tab safe', () => {
  it('allows a close only on an exact epoch match', () => {
    expect(mayClose({ tabId: 1, epoch: 'e1' }, 'e1')).toBe(true);
  });

  it('refuses when the daemon epoch and ours disagree — a RECYCLED id', () => {
    // The case that matters: the daemon's registry can outlive a browser
    // restart while our epoch map (chrome.storage.session) cannot, so id 7 can
    // be a different, live tab belonging to another session by now.
    expect(mayClose({ tabId: 7, epoch: 'stale' }, 'fresh')).toBe(false);
  });

  it('refuses when either side has no epoch (fail-closed)', () => {
    expect(mayClose({ tabId: 1 }, 'e1')).toBe(false);
    expect(mayClose({ tabId: 1, epoch: 'e1' }, undefined)).toBe(false);
  });
});

describe('parseReleaseEntries', () => {
  it('keeps well-formed entries and drops anything else', () => {
    expect(
      parseReleaseEntries([
        { tabId: 1, epoch: 'e1' },
        { tabId: 2 },
        { tabId: 'x', epoch: 'e' },
        { epoch: 'e' },
        null,
        7,
      ]),
    ).toEqual([{ tabId: 1, epoch: 'e1' }, { tabId: 2 }]);
    expect(parseReleaseEntries(undefined)).toEqual([]);
    expect(parseReleaseEntries('nope')).toEqual([]);
  });
});

describe('releaseTabs — the destructive path', () => {
  beforeEach(() => {
    clearAllEpochs();
    resetAttachedTabs();
  });

  it('with keep on, stops driving the tabs but never closes them', async () => {
    const calls = installChromeMock();
    const e1 = mintEpoch(11);
    const e2 = mintEpoch(12);
    await setSettings({ keepAgentTabsOnDisconnect: true });

    const res = await releaseTabs({
      tabs: [
        { tabId: 11, epoch: e1 },
        { tabId: 12, epoch: e2 },
      ],
    });

    expect(res.data).toEqual({ released: 2, closed: 0 });
    expect(calls.removed).toEqual([]);
    expect(calls.updated).toEqual([
      { tabId: 11, muted: false },
      { tabId: 12, muted: false },
    ]);
    // The epoch SURVIVES a hand-back: it is what keeps the tab in the popup's
    // "Agent tabs" list, which is the documented way to sweep up orphans.
    expect(getEpoch(11)).toBe(e1);
    expect(getEpoch(12)).toBe(e2);
    // ...and both are now ORPHANS: their session is gone, so no client can name
    // them again, which is what makes them the reaper's first candidates.
    expect(agentTabInfo().map((t) => [t.tabId, t.orphaned])).toEqual([
      [11, true],
      [12, true],
    ]);
  });

  it('releases a big session in bounded parallel batches, not one at a time', async () => {
    // Serially, every tab costs its own detach round-trip (bounded by the
    // renderer, up to 2 s each in cdp.ts) — so the session that opened the most
    // tabs was exactly the one whose release outran the daemon's 60 s request
    // timeout and got dropped, leaving every one of its tabs attached.
    const calls = installChromeMock();
    const entries = [];
    for (let tabId = 1; tabId <= 20; tabId++) {
      entries.push({ tabId, epoch: mintEpoch(tabId) });
    }
    await setSettings({ keepAgentTabsOnDisconnect: true });

    const res = await releaseTabs({ tabs: entries });

    expect(res.data).toEqual({ released: 20, closed: 0 });
    expect(calls.detached.length).toBe(20);
    expect(new Set(calls.detached)).toEqual(new Set(entries.map((e) => e.tabId)));
  });

  it('by default closes the tabs, and forgets them', async () => {
    const calls = installChromeMock();
    const e1 = mintEpoch(11);
    await setSettings({ keepAgentTabsOnDisconnect: false });

    const res = await releaseTabs({ tabs: [{ tabId: 11, epoch: e1 }] });

    expect(res.data).toEqual({ released: 1, closed: 1 });
    expect(calls.removed).toEqual([11]);
    expect(getEpoch(11)).toBeUndefined();
    // Closing the tab ends its CDP session, so there is nothing to detach
    // first (and on the plain-removal fallback, detaching would tear down the
    // dialog handling able to answer a beforeunload).
    expect(calls.detached).toEqual([]);
  });

  it('closes WITHOUT the beforeunload prompt — no window raised, no release stuck on it', async () => {
    const calls = installChromeMock({ quietClose: true });
    const e1 = mintEpoch(11);
    await setSettings({ keepAgentTabsOnDisconnect: false });

    const res = await releaseTabs({ tabs: [{ tabId: 11, epoch: e1 }] });

    expect(res.data).toEqual({ released: 1, closed: 1 });
    expect(calls.closedQuietly).toEqual([11]);
    expect(calls.removed).toEqual([]);
    expect(getEpoch(11)).toBeUndefined();
  });

  it('never closes a tab the human engaged with — it is handed back', async () => {
    const calls = installChromeMock({ quietClose: true });
    const e1 = mintEpoch(12);
    const e2 = mintEpoch(13);
    markHumanTab(12);
    // No setting stored at all: this is the DEFAULT path.

    const res = await releaseTabs({
      tabs: [
        { tabId: 12, epoch: e1 },
        { tabId: 13, epoch: e2 },
      ],
    });

    expect(res.data).toEqual({ released: 2, closed: 1 });
    expect(calls.closedQuietly).toEqual([13]);
    expect(calls.removed).toEqual([]);
    // Open, no longer driven, unmuted, still listed in the popup's sweep.
    expect(calls.detached).toEqual([12]);
    expect(calls.updated).toEqual([{ tabId: 12, muted: false }]);
    expect(getEpoch(12)).toBe(e1);
    expect(getEpoch(13)).toBeUndefined();
  });

  it('never touches a tab we did not create, in either mode', async () => {
    for (const closeOnDisconnect of [false, true]) {
      clearAllEpochs();
      const calls = installChromeMock();
      await setSettings({ keepAgentTabsOnDisconnect: !closeOnDisconnect });

      const res = await releaseTabs({ tabs: [{ tabId: 999, epoch: 'whatever' }] });

      expect(res.data).toEqual({ released: 0, closed: 0 });
      expect(calls.removed).toEqual([]);
      expect(calls.updated).toEqual([]);
      expect(calls.detached).toEqual([]);
    }
  });

  it('refuses to close on an epoch MISMATCH and hands the tab back instead', async () => {
    // A recycled id: we minted a fresh epoch for tab 7, the disconnecting
    // client names the stale one it recorded before the browser restarted.
    const calls = installChromeMock();
    mintEpoch(7);
    await setSettings({ keepAgentTabsOnDisconnect: false });

    const res = await releaseTabs({ tabs: [{ tabId: 7, epoch: 'stale-epoch' }] });

    expect(res.data).toEqual({ released: 1, closed: 0 });
    expect(calls.removed).toEqual([]); // the live tab of another session survives
    expect(getEpoch(7)).toBeDefined();
  });

  it('falls back to handing the tab back when the close fails', async () => {
    const calls = installChromeMock({ removeFails: new Set([11]) });
    const e1 = mintEpoch(11);
    await setSettings({ keepAgentTabsOnDisconnect: false });

    const res = await releaseTabs({ tabs: [{ tabId: 11, epoch: e1 }] });

    expect(res.data).toEqual({ released: 1, closed: 0 });
    expect(calls.detached).toEqual([11]);
    // The epoch is kept, so a survivor stays trackable in the popup's sweep.
    expect(getEpoch(11)).toBe(e1);
  });
});

describe('releaseStrandedTabs — a daemon that died sends no _release_tabs', () => {
  beforeEach(() => {
    clearAllEpochs();
    resetAttachedTabs();
  });

  it('does nothing on the first ack of a browser session, only remembers the daemon', async () => {
    // The tabs may belong to live sessions of the very daemon answering (the
    // extension was just updated under it) — nothing to compare, nothing done.
    const calls = installChromeMock({ quietClose: true });
    const e1 = mintEpoch(11);

    expect(await releaseStrandedTabs('boot-a')).toBe(0);

    expect(calls.closedQuietly).toEqual([]);
    expect(calls.detached).toEqual([]);
    expect(getEpoch(11)).toBe(e1);
  });

  it('does nothing when the same daemon answers again (reconnect, worker restart)', async () => {
    const calls = installChromeMock({ quietClose: true });
    await releaseStrandedTabs('boot-a');
    mintEpoch(11);

    expect(await releaseStrandedTabs('boot-a')).toBe(0);

    expect(calls.closedQuietly).toEqual([]);
    expect(getEpoch(11)).toBeDefined();
  });

  it('closes the previous daemon tabs when a DIFFERENT one answers, keeping the human ones', async () => {
    const calls = installChromeMock({ quietClose: true });
    await releaseStrandedTabs('boot-a');
    mintEpoch(11);
    const kept = mintEpoch(12);
    markHumanTab(12);

    expect(await releaseStrandedTabs('boot-b')).toBe(2);

    expect(calls.closedQuietly).toEqual([11]);
    expect(calls.removed).toEqual([]);
    expect(calls.detached).toEqual([12]);
    expect(getEpoch(11)).toBeUndefined();
    expect(getEpoch(12)).toBe(kept);
    expect(agentTabInfo().find((t) => t.tabId === 12)?.orphaned).toBe(true);
    // ...and the new daemon is the remembered one now.
    mintEpoch(13);
    expect(await releaseStrandedTabs('boot-b')).toBe(0);
    expect(getEpoch(13)).toBeDefined();
  });

  it('never takes a tab the NEW daemon created after its ack', async () => {
    const calls = installChromeMock({ quietClose: true });
    await releaseStrandedTabs('boot-a');
    mintEpoch(11);

    const pending = releaseStrandedTabs('boot-b'); // candidates snapshotted here
    mintEpoch(13); // the new daemon's first create, racing the release
    await pending;

    expect(calls.closedQuietly).toEqual([11]);
    expect(getEpoch(13)).toBeDefined();
  });

  it('leaves alone a tab whose id was re-minted while the release was starting', async () => {
    const calls = installChromeMock({ quietClose: true });
    await releaseStrandedTabs('boot-a');
    mintEpoch(11);

    const pending = releaseStrandedTabs('boot-b');
    const fresh = mintEpoch(11); // same id, a new owner
    await pending;

    expect(calls.closedQuietly).toEqual([]);
    expect(getEpoch(11)).toBe(fresh);
  });

  it('hands everything back when the human keeps tabs, and skips tabs already orphaned', async () => {
    const calls = installChromeMock({ quietClose: true });
    await setSettings({ keepAgentTabsOnDisconnect: true });
    await releaseStrandedTabs('boot-a');
    const e1 = mintEpoch(11);
    const e2 = mintEpoch(12);
    await releaseTabs({ tabs: [{ tabId: 12, epoch: e2 }] }); // an ordinary disconnect
    calls.detached.length = 0;

    expect(await releaseStrandedTabs('boot-b')).toBe(1);

    expect(calls.closedQuietly).toEqual([]);
    expect(calls.detached).toEqual([11]);
    expect(getEpoch(11)).toBe(e1);
  });

  it('is inert for a daemon that names no boot id, and never throws without storage', async () => {
    const calls = installChromeMock({ quietClose: true });
    await releaseStrandedTabs('boot-a');
    mintEpoch(11);

    expect(await releaseStrandedTabs(undefined)).toBe(0);
    (globalThis as unknown as { chrome: { storage: unknown } }).chrome.storage = {};
    expect(await releaseStrandedTabs('boot-b')).toBe(0);

    expect(calls.closedQuietly).toEqual([]);
  });
});

describe('release — review fixes', () => {
  beforeEach(() => {
    clearAllEpochs();
    resetAttachedTabs();
  });

  it('hands back the tab the human has IN FRONT of them, mark or no mark', async () => {
    // Active tab of the focused window, never marked `human` (the worker was
    // asleep for the activation, or the person simply never switched tabs).
    const calls = installChromeMock({ quietClose: true });
    const chromeMock = (globalThis as unknown as { chrome: Record<string, any> }).chrome;
    chromeMock.tabs.get = async (tabId: number) => ({
      id: tabId,
      active: tabId === 12,
      windowId: 5,
    });
    chromeMock.windows = { get: async () => ({ focused: true }) };
    const e1 = mintEpoch(11);
    const e2 = mintEpoch(12);

    const res = await releaseTabs({
      tabs: [
        { tabId: 11, epoch: e1 },
        { tabId: 12, epoch: e2 },
      ],
    });

    expect(res.data).toEqual({ released: 2, closed: 1 });
    expect(calls.closedQuietly).toEqual([11]);
    expect(calls.removed).toEqual([]);
    expect(calls.detached).toEqual([12]);
    expect(getEpoch(12)).toBe(e2);
  });

  it('a client that asked to keep its tabs (exec) gets them handed back, whatever the setting', async () => {
    const calls = installChromeMock({ quietClose: true });
    const e1 = mintEpoch(11);

    const res = await releaseTabs({ tabs: [{ tabId: 11, epoch: e1 }], keep: true });

    expect(res.data).toEqual({ released: 1, closed: 0 });
    expect(calls.closedQuietly).toEqual([]);
    expect(calls.detached).toEqual([11]);
    // Only the literal `true` counts — nothing truthy-but-odd keeps a tab.
    const e2 = mintEpoch(12);
    const res2 = await releaseTabs({ tabs: [{ tabId: 12, epoch: e2 }], keep: 'yes' });
    expect(res2.data).toEqual({ released: 1, closed: 1 });
  });

  it('a stranded release cut short is resumed by the next ack of the same daemon', async () => {
    const calls = installChromeMock({ quietClose: true });
    await releaseStrandedTabs('boot-a');
    const e1 = mintEpoch(11);
    // The worker died right after remembering the new daemon: the candidate
    // list is on record, nothing was released.
    await chrome.storage.session.set({
      sallyport_daemon_boot: 'boot-b',
      sallyport_stranded_tabs: [{ tabId: 11, epoch: e1 }],
    });
    mintEpoch(13); // the new daemon's own tab — must not be swept up

    expect(await releaseStrandedTabs('boot-b')).toBe(1);

    expect(calls.closedQuietly).toEqual([11]);
    expect(getEpoch(13)).toBeDefined();
    // ...and only once.
    mintEpoch(11);
    expect(await releaseStrandedTabs('boot-b')).toBe(0);
    expect(getEpoch(11)).toBeDefined();
  });
});
