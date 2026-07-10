import { beforeEach, describe, expect, it } from 'vitest';

import { resetAttachedTabs } from '../src/tools/cdp.js';
import { BridgeError } from '../src/tools/errors.js';
import {
  historyGo,
  parseHistoryDirection,
  parseHistorySteps,
  planHistoryHop,
  type HistoryEntry,
} from '../src/tools/history.js';
import { setAllowlist } from '../src/storage.js';

const entries: HistoryEntry[] = [
  { id: 10, url: 'https://a.example/start' },
  { id: 11, url: 'https://a.example/middle' },
  { id: 12, url: 'https://b.example/other' },
  { id: 13, url: 'https://a.example/current' },
];
const allowAExample = (url: string): boolean => new URL(url).hostname === 'a.example';

describe('parseHistoryDirection', () => {
  it('accepts back/forward', () => {
    expect(parseHistoryDirection('back')).toBe('back');
    expect(parseHistoryDirection('forward')).toBe('forward');
  });

  it('rejects anything else', () => {
    expect(() => parseHistoryDirection(undefined)).toThrowError(BridgeError);
    expect(() => parseHistoryDirection('backward')).toThrowError(/direction/);
    expect(() => parseHistoryDirection(1)).toThrowError(BridgeError);
  });
});

describe('parseHistorySteps', () => {
  it('defaults to 1', () => {
    expect(parseHistorySteps(undefined)).toBe(1);
    expect(parseHistorySteps(null)).toBe(1);
  });

  it('accepts positive integers', () => {
    expect(parseHistorySteps(3)).toBe(3);
  });

  it('rejects zero, negatives, fractions and non-numbers', () => {
    expect(() => parseHistorySteps(0)).toThrowError(BridgeError);
    expect(() => parseHistorySteps(-2)).toThrowError(BridgeError);
    expect(() => parseHistorySteps(1.5)).toThrowError(BridgeError);
    expect(() => parseHistorySteps('two')).toThrowError(BridgeError);
    expect(() => parseHistorySteps(Number.MAX_SAFE_INTEGER + 1)).toThrowError(BridgeError);
  });
});

describe('planHistoryHop', () => {
  it('goes back N steps to the right entry', () => {
    expect(planHistoryHop(entries, 3, 'back', 1, () => true).id).toBe(12);
    expect(planHistoryHop(entries, 3, 'back', 3, () => true).id).toBe(10);
  });

  it('goes forward from an earlier position', () => {
    expect(planHistoryHop(entries, 0, 'forward', 2, () => true).id).toBe(12);
  });

  it('no_history when the hop overshoots, message says how far it reaches', () => {
    expect(() => planHistoryHop(entries, 3, 'back', 4, () => true)).toThrowError(/only 3 entries/);
    expect(() => planHistoryHop(entries, 2, 'forward', 2, () => true)).toThrowError(
      /only 1 entry /,
    );
    try {
      planHistoryHop(entries, 3, 'back', 4, () => true);
      expect.unreachable();
    } catch (e) {
      expect((e as BridgeError).code).toBe('no_history');
    }
  });

  it('no_history at the very edge (nothing behind / ahead)', () => {
    expect(() => planHistoryHop(entries, 0, 'back', 1, () => true)).toThrowError(/nothing behind/);
    expect(() => planHistoryHop(entries, 3, 'forward', 1, () => true)).toThrowError(
      /nothing ahead/,
    );
  });

  it('gates the LANDING entry against the allowlist', () => {
    // back 1 lands on b.example — refused; back 2 lands on a.example — fine.
    try {
      planHistoryHop(entries, 3, 'back', 1, allowAExample);
      expect.unreachable();
    } catch (e) {
      expect((e as BridgeError).code).toBe('domain_not_allowed');
    }
    expect(planHistoryHop(entries, 3, 'back', 2, allowAExample).id).toBe(11);
  });

  it('SECURITY: the domain_not_allowed message does NOT echo the blocked hostname', () => {
    // history_go's tabId-less standalone fallback can target the human's
    // active tab; naming the blocked entry's host would let an agent probe
    // `steps` to enumerate hostnames from the human's browsing history that
    // the allowlist forbids touching (the same oracle tab_not_owned avoids
    // for tab identity).
    try {
      planHistoryHop(entries, 3, 'back', 1, allowAExample);
      expect.unreachable();
    } catch (e) {
      expect((e as BridgeError).message).not.toContain('b.example');
      expect((e as BridgeError).message).not.toContain('example.com');
    }
  });

  it('intermediate non-allowlisted entries do not block a jump over them', () => {
    // 0 → forward 3 hops OVER b.example (index 2) and lands on a.example.
    expect(planHistoryHop(entries, 0, 'forward', 3, allowAExample).id).toBe(13);
  });

  it('SECURITY: a malformed currentIndex fails with a classified error instead of crashing', () => {
    // Page.getNavigationHistory is an external CDP response; a malformed one
    // (e.g. entries:[] from the caller's Array.isArray fallback) must not
    // silently index past the array and throw an unclassified TypeError.
    for (const bad of [-1, 4, 4.5, NaN, Infinity]) {
      try {
        planHistoryHop(entries, bad, 'back', 1, () => true);
        expect.unreachable();
      } catch (e) {
        expect((e as BridgeError).code).toBe('error');
      }
    }
    // The specific case the fallback produces: entries=[] (CDP gave nothing
    // sane) paired with whatever currentIndex the response carried.
    try {
      planHistoryHop([], 0, 'back', 1, () => true);
      expect.unreachable();
    } catch (e) {
      expect((e as BridgeError).code).toBe('error');
    }
  });
});

// ---------------------------------------------------------------------------
// historyGo — chrome-bound integration: does the hop actually land where it
// claims to?
// ---------------------------------------------------------------------------

type MockTab = { id: number; url: string; status?: string };

/** Minimal chrome mock for historyGo: allowlist storage, a single tab whose
 * url/status the test controls, and the two CDP commands historyGo issues.
 * `hopSucceeds: false` simulates a beforeunload prompt cancelling the hop —
 * Page.navigateToHistoryEntry "succeeds" (resolves) but the tab never
 * actually leaves its current page, exactly like a dismissed beforeunload. */
function installHistoryChromeMock(opts: {
  tab: MockTab;
  navHistory: { currentIndex: number; entries: Array<{ id: number; url: string }> };
  hopSucceeds: boolean;
  /** Simulates a legitimate server-side redirect: the hop succeeds but the
   * tab lands on THIS url instead of the target entry's recorded url —
   * attaching CDP disables the back/forward cache, so a real redirect is a
   * live possibility, not an edge case. */
  redirectTo?: string;
}): void {
  const store = new Map<string, unknown>();
  let currentTab: MockTab = { ...opts.tab, status: opts.tab.status ?? 'complete' };
  // A cancelled hop: the browser transiently reports 'loading' (it DID start)
  // before settling back to 'complete' on the SAME url once beforeunload
  // dismisses it — this lets waitForHistoryTransition's poll resolve on its
  // very first tick (status changed) instead of running its full 2s timeout,
  // while still exercising the real "landed url mismatch" code path.
  let cancelledHopPending = false;
  let getCallsSinceCancel = 0;

  function currentSnapshot(): MockTab {
    if (!cancelledHopPending) return currentTab;
    getCallsSinceCancel++;
    if (getCallsSinceCancel === 1) return { ...currentTab, status: 'loading' };
    cancelledHopPending = false;
    return currentTab; // settled back on the ORIGINAL url — the hop never landed
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
      session: {
        async get() {
          return {};
        },
        async set() {},
      },
    },
    tabs: {
      async query() {
        return [currentTab];
      },
      get(tabId: number, cb?: (t: MockTab) => void) {
        const tab = currentSnapshot();
        if (cb) {
          cb(tab);
          return;
        }
        return Promise.resolve(tab);
      },
      onUpdated: { addListener() {}, removeListener() {} },
    },
    debugger: {
      attach() {
        return Promise.resolve();
      },
      sendCommand(_target: { tabId: number }, method: string, params?: { entryId?: number }) {
        if (method === 'Page.getNavigationHistory') {
          return Promise.resolve(opts.navHistory);
        }
        if (method === 'Page.navigateToHistoryEntry') {
          if (opts.hopSucceeds) {
            const entry = opts.navHistory.entries.find((e) => e.id === params?.entryId);
            const landedUrl = opts.redirectTo ?? entry?.url;
            if (landedUrl) currentTab = { id: currentTab.id, url: landedUrl, status: 'complete' };
          } else {
            cancelledHopPending = true;
            getCallsSinceCancel = 0;
          }
          return Promise.resolve({});
        }
        return Promise.resolve({});
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
}

describe('historyGo — verifies the hop actually landed', () => {
  const navHistory = {
    currentIndex: 1,
    entries: [
      { id: 10, url: 'https://allowed.example/start' },
      { id: 11, url: 'https://allowed.example/current' },
    ],
  };

  beforeEach(() => {
    resetAttachedTabs();
  });

  it('reports the target url when the hop actually lands', async () => {
    installHistoryChromeMock({
      tab: { id: 1, url: 'https://allowed.example/current' },
      navHistory,
      hopSucceeds: true,
    });
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    const result = (await historyGo({ tabId: 1, direction: 'back' })) as {
      data: { url: string };
    };
    expect(result.data.url).toBe('https://allowed.example/start');
  });

  it('SECURITY/CORRECTNESS: does NOT report success when a beforeunload prompt cancels the hop', async () => {
    installHistoryChromeMock({
      tab: { id: 1, url: 'https://allowed.example/current' },
      navHistory,
      hopSucceeds: false,
    });
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    let caught: unknown;
    try {
      await historyGo({ tabId: 1, direction: 'back' });
      expect.unreachable();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BridgeError);
    expect((caught as BridgeError).code).toBe('navigation_cancelled');
  });

  it('CORRECTNESS: a legitimate server-side redirect during the hop is NOT reported as cancelled', async () => {
    // Attaching CDP disables the back/forward cache, so a history hop is
    // always a live navigation and can redirect (session expiry -> /login,
    // http->https normalization, ...). The old exact-match-to-target check
    // would misfire here; verifying against beforeUrl must not.
    installHistoryChromeMock({
      tab: { id: 1, url: 'https://allowed.example/current' },
      navHistory,
      hopSucceeds: true,
      redirectTo: 'https://allowed.example/login',
    });
    await setAllowlist([{ pattern: 'allowed.example', allowEvaluate: false, addedAt: 0 }]);
    const result = (await historyGo({ tabId: 1, direction: 'back' })) as {
      data: { url: string };
    };
    // Reports where the tab ACTUALLY landed, not the (now-inaccurate) target.
    expect(result.data.url).toBe('https://allowed.example/login');
  });
});
