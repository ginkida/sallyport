/** Per-tab serialisation of work on a tab. LEAF module: no local imports.
 *
 * It lives here rather than in `tools.ts` because `cdp.ts` schedules its idle
 * hygiene flush on the same chain the tool calls run on, and `cdp.ts` is
 * imported by nearly every tool module — `tools.ts` imports all of those, so
 * `cdp.ts → tools.ts` would be a cycle. `imports.test.ts` pins this file as a
 * leaf.
 *
 * Calls overlap (the daemon runs one lane per session, and the connection no
 * longer queues them), and per-tab state is emphatically NOT safe for two
 * concurrent calls on the SAME tab: `buildSnapshotTree` resets that tab's refs
 * mid-flight, and snapshot/mouse release a shared CDP object group in their
 * `finally` — a second call would have its handles freed under it and its `@eN`
 * refs renumbered. The hygiene flush releases the per-call object group and
 * disables the DOM agent, which must not land inside a call either.
 *
 * It is defence-in-depth for tool calls, not a load-bearing gate: the daemon's
 * per-client lane is what actually serialises, and since ownership is exclusive
 * per client (invariant #13) "one call per client" already implies "one call
 * per tab". Standalone is a single lane too, so it is uncontended there as
 * well. The point is that `runTool` is the one chokepoint every tool passes
 * through, so a future change that widens daemon concurrency cannot silently
 * corrupt per-tab state (refs, snapshot/mouse object groups) before anyone
 * notices. It costs nothing when uncontended. */
const tabChains = new Map<number, Promise<unknown>>();

/** Run `run` after everything already queued on `tabId` has settled (either
 * way). A non-numeric tabId runs immediately, unqueued — the tabId-less calls
 * (standalone active-tab fallback, create-own navigate), which is why the
 * hygiene flush also tracks CDP activity rather than relying on the chain. */
export function onTab<T>(tabId: number | undefined, run: () => Promise<T>): Promise<T> {
  if (typeof tabId !== 'number') return run();
  const prior = tabChains.get(tabId) ?? Promise.resolve();
  const next = prior.then(run, run);
  // Never let a rejection break the chain for later calls, and drop the entry
  // once the tab goes quiet so the map doesn't grow with every tab ever driven.
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  tabChains.set(tabId, settled);
  void settled.then(() => {
    if (tabChains.get(tabId) === settled) tabChains.delete(tabId);
  });
  return next;
}
