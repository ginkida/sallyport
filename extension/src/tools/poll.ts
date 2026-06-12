/** Shared waiting machinery.
 *
 * `wait_for` (the standalone tool in wait.ts) and the embedded `waitFor`
 * parameter on action tools (navigate/click/mouse_click/fill) poll the same
 * conditions: a selector/@eN being present-and-visible, and/or the page's
 * visible text containing a substring — optionally inverted (`absent`).
 * Living here keeps the two from drifting apart and breaks the would-be
 * import cycle dom.ts ↔ wait.ts (this module imports neither).
 */

import { cdp } from './cdp.js';
import { BridgeError } from './errors.js';
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

export type WaitOutcome = {
  found: boolean;
  elapsedMs: number;
  timeoutMs?: number;
  error?: string;
};

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

/** Poll until the spec holds (AND across given conditions; `absent` inverts
 * both). A timeout is NOT an error: returns {found:false, elapsedMs} so the
 * caller decides what to do next. */
export async function pollFor(tabId: number, spec: WaitSpec): Promise<WaitOutcome> {
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
      return { found: false, elapsedMs, timeoutMs: spec.timeoutMs };
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
    return { found: false, elapsedMs: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
