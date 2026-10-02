/** Per-tab map of `eN` refs returned by `snapshot`. Per-tab so that
 * `snapshot(tabId=5)` doesn't invalidate refs for tab 7, and
 * `click(@e1, tabId=A)` can never resolve to a node in tab B. */

/** What one `@eN` names.
 *
 * `loaderId` is the main frame's loader id of the DOCUMENT the ref was minted
 * in, read BEFORE the walk that produced `backendDOMNodeId` (`resolve.ts:
 * mainFrameLoaderId`). It is what keeps a ref from crossing a navigation the
 * PAGE started (a link, a form submit, a script redirect — none of which go
 * through a tool that wipes the map): a backendNodeId is only unique within one
 * renderer process, and a new process numbers its nodes from 1 again, so after
 * a cross-process navigation the old id resolves to a LIVE node of the new
 * document (measured on Chrome 154: 41 of 41 old ids). Every resolve compares
 * this against the tab's current loader id and refuses a mismatch as `bad_ref`
 * (`resolve.ts:refDocumentIsCurrent`). `null` = the browser did not say at mint
 * time; such a ref never resolves (fail-closed). */
export type RefInfo = {
  backendDOMNodeId: number;
  role: string;
  name: string;
  loaderId: string | null;
};

const refsByTab = new Map<number, Map<string, RefInfo>>();
const refCounterByTab = new Map<number, number>();

export function newRef(
  tabId: number,
  backendDOMNodeId: number,
  role: string,
  name: string,
  loaderId: string | null,
): string {
  let map = refsByTab.get(tabId);
  if (!map) {
    map = new Map();
    refsByTab.set(tabId, map);
  }
  const counter = (refCounterByTab.get(tabId) ?? 0) + 1;
  refCounterByTab.set(tabId, counter);
  const id = `e${counter}`;
  map.set(id, { backendDOMNodeId, role, name, loaderId });
  return id;
}

export function getRef(tabId: number, idOrRef: string): RefInfo | null {
  const key = idOrRef.startsWith('@') ? idOrRef.slice(1) : idOrRef;
  return refsByTab.get(tabId)?.get(key) ?? null;
}

export function isRef(s: string): boolean {
  return /^@?e\d+$/.test(s);
}

/** Forget a tab's refs AND restart its numbering at `e1`.
 *
 * ONLY for a tab that no longer exists (`tabs.onRemoved`): its id can never be
 * named again, so there is no `@eN` an agent could still hold against it.
 *
 * Everything else that invalidates refs — a navigation, a reload, a history
 * hop, a viewport change, a debugger detach — uses `resetRefsForTab` and keeps
 * counting. Restarting there was the one place ids were reissued on a LIVE tab:
 * the next snapshot handed out `@e5` again, and an agent still holding the old
 * `@e5` silently got the new element, with a matching loader id, so not even
 * the document check (`RefInfo.loaderId`) could tell. */
export function clearRefsForTab(tabId: number): void {
  refsByTab.delete(tabId);
  refCounterByTab.delete(tabId);
}

/** How many refs this tab has ever handed out — the point `resetRefsForTab` can
 * be rewound to. Taken once at the start of a snapshot so the walk's own
 * discarded attempts don't inflate the ids the agent actually sees. */
export function refWatermark(tabId: number): number {
  return refCounterByTab.get(tabId) ?? 0;
}

/** Forget a tab's refs but KEEP counting where the last one left off.
 *
 * Called by `buildSnapshotTree`, i.e. by every `snapshot`/`find`/`reveal`, and
 * by everything else that makes the old ids describe nothing on a tab that is
 * still alive: navigate/reload/history_go/set_viewport and every debugger
 * detach (`cdp.ts`). Restarting at `e1` here used to make a re-snapshot silently REBIND
 * old ids: after `snapshot` → `find`, the agent's `@e5` still resolved, but to
 * whatever element happened to be fifth in the new walk — a wrong click on the
 * human's own logged-in profile, reported as success, with nothing in the result
 * to hint at it. Monotonic ids turn that into a miss on `refsByTab`, which is
 * the existing `bad_ref` / `unknown_ref` path the error taxonomy already tells
 * the agent how to recover from ("re-snapshot"). The cost is one or two extra
 * characters per ref; the counter restarts at `e1` only when the tab is closed
 * (`clearRefsForTab`).
 *
 * `watermark` rewinds the counter — ONLY sound for ids that were never returned
 * to the agent. `buildSnapshotTree` mints, discards and re-mints internally (a11y
 * attempt, DOM cross-check, a11y rebuild) before returning one of them, and those
 * intermediate ids leave the extension in no result, so rewinding to the mark
 * taken at its entry keeps `@eN` tight without ever reusing a number an agent
 * could be holding. Safe against overlap because one tab runs one call at a time
 * (invariant #8). */
export function resetRefsForTab(tabId: number, watermark?: number): void {
  // Dropping the map (rather than storing an empty one) means a reset that
  // arrives for an already-closed tab — `debugger.onDetach` can land after
  // `tabs.onRemoved` — leaves nothing behind; `newRef` re-creates the map.
  refsByTab.delete(tabId);
  if (watermark !== undefined) refCounterByTab.set(tabId, watermark);
}
