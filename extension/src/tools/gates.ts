import { matchAllowlist } from '../allowlist.js';
import { getAllowlist, type AllowEntry } from '../storage.js';
import { BridgeError } from './errors.js';

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
