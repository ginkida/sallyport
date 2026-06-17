import { collectInteractive } from './axtree.js';
import { attach, cdp } from './cdp.js';
import { resolveSelectorOrRef } from './dom.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { matchElements, parsePredicate } from './match.js';
import {
  parseMaxSteps,
  parseTimeoutMs,
  SCROLL_STEP_PROBE,
  scrollStalled,
  settleFor,
} from './poll.js';
import { buildSnapshotTree } from './snapshot.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

// After each scroll, let the virtualiser render the new window before the next
// snapshot — an adaptive settle (cheaper than a fixed sleep), itself capped so
// a never-quiescing feed can't stall the loop.
const STEP_STABLE_MS = 350;
const STEP_SETTLE_TIMEOUT_MS = 1500;

/** Scroll a virtualised container and re-snapshot until a target element
 * appears (gets an @eN), so off-screen list items become actionable.
 * Terminates on: found, stall (container stopped scrolling — reached the end),
 * max_steps, or timeout. The scroll probe is a fixed literal with the direction
 * as a structured argument, so reveal needs no allowEvaluate. NOTE: this
 * scrolls the page (a side effect), within mouse_click's precedent. */
export const reveal: Tool = async (args) => {
  const pred = parsePredicate(args, 'reveal');
  const container =
    typeof args.container === 'string' && args.container !== '' ? args.container : null;
  if (!container) {
    throw new BridgeError('bad_args', 'reveal: container (CSS selector or @eN) is required');
  }
  const direction = args.direction === 'up' ? -1 : 1;
  const mode = args.mode === 'a11y' || args.mode === 'dom' ? args.mode : 'auto';
  const maxSteps = parseMaxSteps(args.maxSteps);
  const timeoutMs = parseTimeoutMs(args.timeoutMs, 'reveal');

  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);

  const start = Date.now();
  let prevAfter: number | null = null;
  for (let step = 0; step <= maxSteps; step++) {
    // Snapshot + match first, so step 0 catches an already-visible target and
    // the refs returned are from the final (matching) snapshot.
    const { tree, source } = await buildSnapshotTree(tab.id!, mode);
    const matches = matchElements(collectInteractive(tree), pred);
    if (matches.length) {
      return { tabId: tab.id, url: tab.url, data: { found: true, matches, steps: step, source } };
    }
    if (step === maxSteps) {
      return {
        tabId: tab.id,
        url: tab.url,
        data: { found: false, reason: 'max_steps', steps: step },
      };
    }
    // Stop before a scroll+settle that would overshoot the budget (kept well
    // under the daemon's 60 s request timeout).
    if (Date.now() - start + STEP_SETTLE_TIMEOUT_MS > timeoutMs) {
      return {
        tabId: tab.id,
        url: tab.url,
        data: { found: false, reason: 'timeout', steps: step },
      };
    }
    // Re-resolve the container each pass — virtualised lists recycle nodes, so
    // a held objectId can go stale. A CSS selector re-queries fresh; a missing
    // container surfaces as a real error (bad_ref/not_found), not a silent miss.
    const objectId = await resolveSelectorOrRef(tab.id!, container, 'reveal');
    const scrollRes = await cdp<{ result: { value?: { before: number; after: number } } }>(
      tab.id!,
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: SCROLL_STEP_PROBE,
        arguments: [{ value: direction }],
        returnByValue: true,
      },
    );
    const sc = scrollRes.result.value ?? { before: 0, after: 0 };
    if (scrollStalled(sc, prevAfter)) {
      // scrollTop didn't move (or bounced back) — we've hit the end.
      return { tabId: tab.id, url: tab.url, data: { found: false, reason: 'stall', steps: step } };
    }
    prevAfter = sc.after;
    await settleFor(tab.id!, { stableMs: STEP_STABLE_MS, timeoutMs: STEP_SETTLE_TIMEOUT_MS });
  }
  // The loop always returns; this satisfies the type checker.
  return {
    tabId: tab.id,
    url: tab.url,
    data: { found: false, reason: 'max_steps', steps: maxSteps },
  };
};
