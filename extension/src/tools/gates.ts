import { matchAllowlist } from '../allowlist.js';
import { getAllowlist } from '../storage.js';
import { BridgeError } from './errors.js';

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export async function ensureAllowed(url: string | undefined): Promise<void> {
  if (!url) throw new BridgeError('no_url', 'tab has no URL');
  const list = await getAllowlist();
  const res = matchAllowlist(url, list);
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
