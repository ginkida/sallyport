/** Shared waiting machinery.
 *
 * `wait_for` (the standalone tool in wait.ts) and the embedded `waitFor`
 * parameter on action tools (navigate/click/mouse_click/fill) poll the same
 * conditions: a selector/@eN being present-and-visible, and/or the page's
 * visible text containing a substring — optionally inverted (`absent`).
 * Living here keeps the two from drifting apart and breaks the would-be
 * import cycle dom.ts ↔ wait.ts (this module imports neither).
 */

import {
  cdp,
  looksLikeLostContextError,
  looksLikeMissingNodeError,
  looksLikeSelectorSyntaxError,
} from './cdp.js';
import { BridgeError, invalidSelectorError, navigatedRefError, staleRefError } from './errors.js';
import { ensureStillAllowed } from './gates.js';
import { getRef, isRef } from './refs.js';
import { refDocumentState } from './resolve.js';
import { budgetLeft, OBSERVE_RESERVE_MS } from './budget.js';
import { CREATE_QUIESCENCE_PROBE, OBSERVE_ELEMENT_FN } from './quiescence.js';

const POLL_MS = 250;
const DEFAULT_TIMEOUT_MS = 10_000;
// Capped well under the daemon's 60 s request timeout so a wait can never
// turn into an opaque wire timeout. An embedded wait after a slow action is
// clamped further, to what the call has left (budget.ts, budgetWaitSpec).
const MAX_TIMEOUT_MS = 30_000;

export type WaitSpec = {
  selector: string | null;
  text: string | null;
  timeoutMs: number;
  absent: boolean;
};

// Why a wait ended unsatisfied — present only on the not-found path, so the
// agent can branch instead of collapsing very different situations into
// one identical {found:false}: 'timeout' (the condition was simply not true
// yet — retrying longer may help), 'bad_ref' (a stale @eN after a re-render —
// re-snapshot), 'invalid_selector' (a malformed CSS selector the agent itself
// typed — a PERMANENT error, retrying never helps), 'domain_not_allowed' (the
// page navigated off the allowlist WHILE waiting — the wait stopped rather than
// keep reading it, and the answer is about where the tab went, not about the
// condition), 'error' (anything else).
export type WaitReason =
  'invalid_selector' | 'bad_ref' | 'timeout' | 'domain_not_allowed' | 'not_loaded' | 'error';

export type WaitOutcome = {
  found: boolean;
  elapsedMs: number;
  timeoutMs?: number;
  error?: string;
  reason?: WaitReason;
  /** The wait got less than the timeoutMs asked for: the action before it
   * (a slow page load) had spent that much of the call's budget. */
  budgetLimited?: true;
};

/** Clamp an embedded wait to what the call has left (budget.ts), minus the
 * observe reserve when an observation follows it. Pure. */
export function budgetWaitSpec(
  spec: WaitSpec,
  startedAt: number | undefined,
  now: number,
  observing = false,
): { spec: WaitSpec; limited: boolean } {
  const left = budgetLeft(startedAt, now, observing ? OBSERVE_RESERVE_MS : 0);
  if (spec.timeoutMs <= left) return { spec, limited: false };
  return { spec: { ...spec, timeoutMs: left }, limited: true };
}

/** Classify a thrown wait error into a stable WaitReason. The embedded waitFor
 * FOLDS errors into the outcome (the action it followed already succeeded, so a
 * wait blow-up must stay non-fatal) — without this, a typo'd CSS selector
 * (permanent) and a not-yet-present element (retryable) both surfaced as the
 * same {found:false}. Pure, so the mapping is unit-testable without chrome.
 *
 * selectorVisibility throws BridgeError('bad_ref') on a stale @eN and
 * invalidSelectorError on malformed CSS; other CDP rejections that mention the
 * selector / query (text waits, older paths) still read as invalid_selector.
 * Conservative: only a clear selector-query rejection becomes 'invalid_selector',
 * everything unrecognised stays the generic 'error'. */
export function classifyWaitError(e: unknown): Exclude<WaitReason, 'timeout'> {
  if (e instanceof BridgeError && e.code === 'bad_ref') return 'bad_ref';
  // The page left the allowlist mid-wait. Folded like any other wait failure
  // (the action it followed still happened), but named — "the tab is somewhere
  // it should not be" is a different instruction to the agent than "not yet".
  if (e instanceof BridgeError && e.code === 'domain_not_allowed') return 'domain_not_allowed';
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

/** `unknown` = no trustworthy reading this tick (the probe threw in the page,
 * returned nonsense, a navigation took its document away, or an `@eN`'s
 * document could not be confirmed — `resolve.ts:refDocumentState`). A present-wait
 * keeps waiting on it, and so must an absent-wait: absence was not shown.
 * `navigated` = an `@eN` from a document the tab no longer shows: its node is
 * gone for an absent-wait, and a `bad_ref` for a present one — whatever its old
 * id resolves to now is a node of the NEW page (refs.ts `loaderId`). */
export type SelectorVisibility = 'visible' | 'hidden' | 'unknown' | 'destroyed' | 'navigated';

/** Page-side half of a CSS-selector wait, over EVERY match: is any of them laid
 * out? Only `{visible, total}` leaves the page — no node, text or attribute.
 * Scanning in the page is what makes "every match" affordable: the CDP route
 * (`DOM.querySelectorAll`) pushes every match's path to the frontend, i.e. most
 * of a large document at 4 Hz for a selector like `a`. Self-contained: it is
 * serialised as SELECTOR_VISIBILITY_FN and called on the document with the
 * selector as a STRUCTURED argument, never interpolated — the trust shape of
 * get_state's ELEMENT_STATE_FN, so no allowEvaluate. A rect with area is the
 * same test `DOM.getBoxModel` answered for one node: display:none, detached and
 * zero-size all read as not visible. */
export function anyMatchVisible(
  root: { querySelectorAll: (s: string) => ArrayLike<{ getBoundingClientRect: () => DOMRect }> },
  selector: string,
): { visible: boolean; total: number } | { invalid: true } {
  let list;
  try {
    list = root.querySelectorAll(selector);
  } catch (e) {
    // Only a SYNTAX error is the caller's selector; anything else (a page that
    // wrapped or broke querySelectorAll) rethrows and reads as no reading. The
    // browser throws a DOMException NAMED SyntaxError, not a SyntaxError.
    if (e && (e as { name?: unknown }).name === 'SyntaxError') return { invalid: true };
    throw e;
  }
  for (let i = 0; i < list.length; i++) {
    const r = list[i].getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return { visible: true, total: list.length };
  }
  return { visible: false, total: list.length };
}

export const SELECTOR_VISIBILITY_FN =
  'function(selector) { return (' + anyMatchVisible.toString() + ')(this, selector); }';

const WAIT_GROUP = 'sallyport-wait';

async function nodeVisibility(
  tabId: number,
  params: Record<string, unknown>,
): Promise<SelectorVisibility> {
  try {
    const box = await cdp<{ model?: { width: number; height: number } }>(
      tabId,
      'DOM.getBoxModel',
      params,
    );
    return box.model && box.model.width > 0 && box.model.height > 0 ? 'visible' : 'hidden';
  } catch (e) {
    // "Could not compute box model" (display:none, detached-but-alive) is
    // hidden — keep waiting. A node the page DESTROYED is not going to come
    // back, and `ensureRefStillExists` only checked once, before the loop.
    return looksLikeMissingNodeError(e) ? 'destroyed' : 'hidden';
  }
}

/** Is the selector / @eN ref present AND laid out?
 *
 * A CSS selector is judged over EVERY match, not the first: with one `.spinner`
 * per widget hidden by a class as each finishes, the first match going
 * `display:none` used to answer "gone" while the rest still spun — a false
 * success — and a hidden mobile copy ahead of the visible desktop one made a
 * present-wait time out. A malformed selector fails at once as `bad_args`
 * (named `invalid_selector` in an embedded wait), never a silent timeout.
 *
 * An `@eN` names one node, and is checked browser-side (`DOM.getBoxModel`). */
async function selectorVisibility(tabId: number, selector: string): Promise<SelectorVisibility> {
  if (isRef(selector)) {
    const r = getRef(tabId, selector);
    if (!r) {
      throw new BridgeError(
        'bad_ref',
        `wait: unknown ref "${selector}" for tab ${tabId} — run snapshot first`,
      );
    }
    const v = await nodeVisibility(tabId, { backendNodeId: r.backendDOMNodeId });
    if (v === 'destroyed') return v;
    // AFTER the box-model read (it may have reached the new document), and on
    // EVERY tick: the page can navigate at any point of a 30 s wait. A ref whose
    // document cannot be confirmed (no stamp, no answer in time) is an UNREAD
    // tick, not a navigated one: "navigated" counts as gone under `absent`, and
    // a still-visible node must never be reported gone because we could not tell.
    const doc = await refDocumentState(tabId, r.loaderId);
    if (doc === 'unknown') return 'unknown';
    return doc === 'current' ? v : 'navigated';
  }
  let v: unknown;
  try {
    const doc = await cdp<{ result?: { objectId?: string }; exceptionDetails?: unknown }>(
      tabId,
      'Runtime.evaluate',
      { expression: 'document', objectGroup: WAIT_GROUP },
    );
    if (doc.exceptionDetails || !doc.result?.objectId) return 'unknown';
    const out = await cdp<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      tabId,
      'Runtime.callFunctionOn',
      {
        objectId: doc.result.objectId,
        functionDeclaration: SELECTOR_VISIBILITY_FN,
        arguments: [{ value: selector }],
        returnByValue: true,
      },
    );
    v = out.exceptionDetails ? undefined : out.result?.value;
  } catch (e) {
    // A navigation between the two calls: the next tick reads the new page.
    if (looksLikeLostContextError(e)) return 'unknown';
    throw e;
  }
  // Classified OUTSIDE the catch: the message carries the agent's selector,
  // which must not be able to pass itself off as a lost context.
  if (v && typeof v === 'object' && (v as { invalid?: unknown }).invalid === true) {
    throw invalidSelectorError('wait', selector);
  }
  if (v && typeof v === 'object' && typeof (v as { visible?: unknown }).visible === 'boolean') {
    return (v as { visible: boolean }).visible ? 'visible' : 'hidden';
  }
  return 'unknown';
}

/** Page-side half of a text wait: the body's RENDERED text. `innerText` only —
 * READ_TEXT_FN's `textContent` fallback is right for read_text (a page with no
 * layout still has words to read) and wrong here: before hydration a SPA's
 * body is an empty root plus inline `<script>` state, and "wait for text
 * 'Dashboard'" matched the JSON in that script before anything rendered.
 * Fixed literal, no argument; only the string comes back. */
// And '' for a body that is not RENDERED: per spec innerText of a
// display:none element (an anti-FOUC `<body hidden>` until hydration) IS its
// textContent, script source included. A display:contents body has no boxes of
// its own but its children render, so it still reads.
export const VISIBLE_TEXT_FN =
  'function() {' +
  " if (typeof this.getClientRects === 'function' && this.getClientRects().length === 0) {" +
  '   var w = this.ownerDocument && this.ownerDocument.defaultView;' +
  "   if (!w || w.getComputedStyle(this).display !== 'contents') return '';" +
  ' }' +
  " return this.innerText || ''; }";

/** Does the page's visible text contain `text`? `null` = no reading this tick
 * (a navigation took the document between the two calls): neither present
 * nor, under `absent`, gone. Re-resolves <body> on every poll — SPAs replace
 * it. */
async function textPresent(tabId: number, text: string): Promise<boolean | null> {
  try {
    const body = await cdp<{ result?: { objectId?: string }; exceptionDetails?: unknown }>(
      tabId,
      'Runtime.evaluate',
      { expression: 'document.body', objectGroup: WAIT_GROUP },
    );
    if (body.exceptionDetails) return null;
    if (!body.result?.objectId) return false; // no body yet: no text on the page
    const out = await cdp<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      tabId,
      'Runtime.callFunctionOn',
      { objectId: body.result.objectId, functionDeclaration: VISIBLE_TEXT_FN, returnByValue: true },
    );
    const value = out.exceptionDetails ? undefined : out.result?.value;
    return typeof value === 'string' ? value.includes(text) : null;
  } catch (e) {
    if (looksLikeLostContextError(e)) return null;
    throw e;
  }
}

/** Is the node behind a `@eN` still in the document?
 *
 * `selectorVisibility` cannot tell "destroyed" from "laid out with no box": both
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
    return; // fail-open, as above: the loop's own per-tick check still runs
  }
  // Only a PROVEN other document fails here; `unknown` falls through to the
  // loop like any other unclassified answer (fail-open, as above) — the loop's
  // own per-tick check reads it as an unread tick.
  if ((await refDocumentState(tabId, r.loaderId)) === 'navigated') {
    throw navigatedRefError('wait', ref);
  }
}

/** Poll until the spec holds (AND across given conditions; `absent` inverts
 * both). A timeout is NOT an error: returns {found:false, elapsedMs} so the
 * caller decides what to do next. */
/** `seen.url` is set to the url of the page each tick actually read (the
 * re-gate's answer), so a caller can report where the wait ENDED, not where
 * it began. */
export async function pollFor(
  tabId: number,
  spec: WaitSpec,
  seen?: { url?: string },
): Promise<WaitOutcome> {
  const usesHandles = spec.text !== null || (spec.selector !== null && !isRef(spec.selector));
  if (!usesHandles) return pollLoop(tabId, spec, seen);
  try {
    return await pollLoop(tabId, spec, seen);
  } finally {
    // One `document`/`body` handle per tick, all in this group.
    try {
      await cdp(tabId, 'Runtime.releaseObjectGroup', { objectGroup: WAIT_GROUP });
    } catch {
      // A closed tab or detached debugger has already released its objects.
    }
  }
}

async function pollLoop(
  tabId: number,
  spec: WaitSpec,
  seen?: { url?: string },
): Promise<WaitOutcome> {
  // Only for the PRESENT condition. Under `absent:true` a destroyed node is
  // precisely what is being waited for, and the loop below already reports it
  // as found — turning it into an error there would break the tool.
  if (!spec.absent && spec.selector !== null && isRef(spec.selector)) {
    await ensureRefStillExists(tabId, spec.selector);
  }
  const start = Date.now();
  for (;;) {
    // Re-gate BEFORE every probe. A wait runs for up to 30 s and the page is
    // free to navigate under it — most ordinarily because the click that
    // preceded this wait followed a link off-site. One entry check must not
    // license half a minute of reading whatever the tab drifted onto
    // (invariant #3); `find` already worked this way.
    const url = await ensureStillAllowed(tabId);
    if (seen) seen.url = url;
    let ok: boolean;
    const sel = spec.selector === null ? null : await selectorVisibility(tabId, spec.selector);
    if (spec.absent) {
      // Gone-condition: selector invisible/detached AND text not on page. An
      // unreadable tick (`unknown`, text `null`) is never proof of absence.
      const selGone =
        sel === null || sel === 'hidden' || sel === 'destroyed' || sel === 'navigated';
      const text = !selGone || spec.text === null ? false : await textPresent(tabId, spec.text);
      ok = selGone && text === false;
    } else {
      if (sel === 'destroyed') throw staleRefError('wait', spec.selector!);
      if (sel === 'navigated') throw navigatedRefError('wait', spec.selector!);
      const selOk = sel === null || sel === 'visible';
      // Short-circuit: skip the text probe while the selector is failing.
      ok = selOk && (spec.text === null || (await textPresent(tabId, spec.text)) === true);
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
export async function runEmbeddedWait(
  tabId: number,
  requested: WaitSpec,
  startedAt?: number,
  observing = false,
): Promise<WaitOutcome> {
  const { spec, limited } = budgetWaitSpec(requested, startedAt, Date.now(), observing);
  const began = Date.now();
  let out: WaitOutcome;
  try {
    out = await pollFor(tabId, spec);
  } catch (e) {
    out = {
      found: false,
      // How long it ran before failing — a drift after 20 s of polling is not
      // a wait that ended at once.
      elapsedMs: Date.now() - began,
      error: e instanceof Error ? e.message : String(e),
      reason: classifyWaitError(e),
    };
  }
  return limited ? { ...out, budgetLimited: true } : out;
}

// --- settle: DOM quiescence -------------------------------------------------

/** The shortest timeoutMs in which a settle over `stableMs` CAN succeed: a
 * window of stableMs opened by the first sample, plus one tick for that sample
 * (and a second sample at stableMs 0). Below it a static page runs out the clock and
 * reads as "never quiesced" — a false verdict about the page. Pure. */
export function minSettleTimeoutMs(stableMs: number): number {
  // The window opens at the first sample, a tick in; settleFor waits out a
  // window that closes inside the budget, so latency needs no extra margin.
  return Math.max(stableMs, POLL_MS) + POLL_MS;
}

export type SettleSpec = {
  stableMs: number;
  timeoutMs: number;
  /** objectId of an element to watch instead of the whole document. `settle`
   * never passes one: "the page went quiet" is its whole contract. `reveal`
   * does — between scroll steps it waits for the LIST to render, and a clock
   * ticking in the page header must not cost every step its full budget. */
  root?: string;
};
export type SettleOutcome = {
  settled: boolean;
  elapsedMs: number;
  /** 'budget': the call had too little time left for the quiet window to fit,
   * so nothing was measured — not a verdict that the page is busy. */
  reason?: 'budget';
};

export type Signal = number;
export type SettleState = {
  prev: Signal | null;
  /** When `prev` was sampled — the point the stability window is BACKDATED to,
   * because an unchanged mutation counter proves no observed changes across
   * the interval between samples. */
  prevAt: number | null;
  stableSince: number | null;
};

export const INITIAL_SETTLE_STATE: SettleState = { prev: null, prevAt: null, stableSince: null };

/** Pure per-tick advance of the settle state machine, split out from settleFor
 * so the decision logic is unit-testable without chrome.
 *
 * `sig === null` means the probe produced NO reading this tick — the page-side
 * observer expired or its sample did not return a valid counter. We treat that as
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
  if (prev !== null && sig === prev) {
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

/** Install a fresh per-wait observer — on `root` when given, else on the tab's
 * CURRENT document. `undefined` when there is nothing to observe right now —
 * the page threw during creation (a shadowed `MutationObserver`), or a
 * navigation is mid-commit. The caller treats that as a reading-less tick and
 * simply tries again next tick. */
async function createObserver(
  tabId: number,
  objectGroup: string,
  root: string | undefined,
): Promise<string | undefined> {
  try {
    type Created = { result: { objectId?: string }; exceptionDetails?: unknown };
    const created =
      root === undefined
        ? await cdp<Created>(tabId, 'Runtime.evaluate', {
            expression: CREATE_QUIESCENCE_PROBE,
            objectGroup,
          })
        : await cdp<Created>(tabId, 'Runtime.callFunctionOn', {
            objectId: root,
            functionDeclaration: OBSERVE_ELEMENT_FN,
            objectGroup,
          });
    // A thrown value also comes back WITH an objectId — the exception object's.
    return created.exceptionDetails ? undefined : created.result.objectId;
  } catch (e) {
    if (looksLikeLostContextError(e)) return undefined;
    throw e;
  }
}

/** Wait for a quiet interval in the top-level document's DOM. The observer
 * catches changes between polls, including equal-length edits and changes
 * reverted before the next tick. Every read re-checks the domain allowlist.
 *
 * The observer lives in ONE document: a navigation mid-wait (click → settle on
 * a submit button, a reveal step that loads a page) destroys it along with its
 * execution context, and sampling the dead handle rejects. That is a new page,
 * not a failure — the tick counts as reading-less (restarting the window) and
 * the next tick installs a fresh observer, AFTER that tick's allowlist gate, so
 * the new document is approved before anything is placed in it.
 *
 * A `root` element dies with its document too, and there is no re-resolving it
 * from here — so a scoped wait whose creation fails or whose context is lost
 * falls back to watching the whole (new) document: stricter, never blinder. */
export async function settleFor(
  tabId: number,
  spec: SettleSpec,
  seen?: { url?: string },
): Promise<SettleOutcome> {
  const start = performance.now();
  let state = INITIAL_SETTLE_STATE;
  let objectId: string | undefined;
  let root = spec.root;
  // Per-tab tool serialisation prevents overlapping waits in this group.
  const objectGroup = 'sallyport-settle';
  try {
    for (;;) {
      const url = await ensureStillAllowed(tabId);
      if (seen) seen.url = url;
      if (objectId === undefined) {
        objectId = await createObserver(tabId, objectGroup, root);
        if (objectId === undefined) root = undefined;
      }
      let sig: Signal | null = null;
      if (objectId !== undefined) {
        try {
          const out = await cdp<{ result: { value?: unknown }; exceptionDetails?: unknown }>(
            tabId,
            'Runtime.callFunctionOn',
            {
              objectId,
              functionDeclaration: 'function() { return this.sample(); }',
              returnByValue: true,
            },
          );
          const value = out.exceptionDetails ? undefined : out.result.value;
          if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) sig = value;
          // An expired observer answers null for good: replace it next tick.
          else if (value === null) objectId = undefined;
        } catch (e) {
          if (!looksLikeLostContextError(e)) throw e;
          objectId = undefined; // its document is gone; observe the new one next tick
          root = undefined;
        }
      }
      const now = performance.now();
      const step = advanceSettle(state, sig, now, spec.stableMs);
      state = step.state;
      if (step.settled) return { settled: true, elapsedMs: Math.round(now - start) };
      const elapsedMs = now - start;
      if (elapsedMs + POLL_MS > spec.timeoutMs) {
        // A quiet window already open that closes INSIDE the budget gets its
        // closing sample: the POLL_MS grid plus per-tick latency (tab read,
        // sample round-trip) otherwise let a static page run out the clock a
        // few ms short and read as "never quiesced". Bounded: the window either
        // closes on that sample or a mutation resets it and the next pass exits.
        const closeAt = state.stableSince === null ? null : state.stableSince + spec.stableMs;
        if (closeAt !== null && closeAt <= start + spec.timeoutMs && closeAt > now) {
          await new Promise((r) => setTimeout(r, closeAt - now));
          continue;
        }
        // No live observer on the last tick: the context may have died with a
        // CLOSED tab, not a navigation — the gate says so (tab_gone) instead of
        // an ordinary "never quiesced".
        if (objectId === undefined) await ensureStillAllowed(tabId);
        return { settled: false, elapsedMs: Math.round(elapsedMs) };
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    try {
      if (objectId) {
        await cdp(tabId, 'Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function() { this.stop(); }',
          returnByValue: true,
        });
      }
    } catch {
      // Navigation or detach may already have destroyed the observer.
    }
    try {
      await cdp(tabId, 'Runtime.releaseObjectGroup', { objectGroup });
    } catch {
      // A closed tab or detached debugger has already released its objects.
    }
  }
}

// --- reveal: scroll a virtualised container ---------------------------------

// FIXED literal used by `reveal` to scroll a virtualised container (`this`) by
// ~90% of its viewport. The direction (1 down / -1 up) travels as a STRUCTURED
// callFunctionOn argument, NEVER interpolated into the body — same trust shape
// as the aim probes — so reveal needs no allowEvaluate. Lives here in an
// import-safe module (poll.ts pulls in no chrome at load).
// `scrollTo({behavior:'instant'})`, not a `scrollTop` assignment: the setter
// follows the element's computed `scroll-behavior`, and under `smooth`
// (Bootstrap 5's `:root`, Tailwind's `scroll-smooth`) Chrome ANIMATES — the read
// right after still returns the old offset, so reveal saw after === before and
// answered `stall` on a list it never got to scroll. The assignment stays as the
// fallback — and the VERIFIED one: scrollTo is page-owned, and a legacy
// polyfill or a throwing override must not turn a scroll the native setter
// would have made into a silent non-move.
export const SCROLL_STEP_PROBE =
  'function(dir) { var b = this.scrollTop; var p = this.clientHeight || 0;' +
  ' var t = b + dir * Math.max(1, p * 0.9);' +
  ' var want = Math.min(Math.max(t, 0), Math.max(0, (this.scrollHeight || 0) - p));' +
  " try { if (typeof this.scrollTo === 'function') this.scrollTo({ top: t, behavior: 'instant' }); } catch (e) {}" +
  ' if (!(Math.abs(this.scrollTop - want) <= 1)) this.scrollTop = t;' +
  ' return { before: b, after: this.scrollTop, scrollHeight: this.scrollHeight, clientHeight: p }; }';

/** Did this scroll step leave the container at the edge it is moving toward?
 * That is where an infinite feed fetches its next page — often behind a
 * progress bar OUTSIDE the container, while the container itself sits unchanged
 * until the rows land. `reveal` waits for the whole document on such a step,
 * so a slow fetch is not snapshotted early and misread as `stall`. Unreadable
 * geometry counts as an edge: document-wide is the stricter wait, never the
 * blinder one. Pure. */
export function atScrollEdge(
  sc: { after: number; scrollHeight?: unknown; clientHeight?: unknown },
  dir: number,
): boolean {
  if (dir < 0) return sc.after <= 0;
  const { scrollHeight, clientHeight } = sc;
  if (typeof scrollHeight !== 'number' || typeof clientHeight !== 'number') return true;
  // scrollTop is fractional under zoom; a pixel of slack absorbs the rounding.
  return sc.after + clientHeight >= scrollHeight - 1;
}

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
  // `behavior: 'instant'` so the reported position is the settled one: a page
  // with `scroll-behavior: smooth` would otherwise animate past our read.
  "function() { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });" +
  ' var w = this.ownerDocument && this.ownerDocument.defaultView;' +
  ' return { x: w ? w.scrollX : 0, y: w ? w.scrollY : 0 }; }';

// Scroll `this` (a container element or the page's scrollingElement) by a
// structured delta, or jump to top/bottom when `to` is set. `dx`/`dy`/`to` are
// callFunctionOn arguments, NEVER interpolated. Returns the resulting position
// plus scrollHeight/clientHeight so the caller can tell whether it bottomed out
// (lazy-load termination) without a second probe.
// Instant for the same reason as SCROLL_STEP_PROBE: under `scroll-behavior:
// smooth` an assignment animates, and the position read back was the old one.
export const SCROLL_BY_PROBE =
  'function(dx, dy, to) {' +
  ' var top, left;' +
  " if (to === 'top') { top = 0; left = 0; }" +
  " else if (to === 'bottom') { top = this.scrollHeight; left = this.scrollLeft; }" +
  ' else { top = this.scrollTop + dy; left = this.scrollLeft + dx; }' +
  ' var want = Math.min(Math.max(top, 0), Math.max(0, this.scrollHeight - this.clientHeight));' +
  ' var ok = false;' +
  " try { if (typeof this.scrollTo === 'function') { this.scrollTo({ top: top, left: left, behavior: 'instant' }); ok = true; } } catch (e) {}" +
  ' if (!ok || !(Math.abs(this.scrollTop - want) <= 1)) { this.scrollTop = top; this.scrollLeft = left; }' +
  ' return { x: this.scrollLeft, y: this.scrollTop,' +
  ' scrollHeight: this.scrollHeight, clientHeight: this.clientHeight }; }';

// Read-only: where `this` is now, and how tall. `scroll` re-reads after its
// embedded wait — a feed that grew while the wait watched it is not at the
// bottom any more, whatever the position said a moment before.
export const SCROLL_GEOMETRY_PROBE =
  'function() { return { x: this.scrollLeft, y: this.scrollTop,' +
  ' scrollHeight: this.scrollHeight, clientHeight: this.clientHeight }; }';
