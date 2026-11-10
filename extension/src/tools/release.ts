/** `_release_tabs` — hand a disconnected session's tabs back, or sweep them.
 *
 * DAEMON-INITIATED, never agent-callable: it is absent from the public `tools`
 * registry (and therefore from `TOOL_NAMES` and the MCP catalogue) AND refused
 * by name for every MCP client in `bridge.INTERNAL_TOOLS` — the catalogue alone
 * is not a gate, since the SDK forwards unlisted names through. The broker calls
 * it when an MCP client disconnects, passing the tabs that client owned together
 * with the ownership epoch it recorded for each.
 *
 * BY DEFAULT the tabs are CLOSED — an agent cleans up after itself. Nobody can
 * name a disconnected session's tabs again (they are owner-scoped), so left
 * open they only accumulate: each one a live renderer in the human's browser
 * until someone sweeps the popup. The one exception is a tab the HUMAN engaged
 * with (activated it in a focused window, dragged it into their own): that one
 * is somebody's now, and it is handed back instead — left open, but no longer
 * DRIVEN: the debugger session goes away, and with it Chrome's "started
 * debugging this browser" bar, the focus emulation that keeps the page
 * rendering as if visible, and the DevTools-open status that keeps the tab out
 * of memory-saver discards.
 *
 * With `Settings.keepAgentTabsOnDisconnect` on, every tab is handed back that
 * way (the pre-0.27 default). The switch is browser-global — see its doc
 * comment in storage.ts.
 *
 * Every step is best-effort per tab: this runs on a disconnect path, so one
 * vanished tab must not stop the rest from being released.
 */

import { getSettings } from '../storage.js';
import { detach } from './cdp.js';
import { agentTabInfo, agentTabRecord, dropEpoch, getEpoch, markOrphanedTab } from './ownership.js';
import { persistEpochs } from './ownership-store.js';
import { closeAgentTab, inFrontOfHuman, pageTargets, type PageTargets } from './quiet-leave.js';
import type { Tool } from './types.js';

/** What to do with a disconnected session's tab.
 *
 * `close` is the default: the session is gone, no later one can reach its tabs,
 * and a tab nobody can drive and nobody looked at is only a cost. `hand-back`
 * (stop driving, leave open) is what a tab the HUMAN engaged with always gets —
 * destroying something a person is looking at is the loss `close_tab`'s gate
 * exists to prevent — and what every tab gets when the human asked to keep
 * them. Pure so the policy is unit-tested rather than inferred from the chrome
 * calls. */
export function releaseAction(keepOnDisconnect: boolean, human = false): 'close' | 'hand-back' {
  return keepOnDisconnect || human ? 'hand-back' : 'close';
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
  keep: boolean,
  targets?: PageTargets,
): Promise<{ released: boolean; closed: boolean; dropped: boolean }> {
  const { tabId } = entry;
  const minted = getEpoch(tabId);
  // Defence in depth: only ever touch a tab WE created. Only agent-created
  // tabs have a recorded epoch, so this is exactly the right filter — and it
  // is fail-closed.
  if (minted === undefined) return { released: false, closed: false, dropped: false };
  // "Human" is the recorded mark OR the tab being in front of a person right
  // now (active tab of the focused window): someone can read or type in a tab
  // without producing the events the mark is built from, and the mark itself
  // can be missed by a worker that was asleep. Browser-answered, fail-closed.
  const human = agentTabRecord(tabId)?.human === true || (!keep && (await inFrontOfHuman(tabId)));
  const action = releaseAction(keep, human);

  if (action === 'close' && mayClose(entry, minted)) {
    // Close FIRST and skip the detach: closing the tab ends its CDP session
    // anyway. Quietly — without the tab's beforeunload prompt, which Chrome
    // would show by raising this agent window over the human's work, and
    // which would hold this release until someone answered it
    // (quiet-leave.ts).
    try {
      await closeAgentTab(tabId, { targets });
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

async function releaseEntries(
  entries: ReleaseEntry[],
  forceKeep = false,
): Promise<{ released: number; closed: number }> {
  const keep = forceKeep || (await getSettings()).keepAgentTabsOnDisconnect;
  let released = 0;
  let closed = 0;
  let changed = false;
  // One target lookup for the whole release, not one per tab.
  const targets = keep ? undefined : await pageTargets();

  for (let i = 0; i < entries.length; i += RELEASE_CONCURRENCY) {
    const batch = entries.slice(i, i + RELEASE_CONCURRENCY);
    const outcomes = await Promise.all(batch.map((entry) => releaseOne(entry, keep, targets)));
    for (const outcome of outcomes) {
      if (outcome.released) released++;
      if (outcome.closed) closed++;
      if (outcome.dropped) changed = true;
    }
  }

  if (changed) await persistEpochs();
  return { released, closed };
}

export const releaseTabs: Tool = async (args) => {
  // `keep`: the disconnecting client asked for its tabs to be left open (the
  // one-shot `exec` client). It can only make this release MORE conservative.
  return { data: await releaseEntries(parseReleaseEntries(args.tabs), args.keep === true) };
};

const BOOT_KEY = 'sallyport_daemon_boot';
const STRANDED_KEY = 'sallyport_stranded_tabs';

/** Release every agent tab a DEAD daemon left behind.
 *
 * `_release_tabs` is sent by a live daemon when one of its clients disconnects.
 * A daemon that itself went away — crashed, killed, `doctor --stop-broker`
 * before an upgrade — sends nothing, and its ownership registry (process
 * memory) goes with it: every tab its sessions created stays open, attached and
 * kept awake, yet no session of the next daemon can ever name one
 * (`tab_not_owned`), and the reaper will not take them either, since nothing
 * marked them orphaned.
 *
 * So the daemon names its process in the `hello_ack` (`boot`), and when that
 * differs from the one this browser session last saw, every agent tab that
 * exists AT THAT MOMENT is released exactly as a disconnect would release it:
 * closed by default, handed back if the human engaged with it or asked to keep
 * tabs. The candidates are snapshotted synchronously, before the first await,
 * so a tab the NEW daemon creates right after its ack is never among them.
 *
 * The candidate list is WRITTEN DOWN together with the new boot id (one
 * `storage.session` write) and erased only when the release has run: a worker
 * evicted in between would otherwise remember the new daemon and forget the
 * tabs, leaving them unowned AND un-orphaned for good. The next ack from the
 * same daemon picks the list up. Re-deriving it then would be wrong — by that
 * time it could contain the new daemon's own tabs.
 *
 * Deliberately inert when there is nothing to compare: no `boot` (an older
 * daemon), or no remembered one (first ack of this browser session, or the
 * first after this extension version was installed — the tabs then may well
 * belong to live sessions of the very daemon that is answering). The remembered
 * id lives in `chrome.storage.session`, the lifetime the epoch map has.
 *
 * The epoch each tab is released under is the one WE minted, read in the same
 * synchronous snapshot — there is no daemon record to compare against, and a
 * tab whose epoch changed meanwhile (closed, id recycled by a new create) fails
 * the epoch comparison and is left alone. Never throws. */
export async function releaseStrandedTabs(boot: string | undefined): Promise<number> {
  if (!boot) return 0;
  const candidates: ReleaseEntry[] = agentTabInfo()
    .filter((t) => !t.orphaned)
    .map((t) => ({ tabId: t.tabId, epoch: t.epoch }));
  try {
    const got = (await chrome.storage.session.get([BOOT_KEY, STRANDED_KEY])) as Record<
      string,
      unknown
    >;
    const previous = got[BOOT_KEY];
    let pending: ReleaseEntry[];
    if (previous === boot) {
      // Same daemon. Normally nothing to do — unless an earlier pass for it was
      // cut short.
      pending = parseReleaseEntries(got[STRANDED_KEY]);
    } else {
      pending = typeof previous === 'string' ? candidates : [];
      await chrome.storage.session.set({ [BOOT_KEY]: boot, [STRANDED_KEY]: pending });
    }
    if (pending.length === 0) return 0;
    const live = pending.filter((c) => getEpoch(c.tabId) === c.epoch);
    const { released } = await releaseEntries(live);
    await chrome.storage.session.remove(STRANDED_KEY);
    return released;
  } catch {
    return 0; // storage unavailable — housekeeping never breaks a connect
  }
}
