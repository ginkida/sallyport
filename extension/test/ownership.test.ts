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
  isBrokerMode,
  mintEpoch,
  reconcileEpochs,
  serializeEpochs,
  setBrokerMode,
  stripEpochArg,
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

describe('stripEpochArg', () => {
  it('removes the broker-internal epoch field, returning a copy', () => {
    const args = { tabId: 5, [EXPECTED_EPOCH_ARG]: 'e1', selector: '#x' };
    const out = stripEpochArg(args);
    expect(out).toEqual({ tabId: 5, selector: '#x' });
    expect(EXPECTED_EPOCH_ARG in args).toBe(true); // original untouched
  });

  it('returns args unchanged when no epoch field is present', () => {
    const args = { tabId: 5 };
    expect(stripEpochArg(args)).toBe(args);
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
  it('serialises tabId->epoch with string keys', () => {
    const e5 = mintEpoch(5);
    const e6 = mintEpoch(6);
    expect(serializeEpochs()).toEqual({ '5': e5, '6': e6 });
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

  it('round-trips through serialize -> hydrate', () => {
    mintEpoch(11);
    mintEpoch(12);
    const snap = serializeEpochs();
    clearAllEpochs();
    hydrateEpochs(snap);
    expect(agentTabIds()).toEqual(new Set([11, 12]));
  });
});
