/** `history_go` — move a tab back/forward through its own session history.
 *
 * Closes a navigation gap: after following a link an agent often has no way
 * back — the previous page's URL is gone from its context, so it re-derives
 * it or gets stuck. The browser already remembers; this walks that memory.
 *
 * Trust shape: structured CDP only. `Page.getNavigationHistory` names the
 * TARGET entry's URL **before** anything moves, so the same destination
 * allowlist check `navigate` applies to an explicit URL runs here against the
 * history entry (invariant #3) — going "back" can't become a side door to a
 * non-allowlisted page that happens to sit in the tab's history. The jump is
 * `Page.navigateToHistoryEntry` (a fixed protocol command, no `evaluate`),
 * intermediate entries never load, and the current page is gated too (like
 * `reload`) since an in-place navigation destroys it.
 *
 * The planning (bounds + destination gate) is pure (`planHistoryHop`) so
 * vitest drives it directly; the thin CDP wiring follows `navigate`'s shape —
 * waitForLoad, ref invalidation (#7), broker epoch echo, embedded waitFor.
 */

import { matchAllowlist } from '../allowlist.js';
import { getAllowlist } from '../storage.js';
import { attach, cdp } from './cdp.js';
import { BridgeError } from './errors.js';
import { hostnameOf } from './gates.js';
import { getEpoch, isBrokerMode } from './ownership.js';
import { parseWaitFor, runEmbeddedWait } from './poll.js';
import { clearRefsForTab } from './refs.js';
import { resolveTab, waitForLoad } from './tabs.js';
import type { Tool } from './types.js';

export type HistoryDirection = 'back' | 'forward';

export interface HistoryEntry {
  id: number;
  url: string;
}

export function parseHistoryDirection(raw: unknown): HistoryDirection {
  if (raw !== 'back' && raw !== 'forward') {
    throw new BridgeError('bad_args', "history_go: direction must be 'back' or 'forward'");
  }
  return raw;
}

/** `steps` — how many history entries to hop over in one jump (default 1).
 * No upper cap: the range check in `planHistoryHop` bounds it against the
 * tab's actual history (Chrome keeps ~50 entries), so an arbitrary constant
 * here would only duplicate that. Pure. */
export function parseHistorySteps(raw: unknown): number {
  if (raw === undefined || raw === null) return 1;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new BridgeError('bad_args', 'history_go: steps must be a positive integer');
  }
  return n;
}

/** Pick the target history entry for a hop, or fail with a stable code:
 *  - `no_history`          the tab's history doesn't reach that far in that
 *                          direction (how far it DOES reach is in the message)
 *  - `domain_not_allowed`  the target entry's URL isn't allowlisted — the
 *                          destination gate `navigate` applies, applied to
 *                          where "back"/"forward" actually lands
 * Only the LANDING entry is checked: `Page.navigateToHistoryEntry` jumps
 * straight to it, intermediate entries never load. Pure (the allowlist check
 * is injected). */
export function planHistoryHop(
  entries: HistoryEntry[],
  currentIndex: number,
  direction: HistoryDirection,
  steps: number,
  isAllowed: (url: string) => boolean,
): HistoryEntry {
  const available = direction === 'back' ? currentIndex : entries.length - 1 - currentIndex;
  if (steps > available) {
    throw new BridgeError(
      'no_history',
      `history_go: cannot go ${direction} ${steps} — ` +
        (available > 0
          ? `only ${available} ${available === 1 ? 'entry' : 'entries'} that way`
          : `this tab has nothing ${direction === 'back' ? 'behind' : 'ahead of'} it`),
    );
  }
  const target = entries[direction === 'back' ? currentIndex - steps : currentIndex + steps];
  if (!isAllowed(target.url)) {
    throw new BridgeError(
      'domain_not_allowed',
      `history_go: ${direction} ${steps} lands on ${hostnameOf(target.url)}, ` +
        `which is not in the allowlist`,
    );
  }
  return target;
}

interface NavigationHistory {
  currentIndex: number;
  entries: Array<{ id: number; url: string }>;
}

export const historyGo: Tool = async (args) => {
  const direction = parseHistoryDirection(args.direction);
  const steps = parseHistorySteps(args.steps);
  const waitSpec = parseWaitFor(args.waitFor, 'history_go');
  const tab = await resolveTab(args);
  // Gate the page being LEFT like reload/navigate do: an in-place navigation
  // destroys the current page, so a non-allowlisted one is refused. The
  // destination gate lives in planHistoryHop.
  const list = await getAllowlist();
  if (!matchAllowlist(tab.url ?? '', list).matched) {
    throw new BridgeError(
      'domain_not_allowed',
      `${hostnameOf(tab.url ?? '')} is not in the allowlist`,
    );
  }
  await attach(tab.id!);
  const hist = await cdp<NavigationHistory>(tab.id!, 'Page.getNavigationHistory');
  const isAllowed = (url: string): boolean => matchAllowlist(url, list).matched;
  const target = planHistoryHop(
    Array.isArray(hist.entries) ? hist.entries : [],
    hist.currentIndex,
    direction,
    steps,
    isAllowed,
  );
  await cdp(tab.id!, 'Page.navigateToHistoryEntry', { entryId: target.id });
  await waitForLoad(tab.id!);
  // Navigation invalidates any refs we held for this tab.
  clearRefsForTab(tab.id!);
  // Broker epoch: an in-place move on an existing owned tab — echo, never mint
  // (mirrors navigate's non-created branch).
  const epoch = isBrokerMode() ? getEpoch(tab.id!) : undefined;
  let wait = null;
  if (waitSpec) {
    wait = await runEmbeddedWait(tab.id!, waitSpec);
  }
  return {
    tabId: tab.id,
    url: target.url,
    data: {
      tabId: tab.id,
      url: target.url,
      direction,
      steps,
      ...(epoch ? { epoch } : {}),
      ...(wait ? { wait } : {}),
    },
  };
};
