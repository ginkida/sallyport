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

import { getSettings } from '../storage.js';
import {
  agentTabInfo,
  dropEpoch,
  hydrateEpochs,
  planEviction,
  reconcileEpochs,
  serializeEpochs,
} from './ownership.js';

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

/** How long we wait for one evicted tab to actually close.
 *
 * `chrome.tabs.remove` resolves only once the tab is GONE, and a page with a
 * `beforeunload` handler can hold that open indefinitely (the dialog is browser
 * UI; with dialog handling off, nobody answers it). This runs on the create
 * path, so an unbounded wait would hang the agent's `navigate` behind a page
 * nobody is looking at. */
const EVICT_DEADLINE_MS = 2000;

/** Close enough of our own tabs to make room for one more (the tab reaper).
 *
 * Called on the create-own path, before a new agent tab is opened. The POLICY
 * is `planEviction` (pure, unit-tested, and deliberately unable to touch a tab
 * the human engaged with or a live other session's); this is only its chrome
 * wiring. Returns the ids actually closed.
 *
 * Every step is best-effort and bounded: the point is to keep the browser from
 * filling up, and failing an agent's navigate because a doomed tab would not
 * die is a strictly worse outcome than one extra tab. A tab that does NOT close
 * keeps its epoch, so it stays visible to the popup's "Agent tabs" sweep —
 * dropping it there would strand it open, attached, and unreachable by every
 * path that could have tidied it. */
export async function reapAgentTabs(session?: string): Promise<number[]> {
  let doomed: number[] = [];
  try {
    const { maxAgentTabs } = await getSettings();
    doomed = planEviction(agentTabInfo(), maxAgentTabs, session);
  } catch {
    return []; // settings unreadable — never block a create over housekeeping
  }
  if (doomed.length === 0) return [];

  const closed: number[] = [];
  await Promise.all(
    doomed.map(async (tabId) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), EVICT_DEADLINE_MS);
      });
      try {
        const outcome = await Promise.race([
          chrome.tabs.remove(tabId).then(() => 'closed' as const),
          deadline,
        ]);
        if (outcome === 'closed') {
          closed.push(tabId);
          dropEpoch(tabId);
        }
      } catch {
        // already gone, or refused — leave the epoch so the popup can sweep it
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }),
  );
  // `chrome.tabs.onRemoved` normally does this bookkeeping, but it is a
  // separate event we may not have observed yet — and the count this reaper
  // reads next time depends on it being right.
  if (closed.length) await persistEpochs();
  return closed;
}
