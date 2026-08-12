/** `scroll` — deterministic, predicate-less scrolling.
 *
 * `reveal` scrolls a container only while hunting a target predicate and stops
 * the moment it matches — it can't "just page down N times to trigger a
 * lazy-load / infinite-scroll feed" or "bring this element into view". That gap
 * was the common reason an agent reached for `evaluate`. `scroll` fills it with
 * structured CDP only:
 *  - into-view mode: scrollIntoView({block:'center'}) on a selector/@eN;
 *  - by/to mode: scroll the page (or a `selector` container) by a dx/dy delta,
 *    or jump to top/bottom.
 *
 * Security: allowlist-gated (#3); the page work runs through FIXED probe
 * literals (SCROLL_INTO_VIEW_PROBE / SCROLL_BY_PROBE in poll.ts) with the deltas
 * and the `to` keyword carried as STRUCTURED callFunctionOn arguments, never
 * interpolated — the blessed SCROLL_STEP_PROBE shape — so no evaluate flag.
 * Scrolling never resets the @eN ref space (#7 untouched).
 */

import { attach, cdp } from './cdp.js';
import { resolveSelectorOrRef } from './resolve.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { parseObserve, runObserve } from './observe.js';
import { parseWaitFor, runEmbeddedWait, SCROLL_BY_PROBE, SCROLL_INTO_VIEW_PROBE } from './poll.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

// Pages aren't a million CSS px tall; a delta beyond this is a mistake, not a
// real scroll. Bound it so an absurd value can't reach the wire.
const MAX_SCROLL_DELTA = 1_000_000;

/** Parse one scroll delta. Unlike mouse_click's parseCoord this ALLOWS
 * negatives (scroll up / left); it only rejects NaN/±Infinity and out-of-bound
 * magnitudes. Pure, so the negative-allowed contract is unit-testable. */
export function parseScrollDelta(raw: unknown, name: string): number {
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    throw new BridgeError('bad_args', `scroll: ${name} must be a finite number`);
  }
  if (Math.abs(v) > MAX_SCROLL_DELTA) {
    throw new BridgeError(
      'bad_args',
      `scroll: ${name} magnitude too large (max ${MAX_SCROLL_DELTA})`,
    );
  }
  return v;
}

export type ScrollSpec =
  | { kind: 'into_view'; selector: string }
  | { kind: 'by'; selector: string | null; dx: number; dy: number; to: 'top' | 'bottom' | null };

/** Decide which scroll the args describe, validating as we go. `to` is checked
 * against a FIXED extension-side allowlist here (never baked into the probe by
 * interpolation). Pure, so the mode-selection + rejections are unit-testable. */
export function parseScrollSpec(args: Record<string, unknown>): ScrollSpec {
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : null;
  const hasTo = args.to !== undefined && args.to !== null;
  const hasDx = args.dx !== undefined && args.dx !== null;
  const hasDy = args.dy !== undefined && args.dy !== null;

  if (!hasTo && !hasDx && !hasDy) {
    // into-view: needs an element to bring into view.
    if (!selector) {
      throw new BridgeError(
        'bad_args',
        'scroll: give selector (to bring into view) or dx/dy/to (to scroll the page/container)',
      );
    }
    return { kind: 'into_view', selector };
  }

  if (hasTo) {
    if (args.to !== 'top' && args.to !== 'bottom') {
      throw new BridgeError('bad_args', "scroll: to must be 'top' or 'bottom'");
    }
    if (hasDx || hasDy) {
      throw new BridgeError('bad_args', 'scroll: pass either to or dx/dy, not both');
    }
    return { kind: 'by', selector, dx: 0, dy: 0, to: args.to };
  }

  return {
    kind: 'by',
    selector,
    dx: hasDx ? parseScrollDelta(args.dx, 'dx') : 0,
    dy: hasDy ? parseScrollDelta(args.dy, 'dy') : 0,
    to: null,
  };
}

type ScrollByResult = { x: number; y: number; scrollHeight: number; clientHeight: number };

export const scroll: Tool = async (args) => {
  const spec = parseScrollSpec(args);
  // Lazy-load harvesting is scroll → wait-for-new-content → read, repeated. The
  // embedded wait folds the middle step in, halving the calls per screenful.
  const waitSpec = parseWaitFor(args.waitFor, 'scroll');
  const observeSpec = parseObserve(args.observe, 'scroll');
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  const tabId = tab.id!;

  if (spec.kind === 'into_view') {
    const objectId = await resolveSelectorOrRef(tabId, spec.selector, 'scroll');
    const out = await cdp<{ result: { value?: { x: number; y: number } } }>(
      tabId,
      'Runtime.callFunctionOn',
      { objectId, functionDeclaration: SCROLL_INTO_VIEW_PROBE, returnByValue: true },
    );
    const v = out.result.value ?? { x: 0, y: 0 };
    const intoViewWait = waitSpec ? await runEmbeddedWait(tabId, waitSpec) : null;
    const intoViewObserved = observeSpec ? await runObserve(tabId, observeSpec) : null;
    return {
      tabId,
      url: tab.url,
      data: {
        ok: true,
        mode: 'into_view',
        x: Math.round(v.x),
        y: Math.round(v.y),
        ...(intoViewWait ? { wait: intoViewWait } : {}),
        ...(intoViewObserved ? { observed: intoViewObserved } : {}),
      },
    };
  }

  // by/to: scroll the named container, or the page's scrolling element. The
  // `document.scrollingElement …` expression is a FIXED literal (same shape as
  // mouse_click's `Runtime.evaluate{expression:'document'}`), no interpolation.
  let objectId: string;
  if (spec.selector) {
    objectId = await resolveSelectorOrRef(tabId, spec.selector, 'scroll');
  } else {
    const ev = await cdp<{ result: { objectId?: string } }>(tabId, 'Runtime.evaluate', {
      expression: 'document.scrollingElement || document.documentElement || document.body',
    });
    if (!ev.result.objectId) {
      throw new BridgeError('not_found', 'scroll: page has no scrolling element');
    }
    objectId = ev.result.objectId;
  }

  const out = await cdp<{ result: { value?: ScrollByResult } }>(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: SCROLL_BY_PROBE,
    arguments: [{ value: spec.dx }, { value: spec.dy }, { value: spec.to }],
    returnByValue: true,
  });
  const v = out.result.value ?? { x: 0, y: 0, scrollHeight: 0, clientHeight: 0 };
  // Whether we bottomed out — the signal a lazy-load loop needs to stop.
  const atBottom = v.y + v.clientHeight >= v.scrollHeight - 1;
  const wait = waitSpec ? await runEmbeddedWait(tabId, waitSpec) : null;
  const observed = observeSpec ? await runObserve(tabId, observeSpec) : null;
  return {
    tabId,
    url: tab.url,
    data: {
      ok: true,
      mode: spec.to ?? 'by',
      x: Math.round(v.x),
      y: Math.round(v.y),
      scrollHeight: Math.round(v.scrollHeight),
      atBottom,
      ...(wait ? { wait } : {}),
      ...(observed ? { observed } : {}),
    },
  };
};
