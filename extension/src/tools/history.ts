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
 * `reload`, via the shared `ensureAllowed`) since an in-place navigation
 * destroys it.
 *
 * The `domain_not_allowed`/`no_history` failures deliberately do NOT echo the
 * blocked entry's hostname: `history_go`'s `tabId`-less standalone fallback
 * (`resolveTab`) can target the human's active tab, and naming a
 * non-allowlisted history entry would turn a probe over `steps` into a
 * hostname oracle over the human's browsing history — the same
 * oracle-avoidance stance `tab_not_owned` already takes for tab identity.
 *
 * The planning (bounds + destination gate) is pure (`planHistoryHop`) so
 * vitest drives it directly; the thin CDP wiring follows `navigate`'s shape —
 * waitForLoad, ref invalidation (#7), broker epoch echo, embedded waitFor.
 */

import { matchAllowlist } from '../allowlist.js';
import { getAllowlist } from '../storage.js';
import { attach, cdp } from './cdp.js';
import { clearArmedDialog } from './dialog-capture.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { getEpoch, isBrokerMode } from './ownership.js';
import { parseWaitFor, runEmbeddedWait } from './poll.js';
import { clearRefsForTab } from './refs.js';
import { getTabOrGone, resolveTab, waitForLoad } from './tabs.js';
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
 *  - `error`               `Page.getNavigationHistory` returned something
 *                          this tab can't sensibly index (a malformed/empty
 *                          response) — a boundary check on an external CDP
 *                          answer, not a scenario our own code can produce
 *  - `no_history`          the tab's history doesn't reach that far in that
 *                          direction (how far it DOES reach is in the message)
 *  - `domain_not_allowed`  the target entry's URL isn't allowlisted — the
 *                          destination gate `navigate` applies, applied to
 *                          where "back"/"forward" actually lands. The
 *                          hostname is deliberately NOT echoed (see the
 *                          module doc's oracle-avoidance note).
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
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= entries.length) {
    throw new BridgeError('error', "history_go: couldn't read the tab's navigation history");
  }
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
      `history_go: ${direction} ${steps} lands on a page whose domain is not in the allowlist`,
    );
  }
  return target;
}

interface NavigationHistory {
  currentIndex: number;
  entries: Array<{ id: number; url: string }>;
}

/** Close the CDP/tabs-API race after `Page.navigateToHistoryEntry`: unlike
 * `chrome.tabs.update` (whose call commits into the tabs API before its own
 * callback fires), a CDP-issued navigation's completion isn't synchronized
 * with the tabs API's `Tab` object — the very next `chrome.tabs.get` can still
 * read the OLD url/status, which would make `waitForLoad`'s fast path resolve
 * immediately against the page we just left. Poll (briefly) until the tab's
 * url changes or its status leaves 'complete', whichever comes first. A
 * same-document hop (SPA `pushState`-style history) may never flip status at
 * all — the url check alone still catches it. If NEITHER changes within the
 * short bound, the navigation had already caught up before we started polling
 * (e.g. hopping to the entry the tab is already showing) — proceed either
 * way, `waitForLoad` still runs its own check afterward. */
function waitForHistoryTransition(
  tabId: number,
  beforeUrl: string,
  timeoutMs = 2000,
): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime?.lastError || !tab) {
          resolve(); // vanished — let waitForLoad's own tab_gone guard handle it
          return;
        }
        if (tab.url !== beforeUrl || tab.status !== 'complete' || Date.now() >= deadline) {
          resolve();
          return;
        }
        setTimeout(poll, 50);
      });
    };
    poll();
  });
}

export const historyGo: Tool = async (args) => {
  const direction = parseHistoryDirection(args.direction);
  const steps = parseHistorySteps(args.steps);
  const waitSpec = parseWaitFor(args.waitFor, 'history_go');
  const tab = await resolveTab(args);
  // One allowlist fetch, reused for both the leaving-page gate and the
  // destination check below (matching navigate's single-fetch shape).
  const list = await getAllowlist();
  // Gate the page being LEFT like reload does: an in-place navigation
  // destroys the current page, so a non-allowlisted one is refused. The
  // destination gate lives in planHistoryHop.
  await ensureAllowed(tab.url, list);
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
  const beforeUrl = tab.url ?? '';
  await cdp(tab.id!, 'Page.navigateToHistoryEntry', { entryId: target.id });
  await waitForHistoryTransition(tab.id!, beforeUrl);
  await waitForLoad(tab.id!, 'history_go');
  // The hop can be CANCELLED without either of the above noticing: a
  // beforeunload prompt that gets dismissed (handle_dialog's own default
  // policy, or a human clicking Cancel) leaves the tab exactly where it
  // started — url/status never change, so waitForHistoryTransition's
  // "nothing moved ⇒ already there" fast path and waitForLoad's "already
  // complete" fast path both read as success. Verify against `beforeUrl`
  // (did we leave AT ALL), not an exact match to `target.url` — attaching
  // CDP disables the back/forward cache, so a hop here is always a live
  // network navigation and CAN legitimately redirect (session-gated pages
  // bouncing to /login, http→https or www-normalizing redirects, …); an
  // exact-match check would misreport a genuinely successful hop as
  // cancelled. If the tab moved at all, trust it and report where it
  // ACTUALLY landed (getTabOrGone: the tab could vanish in this exact
  // window, e.g. a same-origin bounce that closes itself).
  const landed = await getTabOrGone(tab.id!);
  if (landed.url === beforeUrl) {
    throw new BridgeError(
      'navigation_cancelled',
      `history_go: the ${direction} ${steps} hop did not complete — the tab is ` +
        `still on its previous page (a beforeunload prompt may have kept it there); ` +
        `check with read_text/snapshot before retrying`,
    );
  }
  const landedUrl = landed.url ?? target.url;
  // Navigation invalidates any refs we held for this tab, and any pending
  // dialog arm (see the identical note in navigate).
  clearRefsForTab(tab.id!);
  clearArmedDialog(tab.id!);
  // Broker epoch: an in-place move on an existing owned tab — echo, never mint
  // (mirrors navigate's non-created branch).
  const epoch = isBrokerMode() ? getEpoch(tab.id!) : undefined;
  let wait = null;
  if (waitSpec) {
    wait = await runEmbeddedWait(tab.id!, waitSpec);
  }
  return {
    tabId: tab.id,
    url: landedUrl,
    data: {
      tabId: tab.id,
      url: landedUrl,
      direction,
      steps,
      ...(epoch ? { epoch } : {}),
      ...(wait ? { wait } : {}),
    },
  };
};
