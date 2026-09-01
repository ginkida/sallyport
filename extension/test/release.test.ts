import { beforeEach, describe, expect, it } from 'vitest';
import { mayClose, parseReleaseEntries, releaseAction, releaseTabs } from '../src/tools/release.js';
import { agentTabInfo, clearAllEpochs, getEpoch, mintEpoch } from '../src/tools/ownership.js';
import { resetAttachedTabs } from '../src/tools/cdp.js';
import { setSettings } from '../src/storage.js';

type Calls = {
  removed: number[];
  updated: Array<{ tabId: number; muted?: boolean }>;
  detached: number[];
};

/** Minimal chrome for the release path: storage (settings live in local),
 * tabs.remove/update, and a debugger whose detach we can observe. */
function installChromeMock(opts: { removeFails?: Set<number> } = {}): Calls {
  const calls: Calls = { removed: [], updated: [], detached: [] };
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
      onRemoved: { addListener() {} },
    },
    debugger: {
      async detach(target: { tabId: number }) {
        calls.detached.push(target.tabId);
      },
      onDetach: { addListener() {} },
      onEvent: { addListener() {} },
    },
  };
  return calls;
}

describe('releaseAction — what happens to a disconnected session tabs', () => {
  it('hands tabs back by default rather than closing them', () => {
    // Closing an agent's half-finished work is exactly the loss invariant #12
    // gates close_tab against, and for an interactive session those tabs are
    // usually the result the human wanted to see.
    expect(releaseAction(false)).toBe('hand-back');
  });

  it('closes them when the human opted in (ephemeral agents)', () => {
    expect(releaseAction(true)).toBe('close');
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

  it('by default stops driving the tabs but never closes them', async () => {
    const calls = installChromeMock();
    const e1 = mintEpoch(11);
    const e2 = mintEpoch(12);
    await setSettings({ closeAgentTabsOnDisconnect: false });

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
    await setSettings({ closeAgentTabsOnDisconnect: false });

    const res = await releaseTabs({ tabs: entries });

    expect(res.data).toEqual({ released: 20, closed: 0 });
    expect(calls.detached.length).toBe(20);
    expect(new Set(calls.detached)).toEqual(new Set(entries.map((e) => e.tabId)));
  });

  it('closes the tabs when the human opted in, and forgets them', async () => {
    const calls = installChromeMock();
    const e1 = mintEpoch(11);
    await setSettings({ closeAgentTabsOnDisconnect: true });

    const res = await releaseTabs({ tabs: [{ tabId: 11, epoch: e1 }] });

    expect(res.data).toEqual({ released: 1, closed: 1 });
    expect(calls.removed).toEqual([11]);
    expect(getEpoch(11)).toBeUndefined();
    // Removing the tab ends its CDP session, so we must not detach first —
    // that would tear down the dialog handling able to answer a beforeunload.
    expect(calls.detached).toEqual([]);
  });

  it('never touches a tab we did not create, in either mode', async () => {
    for (const closeOnDisconnect of [false, true]) {
      clearAllEpochs();
      const calls = installChromeMock();
      await setSettings({ closeAgentTabsOnDisconnect: closeOnDisconnect });

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
    await setSettings({ closeAgentTabsOnDisconnect: true });

    const res = await releaseTabs({ tabs: [{ tabId: 7, epoch: 'stale-epoch' }] });

    expect(res.data).toEqual({ released: 1, closed: 0 });
    expect(calls.removed).toEqual([]); // the live tab of another session survives
    expect(getEpoch(7)).toBeDefined();
  });

  it('falls back to handing the tab back when the close fails', async () => {
    const calls = installChromeMock({ removeFails: new Set([11]) });
    const e1 = mintEpoch(11);
    await setSettings({ closeAgentTabsOnDisconnect: true });

    const res = await releaseTabs({ tabs: [{ tabId: 11, epoch: e1 }] });

    expect(res.data).toEqual({ released: 1, closed: 0 });
    expect(calls.detached).toEqual([11]);
    // The epoch is kept, so a survivor stays trackable in the popup's sweep.
    expect(getEpoch(11)).toBe(e1);
  });
});
