/**
 * Per-client tab ownership — the extension's identity-blind, defence-in-depth
 * half of invariant #13. The daemon is authoritative; this module records a
 * create-time epoch per agent-created tab (so a recycled Chrome tabId is caught,
 * `tab_gone`) and tracks the broker-mode signal that gates owner-scoped
 * list_tabs + focus mitigation. Pure / chrome-free, so it is unit-gated here.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { BridgeError } from '../src/tools/errors.js';
import {
  agentTabIds,
  assertBringToFrontAllowed,
  clearAllEpochs,
  confirmEpoch,
  dropEpoch,
  EXPECTED_EPOCH_ARG,
  filterTabsToOwned,
  getEpoch,
  hydrateEpochs,
  adoptOpenedTab,
  agentTabInfo,
  takeAdoptedTabs,
  markHumanTab,
  markOrphanedTab,
  planEviction,
  touchTab,
  isBrokerMode,
  mintEpoch,
  reconcileEpochs,
  serializeEpochs,
  setBrokerMode,
  stripBrokerArgs,
} from '../src/tools/ownership.js';

beforeEach(() => {
  clearAllEpochs();
});

describe('broker-mode flag', () => {
  it('defaults off and toggles', () => {
    expect(isBrokerMode()).toBe(false);
    setBrokerMode(true);
    expect(isBrokerMode()).toBe(true);
    setBrokerMode(false);
    expect(isBrokerMode()).toBe(false);
  });

  it('clearAllEpochs resets broker mode too', () => {
    setBrokerMode(true);
    clearAllEpochs();
    expect(isBrokerMode()).toBe(false);
  });
});

describe('epoch mint / get / drop', () => {
  it('mints a stored unguessable epoch and reads it back', () => {
    const e = mintEpoch(5);
    expect(typeof e).toBe('string');
    expect(e.length).toBeGreaterThan(8);
    expect(getEpoch(5)).toBe(e);
  });

  it('re-minting an id yields a different epoch (recycle marker)', () => {
    const first = mintEpoch(5);
    const second = mintEpoch(5);
    expect(second).not.toBe(first);
    expect(getEpoch(5)).toBe(second);
  });

  it('getEpoch is undefined for an unknown tab', () => {
    expect(getEpoch(99)).toBeUndefined();
  });

  it('dropEpoch forgets a tab', () => {
    mintEpoch(5);
    dropEpoch(5);
    expect(getEpoch(5)).toBeUndefined();
    dropEpoch(5); // idempotent
  });

  it('dropEpoch reports whether it removed an entry (so callers skip a needless persist)', () => {
    mintEpoch(5);
    expect(dropEpoch(5)).toBe(true); // an owned tab went away
    expect(dropEpoch(5)).toBe(false); // already gone
    expect(dropEpoch(999)).toBe(false); // a tab we never owned (the standalone case)
  });
});

describe('confirmEpoch', () => {
  it('is a no-op when no expected epoch is supplied (standalone / create)', () => {
    mintEpoch(5);
    expect(() => confirmEpoch(5, undefined)).not.toThrow();
    expect(() => confirmEpoch(5, null)).not.toThrow();
    expect(() => confirmEpoch(5, 123)).not.toThrow();
  });

  it('passes when the recorded epoch matches', () => {
    const e = mintEpoch(5);
    expect(() => confirmEpoch(5, e)).not.toThrow();
  });

  it('throws tab_gone on a mismatch (id recycled)', () => {
    mintEpoch(5);
    try {
      confirmEpoch(5, 'some-other-epoch');
      throw new Error('expected confirmEpoch to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeError);
      expect((e as BridgeError).code).toBe('tab_gone');
    }
  });

  it('throws tab_gone for an unknown tab when an epoch is expected', () => {
    expect(() => confirmEpoch(42, 'epoch-x')).toThrow(BridgeError);
  });
});

describe('assertBringToFrontAllowed (focus-theft mitigation)', () => {
  it('allows bringToFront in standalone mode', () => {
    expect(() => assertBringToFrontAllowed(true)).not.toThrow();
  });

  it('allows a non-bringToFront screenshot in broker mode', () => {
    setBrokerMode(true);
    expect(() => assertBringToFrontAllowed(false)).not.toThrow();
  });

  it('forbids bringToFront in broker mode with bringtofront_forbidden', () => {
    setBrokerMode(true);
    try {
      assertBringToFrontAllowed(true);
      throw new Error('expected assertBringToFrontAllowed to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeError);
      expect((e as BridgeError).code).toBe('bringtofront_forbidden');
    }
  });
});

describe('stripBrokerArgs', () => {
  it('removes the broker-internal epoch field, returning a copy', () => {
    const args = { tabId: 5, [EXPECTED_EPOCH_ARG]: 'e1', selector: '#x' };
    const out = stripBrokerArgs(args);
    expect(out).toEqual({ tabId: 5, selector: '#x' });
    expect(EXPECTED_EPOCH_ARG in args).toBe(true); // original untouched
  });

  it('returns args unchanged when no epoch field is present', () => {
    const args = { tabId: 5 };
    expect(stripBrokerArgs(args)).toBe(args);
  });
});

describe('filterTabsToOwned', () => {
  it('keeps only tabs whose id is in the owned set', () => {
    const tabs = [{ tabId: 1 }, { tabId: 2 }, { tabId: 3 }];
    expect(filterTabsToOwned(tabs, new Set([2, 3]))).toEqual([{ tabId: 2 }, { tabId: 3 }]);
  });

  it('drops entries without a numeric tabId', () => {
    const tabs = [{ tabId: 2 }, { tabId: undefined }, {}];
    expect(filterTabsToOwned(tabs as { tabId?: number }[], new Set([2]))).toEqual([{ tabId: 2 }]);
  });

  it('returns empty when nothing is owned (fail-closed shape)', () => {
    expect(filterTabsToOwned([{ tabId: 1 }, { tabId: 2 }], new Set())).toEqual([]);
  });
});

describe('agentTabIds / reconcile', () => {
  it('lists exactly the agent-created tabs', () => {
    mintEpoch(5);
    mintEpoch(6);
    expect(agentTabIds()).toEqual(new Set([5, 6]));
  });

  it('reconcile drops epochs for tabs no longer live and returns them', () => {
    mintEpoch(5);
    mintEpoch(6);
    mintEpoch(7);
    const removed = reconcileEpochs(new Set([5, 7]));
    expect(removed.sort()).toEqual([6]);
    expect(agentTabIds()).toEqual(new Set([5, 7]));
  });

  it('reconcile is a no-op when every tab is still live', () => {
    mintEpoch(5);
    expect(reconcileEpochs(new Set([5]))).toEqual([]);
    expect(agentTabIds()).toEqual(new Set([5]));
  });
});

describe('serialize / hydrate (chrome.storage.session round-trip)', () => {
  it('serialises tabId->record with string keys', () => {
    const e5 = mintEpoch(5);
    const e6 = mintEpoch(6, 'writer');
    const snap = serializeEpochs();
    expect(Object.keys(snap)).toEqual(['5', '6']);
    expect(snap['5']).toMatchObject({ epoch: e5, human: false, orphaned: false });
    expect(snap['5'].session).toBeUndefined();
    expect(snap['6']).toMatchObject({ epoch: e6, session: 'writer' });
  });

  it('hydrates the pre-reaper snapshot shape (a bare epoch string)', () => {
    // The snapshot in chrome.storage.session outlives the extension reload that
    // installs a new build, so the OLD shape must still be readable — reading it
    // as garbage would un-own every live agent tab (every later call: tab_gone).
    hydrateEpochs({ '5': 'legacy-epoch' });
    expect(getEpoch(5)).toBe('legacy-epoch');
    expect(agentTabInfo()).toEqual([
      { tabId: 5, epoch: 'legacy-epoch', lastUsed: 0, human: false, orphaned: false },
    ]);
  });

  it('hydrate keeps the reaper bookkeeping and drops unusable fields', () => {
    hydrateEpochs({
      '5': { epoch: 'e', session: 'w', lastUsed: 1234, human: true, orphaned: true },
      '6': { epoch: 'f', lastUsed: 'soon', human: 'yes' },
      '7': { session: 'no-epoch-here' },
    });
    expect(agentTabInfo()).toEqual([
      { tabId: 5, epoch: 'e', session: 'w', lastUsed: 1234, human: true, orphaned: true },
      { tabId: 6, epoch: 'f', lastUsed: 0, human: false, orphaned: false },
    ]);
  });

  it('hydrates from a stored snapshot, parsing numeric keys', () => {
    hydrateEpochs({ '5': 'epoch-a', '6': 'epoch-b' });
    expect(getEpoch(5)).toBe('epoch-a');
    expect(getEpoch(6)).toBe('epoch-b');
    expect(agentTabIds()).toEqual(new Set([5, 6]));
  });

  it('hydrate replaces prior state', () => {
    mintEpoch(99);
    hydrateEpochs({ '1': 'only' });
    expect(getEpoch(99)).toBeUndefined();
    expect(getEpoch(1)).toBe('only');
  });

  it('hydrate tolerates malformed snapshots without throwing', () => {
    hydrateEpochs(null);
    expect(agentTabIds()).toEqual(new Set());
    hydrateEpochs('not-an-object');
    expect(agentTabIds()).toEqual(new Set());
    hydrateEpochs({ notanumber: 'x', '7': 123, '8': 'good' });
    expect(agentTabIds()).toEqual(new Set([8]));
    expect(getEpoch(8)).toBe('good');
  });

  it('round-trips through serialize -> hydrate, bookkeeping included', () => {
    mintEpoch(11, 'writer');
    mintEpoch(12);
    touchTab(11, 777);
    markHumanTab(11);
    markOrphanedTab(12);
    const snap = serializeEpochs();
    clearAllEpochs();
    hydrateEpochs(snap);
    expect(agentTabIds()).toEqual(new Set([11, 12]));
    expect(agentTabInfo()).toEqual([
      {
        tabId: 11,
        epoch: expect.any(String),
        session: 'writer',
        lastUsed: 777,
        human: true,
        orphaned: false,
      },
      {
        tabId: 12,
        epoch: expect.any(String),
        lastUsed: expect.any(Number),
        human: false,
        orphaned: true,
      },
    ]);
  });
});

describe('planEviction (the tab reaper policy)', () => {
  const tab = (
    tabId: number,
    over: Partial<{ session: string; lastUsed: number; human: boolean; orphaned: boolean }> = {},
  ) => ({
    tabId,
    epoch: `e${tabId}`,
    lastUsed: 0,
    human: false,
    orphaned: false,
    ...over,
  });

  it('does nothing while there is room for one more', () => {
    const tabs = [tab(1), tab(2)];
    expect(planEviction(tabs, 3)).toEqual([]);
  });

  it('frees exactly one slot when the create would cross the cap', () => {
    const tabs = [tab(1, { lastUsed: 10 }), tab(2, { lastUsed: 20 }), tab(3, { lastUsed: 30 })];
    // 3 tabs + the one about to be created = 4 > cap 3, so one must go: the
    // least recently used. Never more than the excess.
    expect(planEviction(tabs, 3)).toEqual([1]);
  });

  it("takes orphans before the creating session's own tabs", () => {
    const tabs = [
      tab(1, { session: 'mine', lastUsed: 1 }), // ours, oldest of all
      tab(2, { orphaned: true, lastUsed: 99 }), // an orphan, freshly used
    ];
    // A finished session's tab can never be named again by anyone; our own
    // stale tab still can. Age does not override that ordering.
    expect(planEviction(tabs, 2, 'mine')).toEqual([2]);
  });

  it('never evicts a tab the human engaged with, at any pressure', () => {
    const tabs = [
      tab(1, { orphaned: true, human: true, lastUsed: 1 }),
      tab(2, { session: 'mine', human: true, lastUsed: 2 }),
      tab(3, { session: 'mine', lastUsed: 3 }),
    ];
    // Excess is 2 (3 tabs + 1 vs cap 2) but only one tab is eligible, and the
    // plan stops there rather than reaching for a human's tab.
    expect(planEviction(tabs, 2, 'mine')).toEqual([3]);
  });

  it("never evicts another LIVE session's tabs", () => {
    const tabs = [
      tab(1, { session: 'other', lastUsed: 1 }),
      tab(2, { session: 'mine', lastUsed: 9 }),
    ];
    // 'other' is mid-task somewhere; taking its tab would break it. Ours goes
    // instead even though it is the more recently used of the two.
    expect(planEviction(tabs, 2, 'mine')).toEqual([2]);
    // ...and with nothing of ours to give, nobody is evicted at all.
    expect(planEviction([tab(1, { session: 'other' })], 1, 'mine')).toEqual([]);
  });

  it('treats an unlabelled session and the unlabelled slot as the same caller', () => {
    const tabs = [tab(1, { lastUsed: 5 })];
    expect(planEviction(tabs, 1, undefined)).toEqual([1]);
  });

  it('retires at most one still-in-play tab per create', () => {
    // The cap is global but a session only controls its own tabs. With other
    // sessions filling the browser the excess can be far larger than anything
    // this caller caused, and taking all of it would make a session that opens
    // one more page destroy its whole working set.
    const tabs = [
      ...[1, 2, 3, 4, 5].map((id) => tab(id, { session: 'mine', lastUsed: id })),
      ...[6, 7, 8, 9, 10].map((id) => tab(id, { session: 'other', lastUsed: id })),
    ];
    expect(planEviction(tabs, 4, 'mine')).toEqual([1]);
  });

  it('sweeps several orphans at once, but never past the excess', () => {
    // Orphans carry no such caveat — their session has exited, so nobody is
    // mid-task on them — but "free exactly enough room" still holds: the human
    // may want the rest.
    const tabs = [
      ...[1, 2, 3, 4].map((id) => tab(id, { orphaned: true, lastUsed: id })),
      tab(5, { session: 'mine', lastUsed: 99 }),
    ];
    expect(planEviction(tabs, 3, 'mine')).toEqual([1, 2, 3]);
  });

  it('is disabled by a zero, negative or unusable cap', () => {
    const tabs = [tab(1), tab(2), tab(3)];
    expect(planEviction(tabs, 0, 'mine')).toEqual([]);
    expect(planEviction(tabs, -5, 'mine')).toEqual([]);
    expect(planEviction(tabs, Number.NaN, 'mine')).toEqual([]);
  });

  it('breaks an exact lastUsed tie deterministically, oldest id first', () => {
    const tabs = [
      tab(9, { orphaned: true }),
      tab(4, { orphaned: true }),
      tab(7, { orphaned: true }),
    ];
    expect(planEviction(tabs, 1, 'mine')).toEqual([4, 7, 9]);
  });
});

describe('reaper bookkeeping', () => {
  it('touch updates the LRU key and marks are one-way', () => {
    mintEpoch(5, 'mine');
    touchTab(5, 4242);
    expect(agentTabInfo()[0]).toMatchObject({ lastUsed: 4242, human: false, orphaned: false });
    expect(markHumanTab(5)).toBe(true);
    expect(markHumanTab(5)).toBe(false); // already marked — caller skips the persist
    expect(markOrphanedTab(5)).toBe(true);
    expect(agentTabInfo()[0]).toMatchObject({ human: true, orphaned: true });
  });

  it('ignores a tab we do not own', () => {
    touchTab(404, 1);
    expect(markHumanTab(404)).toBe(false);
    expect(markOrphanedTab(404)).toBe(false);
    expect(agentTabInfo()).toEqual([]);
  });
});

describe('adopting a tab the PAGE opened', () => {
  it('adopts a tab whose opener is one of ours, inheriting the session', () => {
    // target="_blank", window.open, an OAuth popup: the browser makes the tab,
    // so it has no epoch — and everything downstream then treated it as a
    // stranger (owner-scoped list_tabs hid it, the popup sweep missed it, the
    // reaper never counted it) while the agent could not name it at all.
    mintEpoch(5, 'writer');
    expect(adoptOpenedTab(6, 5)).toBe(true);
    expect(getEpoch(6)).toEqual(expect.any(String));
    expect(getEpoch(6)).not.toBe(getEpoch(5)); // its own epoch, not the opener's
    expect(agentTabInfo().find((t) => t.tabId === 6)).toMatchObject({
      session: 'writer',
      human: false,
      orphaned: false,
    });
  });

  it("refuses a tab opened by the HUMAN's tab, or with no opener at all", () => {
    mintEpoch(5, 'writer');
    expect(adoptOpenedTab(7, 99)).toBe(false); // opener is not ours
    expect(adoptOpenedTab(8, undefined)).toBe(false); // no opener: a plain new tab
    expect(agentTabIds()).toEqual(new Set([5]));
  });

  it('never re-mints over a tab we already own', () => {
    const own = mintEpoch(5, 'writer');
    mintEpoch(6, 'writer');
    const before = getEpoch(6);
    expect(adoptOpenedTab(6, 5)).toBe(false);
    expect(getEpoch(6)).toBe(before);
    expect(getEpoch(5)).toBe(own);
  });

  it('reports each adoption exactly once', () => {
    // The daemon records ownership from this list; reporting twice would be
    // harmless, but never reporting is a tab nobody can name.
    mintEpoch(5, 'writer');
    adoptOpenedTab(6, 5);
    adoptOpenedTab(7, 5);
    const first = takeAdoptedTabs(5);
    expect(first.map((t) => t.tabId)).toEqual([6, 7]);
    expect(first[0].epoch).toBe(getEpoch(6));
    expect(takeAdoptedTabs(5)).toEqual([]);
  });

  it('keeps each opener queue separate', () => {
    mintEpoch(5, 'a');
    mintEpoch(50, 'b');
    adoptOpenedTab(6, 5);
    adoptOpenedTab(60, 50);
    expect(takeAdoptedTabs(50).map((t) => t.tabId)).toEqual([60]);
    expect(takeAdoptedTabs(5).map((t) => t.tabId)).toEqual([6]);
  });

  it('bounds a page that opens tabs in a loop', () => {
    mintEpoch(5, 'writer');
    for (let id = 100; id < 140; id++) adoptOpenedTab(id, 5);
    // The queue is capped; the tabs themselves are still adopted, so the popup
    // sweep and the reaper still see them.
    expect(takeAdoptedTabs(5).length).toBeLessThanOrEqual(20);
    expect(agentTabIds().size).toBe(41);
  });

  it('drops a queue whose opener closed — nobody will read it', () => {
    mintEpoch(5, 'writer');
    adoptOpenedTab(6, 5);
    dropEpoch(5);
    expect(takeAdoptedTabs(5)).toEqual([]);
    // The opened tab itself survives: it is a real tab and still ours.
    expect(getEpoch(6)).toEqual(expect.any(String));
  });
});
