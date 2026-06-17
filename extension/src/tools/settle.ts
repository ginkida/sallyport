import { attach } from './cdp.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { parseTimeoutMs, settleFor } from './poll.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

const DEFAULT_STABLE_MS = 500;
const MAX_STABLE_MS = 10_000;

function parseStableMs(raw: unknown): number {
  if (raw === undefined) return DEFAULT_STABLE_MS;
  const t = Number(raw);
  if (!Number.isFinite(t) || t < 0) {
    throw new BridgeError('bad_args', 'settle: stableMs must be a non-negative number');
  }
  return Math.min(t, MAX_STABLE_MS);
}

/** Wait until the DOM stops changing for `stableMs` (element count and body
 * size both steady), capped at `timeoutMs`. Structured CDP only — the
 * quiescence probe is a fixed literal — so no allowEvaluate needed. */
export const settle: Tool = async (args) => {
  const stableMs = parseStableMs(args.stableMs);
  const timeoutMs = parseTimeoutMs(args.timeoutMs, 'settle');
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  const out = await settleFor(tab.id!, { stableMs, timeoutMs });
  return { tabId: tab.id, url: tab.url, data: out };
};
