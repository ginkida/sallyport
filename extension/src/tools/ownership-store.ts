/** Chrome-bound persistence for the tab-ownership epoch map (invariant #13).
 *
 * The pure registry lives in `ownership.ts`; this thin layer ties it to the
 * browser so it survives an MV3 service-worker eviction:
 *  - `persistEpochs` snapshots the map into `chrome.storage.session` (cleared
 *    when the browser closes, but kept across SW restarts — exactly the
 *    lifetime a tab id has);
 *  - `loadEpochs` rehydrates it on SW boot;
 *  - `reconcileWithLiveTabs` prunes ids whose tab is gone, against the live
 *    `chrome.tabs.query` set, before any owned-tab call is honoured.
 *
 * Every call is best-effort: a storage/query failure must never crash a tool
 * call (the daemon remains the authoritative gate), so failures are swallowed.
 * Chrome-bound, so it sits outside the vitest coverage gate (the pure primitives
 * it drives are unit-tested in ownership.test.ts; this is exercised via manual
 * `sallyport-daemon exec`). */

import { hydrateEpochs, reconcileEpochs, serializeEpochs } from './ownership.js';

const STORE_KEY = 'sallyport_epochs';

/** Snapshot the in-memory epoch map into chrome.storage.session. */
export async function persistEpochs(): Promise<void> {
  try {
    await chrome.storage.session.set({ [STORE_KEY]: serializeEpochs() });
  } catch {
    // best-effort: a failed persist only costs us reconciliation on next wake.
  }
}

/** Rehydrate the epoch map from chrome.storage.session (SW boot). */
export async function loadEpochs(): Promise<void> {
  try {
    const got = await chrome.storage.session.get(STORE_KEY);
    hydrateEpochs((got as Record<string, unknown>)[STORE_KEY]);
  } catch {
    // no snapshot / storage unavailable — start from an empty map.
  }
}

/** Prune epochs for tabs that no longer exist, against the live tab set, and
 * persist if anything changed. Run on SW wake before honouring owned-tab calls
 * so a recycled id never resolves to the wrong page. */
export async function reconcileWithLiveTabs(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    const live = new Set<number>();
    for (const t of tabs) if (typeof t.id === 'number') live.add(t.id);
    const removed = reconcileEpochs(live);
    if (removed.length) await persistEpochs();
  } catch {
    // query unavailable — leave the map as-is; the daemon gate still holds.
  }
}
