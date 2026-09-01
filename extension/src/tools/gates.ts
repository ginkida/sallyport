import { matchAllowlist } from '../allowlist.js';
import { getAllowlist, type AllowEntry } from '../storage.js';
import { BridgeError } from './errors.js';
import { getTabOrGone } from './tab-resolve.js';

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** `list`, if given, is used instead of re-fetching — for a caller (like
 * `history_go`) that already needs the allowlist for a SECOND check right
 * after (e.g. a destination gate) and would otherwise pay two
 * `chrome.storage.local` round-trips for one call. Omit it for the common
 * case: fetches internally, identical to before. */
export async function ensureAllowed(url: string | undefined, list?: AllowEntry[]): Promise<void> {
  if (!url) throw new BridgeError('no_url', 'tab has no URL');
  const entries = list ?? (await getAllowlist());
  const res = matchAllowlist(url, entries);
  if (!res.matched) {
    throw new BridgeError('domain_not_allowed', `${hostnameOf(url)} is not in the allowlist`);
  }
}

export async function ensureEvaluateAllowed(url: string | undefined): Promise<void> {
  if (!url) throw new BridgeError('no_url', 'tab has no URL');
  const list = await getAllowlist();
  const res = matchAllowlist(url, list);
  if (!res.matched) {
    throw new BridgeError('domain_not_allowed', `${hostnameOf(url)} is not in the allowlist`);
  }
  if (!res.entry?.allowEvaluate) {
    throw new BridgeError(
      'evaluate_not_allowed',
      `evaluate is not enabled for ${hostnameOf(url)} — enable in the popup`,
    );
  }
}

/** Re-check the allowlist against the page a LONG-RUNNING LOOP is about to read
 * again, and answer with the url it actually found there.
 *
 * The entry check every tool does answers "may I touch this page" once. A loop
 * that keeps reading for up to 30 seconds — `wait_for`/every embedded `waitFor`
 * (poll.ts), `settle`, `reveal`, `find` — is asking that question repeatedly,
 * and the page is free to move under it in between: an SSO bounce, a consent
 * wall, a shortener, a meta-refresh, or simply the click that started the wait
 * following a link off-site. Without this, one entry check licensed every
 * subsequent read of whatever the tab drifted onto, which is exactly the shape
 * invariant #3 exists to prevent. `find` had it; the others were reading on the
 * strength of a check that was minutes stale by then.
 *
 * Deliberately the same fail-closed shape as the entry gate — a drifted page
 * raises `domain_not_allowed` and the loop stops rather than reporting a result
 * from a page nobody approved. A vanished tab raises `tab_gone` (`getTabOrGone`)
 * instead of the raw "No tab with id".
 *
 * Costs one `chrome.tabs.get` + one allowlist read per tick. That is the price
 * `find` has always paid; a loop cheap enough to run four times a second is
 * cheap enough to ask permission four times a second. */
export async function ensureStillAllowed(tabId: number): Promise<string | undefined> {
  const tab = await getTabOrGone(tabId);
  await ensureAllowed(tab.url);
  return tab.url;
}
