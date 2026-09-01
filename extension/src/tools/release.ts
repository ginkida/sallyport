/** `_release_tabs` — hand a disconnected session's tabs back, or sweep them.
 *
 * DAEMON-INITIATED, never agent-callable: it is absent from the public `tools`
 * registry (and therefore from `TOOL_NAMES` and the MCP catalogue) AND refused
 * by name for every MCP client in `bridge.INTERNAL_TOOLS` — the catalogue alone
 * is not a gate, since the SDK forwards unlisted names through. The broker calls
 * it when an MCP client disconnects, passing the tabs that client owned together
 * with the ownership epoch it recorded for each.
 *
 * BY DEFAULT the tabs stay OPEN: closing an agent's half-finished work is
 * exactly the loss invariant #12 gates `close_tab` against, and for an
 * interactive session those tabs are usually the result the human wanted. What
 * we always stop is the DRIVING — the debugger session goes away, and with it
 * Chrome's "started debugging this browser" bar, the disabled back/forward cache
 * and the sticky focus emulation that makes the page report itself visible.
 *
 * With `Settings.closeAgentTabsOnDisconnect` on, the tabs are CLOSED instead.
 * That switch is browser-global and cannot distinguish an ephemeral agent from
 * an interactive one — see its doc comment in storage.ts.
 *
 * Every step is best-effort per tab: this runs on a disconnect path, so one
 * vanished tab must not stop the rest from being released.
 */

import { getSettings } from '../storage.js';
import { detach } from './cdp.js';
import { dropEpoch, getEpoch, markOrphanedTab } from './ownership.js';
import { persistEpochs } from './ownership-store.js';
import type { Tool } from './types.js';

/** What to do with a disconnected session's tab.
 *
 * `hand-back` is the default and the conservative one: stop driving the tab but
 * leave it open. `close` is opt-in, for EPHEMERAL agents — a dispatched one-shot
 * run is a new MCP session every time, so each run's tabs are orphaned on exit
 * and no later session can reach them (they are owner-scoped), which means they
 * pile up until a human sweeps them from the popup. Pure so the policy is
 * unit-tested rather than inferred from the chrome calls. */
export function releaseAction(closeOnDisconnect: boolean): 'close' | 'hand-back' {
  return closeOnDisconnect ? 'close' : 'hand-back';
}

/** One tab as the daemon names it: its id plus the ownership epoch the daemon
 * recorded (absent when the registry had none yet — e.g. mid-reconcile). */
export type ReleaseEntry = { tabId: number; epoch?: string };

export function parseReleaseEntries(raw: unknown): ReleaseEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ReleaseEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { tabId, epoch } = item as { tabId?: unknown; epoch?: unknown };
    if (typeof tabId !== 'number') continue;
    out.push(typeof epoch === 'string' ? { tabId, epoch } : { tabId });
  }
  return out;
}

/** May we DESTROY this tab?
 *
 * Only when the epoch the daemon recorded matches the one we minted. `getEpoch`
 * alone answers "is this SOME agent tab", not "is this THE tab that session
 * created" — and those differ exactly where it matters: Chrome recycles tab ids,
 * the daemon's registry can outlive a browser restart, and our epoch map cannot
 * (it lives in `chrome.storage.session`). Without this check a disconnecting
 * client could close a live tab belonging to a DIFFERENT session that now holds
 * the same id. Fail-closed: no recorded epoch on either side means hand back,
 * never close. This is the same question `confirmEpoch` answers for ordinary
 * tool calls, which cannot cover this one because it carries an array. */
export function mayClose(entry: ReleaseEntry, minted: string | undefined): boolean {
  return typeof entry.epoch === 'string' && minted === entry.epoch;
}

/** Tabs released at once. A disconnect releases a WHOLE session's tabs, and
 * each one costs a bounded-but-real wait: `detach` alone gives the renderer up
 * to `VIEWPORT_RELEASE_DEADLINE_MS` to answer the emulation clear. Serially,
 * forty tabs could outlast the daemon's 60 s request timeout — so a session
 * that opened a lot of tabs was exactly the one whose release got dropped, and
 * every one of its tabs kept its debugger session. Bounded rather than
 * unbounded because these are CDP round-trips to one browser. */
const RELEASE_CONCURRENCY = 8;

/** Hand one tab back (or close it). Returns what happened, so the caller can
 * total it up without shared mutable state across concurrent workers. */
async function releaseOne(
  entry: ReleaseEntry,
  action: 'close' | 'hand-back',
): Promise<{ released: boolean; closed: boolean; dropped: boolean }> {
  const { tabId } = entry;
  const minted = getEpoch(tabId);
  // Defence in depth: only ever touch a tab WE created. Only agent-created
  // tabs have a recorded epoch, so this is exactly the right filter — and it
  // is fail-closed.
  if (minted === undefined) return { released: false, closed: false, dropped: false };

  if (action === 'close' && mayClose(entry, minted)) {
    // Remove FIRST and skip the detach: removing the tab ends its CDP session
    // anyway, and detaching beforehand would tear down the dialog handling
    // that is the only thing able to answer a `beforeunload` the removal
    // might raise.
    try {
      await chrome.tabs.remove(tabId);
      return { released: true, closed: true, dropped: dropEpoch(tabId) };
    } catch {
      // Still there (or already gone). Fall back to handing it back, and KEEP
      // the epoch so the tab stays visible to the popup's sweep.
      await detach(tabId);
      return { released: true, closed: false, dropped: false };
    }
  }

  await detach(tabId);
  try {
    // The human owns it now; a tab that keeps agent-imposed mute would be a
    // confusing thing to inherit.
    await chrome.tabs.update(tabId, { muted: false });
  } catch {
    // tab already closed — nothing to hand back
  }
  // KEEP the epoch on the hand-back path. It is what puts the tab in the
  // popup's "Agent tabs" list, which is the documented way for a human to
  // sweep up what finished sessions left behind — dropping it here made those
  // tabs invisible to the very sweep the docs point at. It grants no access:
  // the daemon has already forgotten the tab, so no client can name it, and a
  // dead id is pruned by `reconcileWithLiveTabs` on the next worker wake.
  //
  // Mark it an ORPHAN, though: its session is gone, so no client can ever name
  // it again, and that is precisely what makes it the first thing the tab
  // reaper should take when a later session needs room (`planEviction`). Not a
  // close — the human may still want it, and if they so much as look at it the
  // reaper stops considering it for good.
  const dropped = markOrphanedTab(tabId);
  return { released: true, closed: false, dropped };
}

export const releaseTabs: Tool = async (args) => {
  const entries = parseReleaseEntries(args.tabs);
  const { closeAgentTabsOnDisconnect } = await getSettings();
  const action = releaseAction(closeAgentTabsOnDisconnect);
  let released = 0;
  let closed = 0;
  let changed = false;

  for (let i = 0; i < entries.length; i += RELEASE_CONCURRENCY) {
    const batch = entries.slice(i, i + RELEASE_CONCURRENCY);
    const outcomes = await Promise.all(batch.map((entry) => releaseOne(entry, action)));
    for (const outcome of outcomes) {
      if (outcome.released) released++;
      if (outcome.closed) closed++;
      if (outcome.dropped) changed = true;
    }
  }

  if (changed) await persistEpochs();
  return { data: { released, closed } };
};
