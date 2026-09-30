import { attach } from './cdp.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { minSettleTimeoutMs, parseTimeoutMs, settleFor } from './poll.js';
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

/** Wait until the DOM stops changing for `stableMs` (no observed child, text or
 * attribute mutations in the top-level document), capped at `timeoutMs`.
 * The quiescence probe is a fixed literal, so no allowEvaluate is needed. */
export const settle: Tool = async (args) => {
  const stableMs = parseStableMs(args.stableMs);
  const need = minSettleTimeoutMs(stableMs);
  let timeoutMs = parseTimeoutMs(args.timeoutMs, 'settle');
  if (timeoutMs < need) {
    // Given explicitly, too short is the caller's contradiction: say so rather
    // than run out the clock and call a static page busy. Defaulted, it is ours
    // to fix (stableMs 10000 against the 10000 default).
    if (args.timeoutMs !== undefined) {
      throw new BridgeError(
        'bad_args',
        `settle: timeoutMs ${timeoutMs} cannot fit a ${stableMs} ms quiet window — ` +
          `use timeoutMs >= ${need} or a smaller stableMs`,
      );
    }
    timeoutMs = need;
  }
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  const seen: { url?: string } = {};
  const out = await settleFor(tab.id!, { stableMs, timeoutMs }, seen);
  return { tabId: tab.id, url: seen.url ?? tab.url, data: out };
};
