/** Shared waiting machinery.
 *
 * `wait_for` (the standalone tool in wait.ts) and the embedded `waitFor`
 * parameter on action tools (navigate/click/mouse_click/fill) poll the same
 * conditions: a selector/@eN being present-and-visible, and/or the page's
 * visible text containing a substring — optionally inverted (`absent`).
 * Living here keeps the two from drifting apart and breaks the would-be
 * import cycle dom.ts ↔ wait.ts (this module imports neither).
 */

import { cdp, looksLikeMissingNodeError, looksLikeSelectorSyntaxError } from './cdp.js';
import { BridgeError, staleRefError } from './errors.js';
import { getRef, isRef } from './refs.js';

const POLL_MS = 250;
const DEFAULT_TIMEOUT_MS = 10_000;
// Capped well under the daemon's 60 s request timeout so a wait can never
// turn into an opaque wire timeout. Mind the budget when combining an
// embedded wait with a slow action.
const MAX_TIMEOUT_MS = 30_000;

// Trimmed innerText preferred; fall back to textContent (hidden-but-present
// nodes). Pinned as a const so read_text's two branches and the text-wait
// probe can't drift apart. FIXED literal.
export const READ_TEXT_FN =
  'function() { return (this.innerText || this.textContent || "").trim(); }';

export type WaitSpec = {
  selector: string | null;
  text: string | null;
  timeoutMs: number;
  absent: boolean;
};

// Why a wait ended unsatisfied — present only on the not-found path, so the
// agent can branch instead of collapsing three very different situations into
// one identical {found:false}: 'timeout' (the condition was simply not true
// yet — retrying longer may help), 'bad_ref' (a stale @eN after a re-render —
// re-snapshot), 'invalid_selector' (a malformed CSS selector the agent itself
// typed — a PERMANENT error, retrying never helps), 'error' (anything else).
export type WaitReason = 'invalid_selector' | 'bad_ref' | 'timeout' | 'error';

export type WaitOutcome = {
  found: boolean;
  elapsedMs: number;
  timeoutMs?: number;
  error?: string;
  reason?: WaitReason;
};

/** Classify a thrown wait error into a stable WaitReason. The embedded waitFor
 * FOLDS errors into the outcome (the action it followed already succeeded, so a
 * wait blow-up must stay non-fatal) — without this, a typo'd CSS selector
 * (permanent) and a not-yet-present element (retryable) both surfaced as the
 * same {found:false}. Pure, so the mapping is unit-testable without chrome.
 *
 * selectorVisible throws BridgeError('bad_ref') on a stale @eN; DOM.querySelector
 * rejects on malformed CSS with a raw CDP error mentioning the selector / query.
 * Conservative: only a clear selector-query rejection becomes 'invalid_selector',
 * everything unrecognised stays the generic 'error'. */
export function classifyWaitError(e: unknown): Exclude<WaitReason, 'timeout'> {
  if (e instanceof BridgeError && e.code === 'bad_ref') return 'bad_ref';
  if (looksLikeSelectorSyntaxError(e)) return 'invalid_selector';
  return 'error';
}

export function parseTimeoutMs(raw: unknown, tool: string): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const t = Number(raw);
  if (!Number.isFinite(t) || t < 0) {
    throw new BridgeError('bad_args', `${tool}: timeoutMs must be a non-negative number`);
  }
  return Math.min(t, MAX_TIMEOUT_MS);
}

/** Parse the embedded `waitFor` argument of action tools. Returns null when
 * absent; throws `bad_args` on a malformed shape so typos fail loudly
 * instead of silently skipping the wait. */
export function parseWaitFor(raw: unknown, tool: string): WaitSpec | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BridgeError(
      'bad_args',
      `${tool}: waitFor must be an object {selector?, text?, timeoutMs?, absent?}`,
    );
  }
  const o = raw as Record<string, unknown>;
  const selector = typeof o.selector === 'string' && o.selector !== '' ? o.selector : null;
  const text = typeof o.text === 'string' && o.text !== '' ? o.text : null;
  if (!selector && !text) {
    throw new BridgeError('bad_args', `${tool}: waitFor needs selector and/or text`);
  }
  return {
    selector,
    text,
    timeoutMs: parseTimeoutMs(o.timeoutMs, tool),
    absent: o.absent === true,
  };
}

/** Is the selector / @eN ref present AND laid out (has a box model)?
 * Structured CDP only — DOM.querySelector + DOM.getBoxModel, no page JS.
 * An invalid CSS selector makes DOM.querySelector reject, which surfaces
 * immediately as a tool error instead of a silent timeout. */
async function selectorVisible(tabId: number, selector: string): Promise<boolean> {
  const params: Record<string, unknown> = {};
  if (isRef(selector)) {
    const r = getRef(tabId, selector);
    if (!r) {
      throw new BridgeError(
        'bad_ref',
        `wait: unknown ref "${selector}" for tab ${tabId} — run snapshot first`,
      );
    }
    params.backendNodeId = r.backendDOMNodeId;
  } else {
    const doc = await cdp<{ root: { nodeId: number } }>(tabId, 'DOM.getDocument', { depth: 0 });
    const q = await cdp<{ nodeId: number }>(tabId, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector,
    });
    if (!q.nodeId) return false;
    params.nodeId = q.nodeId;
  }
  try {
    const box = await cdp<{ model?: { width: number; height: number } }>(
      tabId,
      'DOM.getBoxModel',
      params,
    );
    return !!box.model && box.model.width > 0 && box.model.height > 0;
  } catch {
    return false; // no box model — display:none / detached; keep waiting
  }
}

/** Does the page's visible text contain `text`? Re-resolves <body> on every
 * poll — SPAs replace it. Fixed probe function, same as read_text. */
async function textPresent(tabId: number, text: string): Promise<boolean> {
  const doc = await cdp<{ root: { nodeId: number } }>(tabId, 'DOM.getDocument', { depth: 0 });
  const q = await cdp<{ nodeId: number }>(tabId, 'DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: 'body',
  });
  if (!q.nodeId) return false;
  const resolved = await cdp<{ object: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
    nodeId: q.nodeId,
  });
  if (!resolved.object.objectId) return false;
  const out = await cdp<{ result: { value?: string } }>(tabId, 'Runtime.callFunctionOn', {
    objectId: resolved.object.objectId,
    functionDeclaration: READ_TEXT_FN,
    returnByValue: true,
  });
  return (out.result.value ?? '').includes(text);
}

/** Is the node behind a `@eN` still in the document?
 *
 * `selectorVisible` cannot tell "destroyed" from "laid out with no box": both
 * end in the `catch { return false }` that means keep waiting. For a node the
 * page has DESTROYED that is a lie the agent pays for twice — the wait burns its
 * whole budget (up to the 30 s cap) and then reports `reason:'timeout'`, whose
 * documented meaning is "retrying longer may help". One `DOM.describeNode`
 * before the loop settles it: a detached-but-alive node still describes fine, so
 * a genuine wait-for-it-to-render is untouched.
 *
 * Fail-OPEN on anything else: an unrecognised rejection falls through to the
 * poll loop exactly as before, rather than being relabelled a stale ref. */
async function ensureRefStillExists(tabId: number, ref: string): Promise<void> {
  const r = getRef(tabId, ref);
  if (!r) {
    throw new BridgeError(
      'bad_ref',
      `wait: unknown ref "${ref}" for tab ${tabId} — run snapshot first`,
    );
  }
  try {
    await cdp(tabId, 'DOM.describeNode', { backendNodeId: r.backendDOMNodeId });
  } catch (e) {
    if (looksLikeMissingNodeError(e)) throw staleRefError('wait', ref);
  }
}

/** Poll until the spec holds (AND across given conditions; `absent` inverts
 * both). A timeout is NOT an error: returns {found:false, elapsedMs} so the
 * caller decides what to do next. */
export async function pollFor(tabId: number, spec: WaitSpec): Promise<WaitOutcome> {
  // Only for the PRESENT condition. Under `absent:true` a destroyed node is
  // precisely what is being waited for, and the loop below already reports it
  // as found — turning it into an error there would break the tool.
  if (!spec.absent && spec.selector !== null && isRef(spec.selector)) {
    await ensureRefStillExists(tabId, spec.selector);
  }
  const start = Date.now();
  for (;;) {
    let ok: boolean;
    if (spec.absent) {
      // Gone-condition: selector invisible/detached AND text not on page.
      const selGone = spec.selector === null || !(await selectorVisible(tabId, spec.selector));
      const textGone = !selGone || spec.text === null || !(await textPresent(tabId, spec.text));
      ok = selGone && textGone;
    } else {
      const selOk = spec.selector === null || (await selectorVisible(tabId, spec.selector));
      // Short-circuit: skip the text probe while the selector is failing.
      const textOk = !selOk || spec.text === null || (await textPresent(tabId, spec.text));
      ok = selOk && textOk;
    }
    const elapsedMs = Date.now() - start;
    if (ok) return { found: true, elapsedMs };
    if (elapsedMs + POLL_MS > spec.timeoutMs) {
      return { found: false, elapsedMs, timeoutMs: spec.timeoutMs, reason: 'timeout' };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** Run an embedded wait after a successful action. The action's success must
 * stay visible even when the wait itself blows up (stale ref, invalid CSS),
 * so errors are folded into the outcome instead of thrown. */
export async function runEmbeddedWait(tabId: number, spec: WaitSpec): Promise<WaitOutcome> {
  try {
    return await pollFor(tabId, spec);
  } catch (e) {
    return {
      found: false,
      elapsedMs: 0,
      error: e instanceof Error ? e.message : String(e),
      reason: classifyWaitError(e),
    };
  }
}

// --- settle: DOM quiescence -------------------------------------------------

type QuiescenceDoc = {
  getElementsByTagName: (t: string) => { length: number };
  body: { innerHTML: string } | null;
};

/** Two cheap, side-effect-free quiescence signals sampled each tick:
 * `n` = total element count (catches nodes added/removed — virtualized lists
 * settling, a spinner appearing/vanishing) and `len` = body HTML size (catches
 * in-place text/attribute churn that doesn't change the node count). We read
 * only the `.length`, never the content, so no field value can leak
 * (invariant #5). Pure + self-contained so it serialises cleanly — the same
 * shape as domtree's collectDomTree. */
export function quiescenceSignal(doc: QuiescenceDoc): { n: number; len: number } {
  return {
    n: doc.getElementsByTagName('*').length,
    len: doc.body ? doc.body.innerHTML.length : 0,
  };
}

// FIXED literal — `document` is a fixed reference, NOT agent input — so it
// carries the same trust shape as read_text's body probe / keyboard.ts's
// ACTIVE_FIELD_PROBE and needs no per-domain evaluate flag.
export const QUIESCENCE_PROBE = '(' + quiescenceSignal.toString() + ')(document)';

export type SettleSpec = { stableMs: number; timeoutMs: number };
export type SettleOutcome = { settled: boolean; elapsedMs: number };

export type Signal = { n: number; len: number };
export type SettleState = {
  prev: Signal | null;
  /** When `prev` was sampled — the point the stability window is BACKDATED to,
   * because two equal readings prove the DOM was unchanged across the whole
   * interval between them, not merely at the second one. */
  prevAt: number | null;
  stableSince: number | null;
};

export const INITIAL_SETTLE_STATE: SettleState = { prev: null, prevAt: null, stableSince: null };

/** Pure per-tick advance of the settle state machine, split out from settleFor
 * so the decision logic is unit-testable without chrome.
 *
 * `sig === null` means the probe produced NO reading this tick — Runtime.evaluate
 * returned a value-less result because the page-side eval threw. We treat that as
 * "unknown" and conservatively RESTART the stability window: a reading-less tick
 * must never be mistaken for a steady DOM. (The old code substituted a fixed
 * {n:-1,len:-1} sentinel, so two consecutive failures compared equal and falsely
 * reported settled:true; this is the fix.) settle can therefore only succeed on
 * two genuine, equal readings. */
export function advanceSettle(
  state: SettleState,
  sig: Signal | null,
  now: number,
  stableMs: number,
): { state: SettleState; settled: boolean } {
  if (sig === null) return { state: INITIAL_SETTLE_STATE, settled: false };
  const { prev } = state;
  if (prev && sig.n === prev.n && sig.len === prev.len) {
    // Backdate the window to the EARLIER of the two equal readings. Anchoring it
    // to `now` instead charged every settle one guaranteed extra POLL_MS tick —
    // an already-static page needed three samples (t=0, 250, 500, 750) to prove
    // a 500 ms window it had in fact demonstrated by t=500. Nothing about the
    // strictness changes: two genuinely equal readings are still required, and
    // the `sig === null` restart above still refuses to settle on a blind tick.
    const stableSince = state.stableSince ?? state.prevAt ?? now;
    return {
      state: { prev: sig, prevAt: now, stableSince },
      settled: now - stableSince >= stableMs,
    };
  }
  // changed (or first reading) — (re)start the stability window
  return { state: { prev: sig, prevAt: now, stableSince: null }, settled: false };
}

/** Wait until the DOM stops changing for `stableMs` — the adaptive replacement
 * for a blind sleep after an action on a busy SPA. Polls the two quiescence
 * signals every POLL_MS; declares settled once both hold steady across the
 * stability window. A page that never quiesces (live feed, animation loop) — or
 * whose probe never yields a reading — returns {settled:false} at the cap, NOT
 * an error (mirrors pollFor). */
export async function settleFor(tabId: number, spec: SettleSpec): Promise<SettleOutcome> {
  const start = Date.now();
  let state = INITIAL_SETTLE_STATE;
  for (;;) {
    const out = await cdp<{ result: { value?: Signal } }>(tabId, 'Runtime.evaluate', {
      expression: QUIESCENCE_PROBE,
      returnByValue: true,
    });
    const now = Date.now();
    const step = advanceSettle(state, out.result.value ?? null, now, spec.stableMs);
    state = step.state;
    if (step.settled) return { settled: true, elapsedMs: now - start };
    const elapsedMs = now - start;
    if (elapsedMs + POLL_MS > spec.timeoutMs) return { settled: false, elapsedMs };
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// --- reveal: scroll a virtualised container ---------------------------------

// FIXED literal used by `reveal` to scroll a virtualised container (`this`) by
// ~90% of its viewport. The direction (1 down / -1 up) travels as a STRUCTURED
// callFunctionOn argument, NEVER interpolated into the body — same trust shape
// as the aim probes — so reveal needs no allowEvaluate. Lives here next to
// QUIESCENCE_PROBE so both serialised DOM probes stay in one import-safe module
// (poll.ts pulls in no chrome at load, so they're vitest-testable).
export const SCROLL_STEP_PROBE =
  'function(dir) { var b = this.scrollTop; var p = this.clientHeight || 0;' +
  ' this.scrollTop = b + dir * Math.max(1, p * 0.9);' +
  ' return { before: b, after: this.scrollTop, scrollHeight: this.scrollHeight }; }';

const MAX_STEPS = 40;
const DEFAULT_MAX_STEPS = 20;

/** Parse + validate reveal's `maxSteps` (capped at MAX_STEPS). Pure, so the cap
 * and the rejections are unit-testable without chrome — mirrors parseTimeoutMs. */
export function parseMaxSteps(raw: unknown): number {
  if (raw === undefined) return DEFAULT_MAX_STEPS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new BridgeError('bad_args', 'reveal: maxSteps must be a positive integer');
  }
  return Math.min(n, MAX_STEPS);
}

/** Has the container stopped scrolling? Either scrollTop didn't move this step,
 * or it bounced back to a position we already saw — either way we've reached the
 * end and reveal should stop. Pure, so the stall heuristic is unit-testable. */
export function scrollStalled(
  sc: { before: number; after: number },
  prevAfter: number | null,
): boolean {
  return sc.after === sc.before || sc.after === prevAfter;
}

// --- scroll: standalone deterministic scrolling -----------------------------
// The two probes the `scroll` tool serialises. FIXED literals — no agent input
// is interpolated into the bodies; the scroll-by deltas and the `to` keyword
// travel as STRUCTURED callFunctionOn arguments (same trust shape as
// SCROLL_STEP_PROBE's `dir`), so `scroll` needs no per-domain evaluate flag.
// Living here keeps every serialised DOM probe in one chrome-free, vitest-
// testable module.

// Bring `this` element into the centre of the viewport, then report the page's
// resulting scroll offset (best-effort; falls back to 0 with no defaultView).
export const SCROLL_INTO_VIEW_PROBE =
  "function() { this.scrollIntoView({ block: 'center', inline: 'center' });" +
  ' var w = this.ownerDocument && this.ownerDocument.defaultView;' +
  ' return { x: w ? w.scrollX : 0, y: w ? w.scrollY : 0 }; }';

// Scroll `this` (a container element or the page's scrollingElement) by a
// structured delta, or jump to top/bottom when `to` is set. `dx`/`dy`/`to` are
// callFunctionOn arguments, NEVER interpolated. Returns the resulting position
// plus scrollHeight/clientHeight so the caller can tell whether it bottomed out
// (lazy-load termination) without a second probe.
export const SCROLL_BY_PROBE =
  'function(dx, dy, to) {' +
  " if (to === 'top') { this.scrollTop = 0; this.scrollLeft = 0; }" +
  " else if (to === 'bottom') { this.scrollTop = this.scrollHeight; }" +
  ' else { this.scrollTop = this.scrollTop + dy; this.scrollLeft = this.scrollLeft + dx; }' +
  ' return { x: this.scrollLeft, y: this.scrollTop,' +
  ' scrollHeight: this.scrollHeight, clientHeight: this.clientHeight }; }';
