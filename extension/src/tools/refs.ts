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

export function clearRefsForTab(tabId: number): void {
  refsByTab.delete(tabId);
  refCounterByTab.delete(tabId);
}

export function resetRefsForTab(tabId: number): void {
  refsByTab.set(tabId, new Map());
  refCounterByTab.set(tabId, 0);
}
