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
 * fail a tool call, so it is swallowed — but never made STICKY. A refused load
 * is retried by the next call, and a refused write re-arms itself so the next
 * call writes again; memoising either failure kept the protection off for the
 * ids minted after it. And until a load has succeeded this
 * worker writes nothing: its snapshot holds only the tabs IT touched, and the
 * write replaces the stored map whole, so it would erase every other live
 * tab's mark — a loss a later, healthy worker would then inherit. */

import { markRefMarksDirty, seedRefCounters, takeRefMarks } from './refs.js';

const STORE_KEY = 'sallyport_ref_marks';

function storageArea(): chrome.storage.StorageArea | undefined {
  return typeof chrome !== 'undefined' ? chrome.storage?.local : undefined;
}

let loading: Promise<void> | undefined;
/** A load has completed: the stored marks are folded into this worker's, so a
 * write of its snapshot drops nothing but closed tabs. */
let loaded = false;

/** Resume this worker's counters from the persisted marks. Memoised once it
 * succeeds; a failed load is forgotten so the next call tries again. Never
 * rejects. */
export function loadRefMarks(): Promise<void> {
  if (loading) return loading;
  // The reset runs in a `.then`, so always after `loading` is assigned below and
  // never against a newer attempt.
  const attempt: Promise<void> = readMarks().then((ok) => {
    if (ok) loaded = true;
    else if (loading === attempt) loading = undefined;
  });
  loading = attempt;
  return attempt;
}

/** One load attempt; `false` when storage or tabs refused (never rejects). */
async function readMarks(): Promise<boolean> {
  const area = storageArea();
  if (!area) return true; // nothing to load from, nothing a write could erase
  try {
    const got = await area.get(STORE_KEY);
    const marks = (got as Record<string, unknown>)[STORE_KEY];
    if (marks !== undefined) {
      const live = new Set<number>();
      for (const t of await chrome.tabs.query({})) if (typeof t.id === 'number') live.add(t.id);
      seedRefCounters(marks, live);
    }
    return true;
  } catch {
    // storage or tabs unavailable — count from where this worker stands, and
    // let the next call try again
    return false;
  }
}

let lastWrite: Promise<void> = Promise.resolve();

/** Write the marks if they changed, and wait for the newest write either way:
 * a call whose ids were covered by ANOTHER call's write must not return before
 * that write lands. Never rejects.
 *
 * A worker whose load has not succeeded yet first retries it, and writes
 * nothing if it fails again (the marks stay dirty for the next call). */
export function persistRefMarks(): Promise<void> {
  if (!loaded) {
    return (async () => {
      await loadRefMarks();
      if (loaded) await persistRefMarks();
      else await lastWrite;
    })();
  }
  const marks = takeRefMarks();
  const area = storageArea();
  if (marks && area) {
    lastWrite = (async () => {
      try {
        await area.set({ [STORE_KEY]: marks });
      } catch {
        // best-effort — see the module comment; the next call writes again
        markRefMarksDirty();
      }
    })();
  }
  return lastWrite;
}

/** Forget the memoised load (test hook). */
export function resetRefStore(): void {
  loading = undefined;
  loaded = false;
  lastWrite = Promise.resolve();
}
