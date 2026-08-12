/** Per-tab map of `eN` refs returned by `snapshot`. Per-tab so that
 * `snapshot(tabId=5)` doesn't invalidate refs for tab 7, and
 * `click(@e1, tabId=A)` can never resolve to a node in tab B. */

export type RefInfo = { backendDOMNodeId: number; role: string; name: string };

const refsByTab = new Map<number, Map<string, RefInfo>>();
const refCounterByTab = new Map<number, number>();

export function newRef(
  tabId: number,
  backendDOMNodeId: number,
  role: string,
  name: string,
): string {
  let map = refsByTab.get(tabId);
  if (!map) {
    map = new Map();
    refsByTab.set(tabId, map);
  }
  const counter = (refCounterByTab.get(tabId) ?? 0) + 1;
  refCounterByTab.set(tabId, counter);
  const id = `e${counter}`;
  map.set(id, { backendDOMNodeId, role, name });
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
 * For the events that make the whole ref space meaningless anyway: a
 * navigation, a reload, a history hop, a viewport change, a debugger detach.
 * The page the old ids described is gone, so reusing `e1` cannot alias anything
 * an agent could still be holding a sensible expectation about. */
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
 * Called by `buildSnapshotTree`, i.e. by every `snapshot`/`find`/`reveal` on the
 * SAME page. Restarting at `e1` here used to make a re-snapshot silently REBIND
 * old ids: after `snapshot` → `find`, the agent's `@e5` still resolved, but to
 * whatever element happened to be fifth in the new walk — a wrong click on the
 * human's own logged-in profile, reported as success, with nothing in the result
 * to hint at it. Monotonic ids turn that into a miss on `refsByTab`, which is
 * the existing `bad_ref` / `unknown_ref` path the error taxonomy already tells
 * the agent how to recover from ("re-snapshot"). The cost is one or two extra
 * characters per ref; the counter restarts at `e1` on the next real navigation.
 *
 * `watermark` rewinds the counter — ONLY sound for ids that were never returned
 * to the agent. `buildSnapshotTree` mints, discards and re-mints internally (a11y
 * attempt, DOM cross-check, a11y rebuild) before returning one of them, and those
 * intermediate ids leave the extension in no result, so rewinding to the mark
 * taken at its entry keeps `@eN` tight without ever reusing a number an agent
 * could be holding. Safe against overlap because one tab runs one call at a time
 * (invariant #8). */
export function resetRefsForTab(tabId: number, watermark?: number): void {
  refsByTab.set(tabId, new Map());
  if (watermark !== undefined) refCounterByTab.set(tabId, watermark);
}
