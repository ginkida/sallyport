import { collectInteractive } from './axtree.js';
import { attach, cdp } from './cdp.js';
import { resolveBackendNode, resolveSelectorOrRef } from './resolve.js';
import { BridgeError } from './errors.js';
import { ensureAllowed, ensureStillAllowed } from './gates.js';
import { matchElements, parsePredicate } from './match.js';
import { getRef, isRef, refWatermark } from './refs.js';
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

  // PIN an @eN container before the loop starts.
  //
  // Refs are monotonic per tab, and this tool re-snapshots on every pass — so by
  // the time the loop resolves the container the ref map has already been wiped
  // and re-minted above the caller's id, and `@e12` would resolve to nothing.
  // (It only ever worked because the counter used to restart at e1 and the walk
  // is deterministic, i.e. by accident.) The backendNodeId is the browser's own
  // identity for that node and is unaffected by our numbering, so read it once
  // while the ref is still live and resolve THAT each pass — which keeps the
  // per-pass re-resolve virtualised lists need.
  const containerBackendNodeId = isRef(container)
    ? (getRef(tab.id!, container)?.backendDOMNodeId ?? null)
    : null;
  if (isRef(container) && containerBackendNodeId === null) {
    throw new BridgeError(
      'bad_ref',
      `reveal: unknown ref "${container}" for tab ${tab.id} — run snapshot first`,
    );
  }
  // One mark for the WHOLE loop: every pass but the last is discarded, and
  // those refs never leave the extension, so they must not push the agent's ids
  // up by up to 40 snapshots' worth.
  const mark = refWatermark(tab.id!);

  const start = Date.now();
  let prevAfter: number | null = null;
  // The url actually read, refreshed each pass. reveal scrolls and re-snapshots
  // up to 40 times, so reporting the url the call STARTED on described a page
  // it may have left several seconds earlier — and wrote that stale url into the
  // audit row (`find` already reports what it read).
  let readUrl = tab.url;
  for (let step = 0; step <= maxSteps; step++) {
    // Re-gate every pass. This loop READS the page — it returns roles and names
    // out of each snapshot — so a page that navigates mid-reveal would be read
    // and reported under an entry check made up to 30 s and forty scrolls ago
    // (invariant #3).
    readUrl = await ensureStillAllowed(tab.id!);
    // Snapshot + match first, so step 0 catches an already-visible target and
    // the refs returned are from the final (matching) snapshot.
    const { tree, source } = await buildSnapshotTree(tab.id!, mode, mark);
    const matches = matchElements(collectInteractive(tree), pred);
    if (matches.length) {
      return { tabId: tab.id, url: readUrl, data: { found: true, matches, steps: step, source } };
    }
    if (step === maxSteps) {
      return {
        tabId: tab.id,
        url: readUrl,
        data: { found: false, reason: 'max_steps', steps: step },
      };
    }
    // Stop before a scroll+settle that would overshoot the budget (kept well
    // under the daemon's 60 s request timeout).
    if (Date.now() - start + STEP_SETTLE_TIMEOUT_MS > timeoutMs) {
      return {
        tabId: tab.id,
        url: readUrl,
        data: { found: false, reason: 'timeout', steps: step },
      };
    }
    // Re-resolve the container each pass — virtualised lists recycle nodes, so
    // a held objectId can go stale. A CSS selector re-queries fresh; a pinned
    // @eN resolves by its browser-owned backendNodeId (see above). A container
    // that has genuinely gone surfaces as a real error (bad_ref/not_found), not
    // a silent miss.
    const objectId =
      containerBackendNodeId !== null
        ? await resolveBackendNode(tab.id!, containerBackendNodeId, container, 'reveal')
        : await resolveSelectorOrRef(tab.id!, container, 'reveal');
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
      return { tabId: tab.id, url: readUrl, data: { found: false, reason: 'stall', steps: step } };
    }
    prevAfter = sc.after;
    await settleFor(tab.id!, { stableMs: STEP_STABLE_MS, timeoutMs: STEP_SETTLE_TIMEOUT_MS });
  }
  // The loop always returns; this satisfies the type checker.
  return {
    tabId: tab.id,
    url: readUrl,
    data: { found: false, reason: 'max_steps', steps: maxSteps },
  };
};
