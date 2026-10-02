/** Chrome-bound persistence for the `@eN` counters' high-water marks (#7).
 *
 * The counters live in worker memory (`refs.ts`), and an MV3 worker restart or
 * an extension reload wipes them while the tab and its document live on — so
 * without this a held `@e5` could be re-issued for a different element of the
 * very page it was minted on, which the loader-id stamp cannot catch.
 *
 * `chrome.storage.local`, not `.session`: an extension reload clears the
 * session area but not the tabs. A mark for a tab that is gone is pruned on
 * load against the live tab set, and one that survives a browser restart under
 * a reused id only makes that tab's ids start higher — never lower.
 *
 * `runTool` awaits `loadRefMarks` before any tool runs and `persistRefMarks`
 * before a result leaves the extension. Best-effort: a storage failure must not
 * fail a tool call, so it is swallowed (the counters then behave as before). */

import { seedRefCounters, takeRefReservations } from './refs.js';

const STORE_KEY = 'sallyport_ref_marks';

function storageArea(): chrome.storage.StorageArea | undefined {
  return typeof chrome !== 'undefined' ? chrome.storage?.local : undefined;
}

let loading: Promise<void> | undefined;

/** Resume this worker's counters from the persisted marks. Memoised: every
 * call after the first waits on the same load. Never rejects. */
export function loadRefMarks(): Promise<void> {
  loading ??= (async () => {
    const area = storageArea();
    if (!area) return;
    try {
      const got = await area.get(STORE_KEY);
      const marks = (got as Record<string, unknown>)[STORE_KEY];
      if (marks === undefined) return;
      const live = new Set<number>();
      for (const t of await chrome.tabs.query({})) if (typeof t.id === 'number') live.add(t.id);
      seedRefCounters(marks, live);
    } catch {
      // storage or tabs unavailable — count from where this worker stands
    }
  })();
  return loading;
}

let lastWrite: Promise<void> = Promise.resolve();

/** Write the marks if they changed, and wait for the newest write either way:
 * a call whose ids were covered by ANOTHER call's write must not return before
 * that write lands. Never rejects. */
export function persistRefMarks(): Promise<void> {
  const marks = takeRefReservations();
  const area = storageArea();
  if (marks && area) {
    lastWrite = (async () => {
      try {
        await area.set({ [STORE_KEY]: marks });
      } catch {
        // best-effort — see the module comment
      }
    })();
  }
  return lastWrite;
}

/** Forget the memoised load (test hook). */
export function resetRefStore(): void {
  loading = undefined;
  lastWrite = Promise.resolve();
}
