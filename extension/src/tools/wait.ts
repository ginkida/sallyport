import { attach, cdp } from './cdp.js';
import { READ_TEXT_FN } from './dom.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { getRef, isRef } from './refs.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

const POLL_MS = 250;
const DEFAULT_TIMEOUT_MS = 10_000;
// Capped well under the daemon's 60 s request timeout so a wait can never
// turn into an opaque wire timeout.
const MAX_TIMEOUT_MS = 30_000;

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
        `wait_for: unknown ref "${selector}" for tab ${tabId} — run snapshot first`,
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

/** Wait until a selector is visible and/or the page text contains a
 * substring — the built-in replacement for blind sleeps between actions.
 * A timeout is NOT an error: returns {found:false, elapsedMs} so the agent
 * can decide what to do next without an isError round. */
export const waitFor: Tool = async (args) => {
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : null;
  const text = typeof args.text === 'string' && args.text !== '' ? args.text : null;
  if (!selector && !text) {
    throw new BridgeError('bad_args', 'wait_for: selector and/or text required');
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (args.timeoutMs !== undefined) {
    const t = Number(args.timeoutMs);
    if (!Number.isFinite(t) || t < 0) {
      throw new BridgeError('bad_args', 'wait_for: timeoutMs must be a non-negative number');
    }
    timeoutMs = Math.min(t, MAX_TIMEOUT_MS);
  }

  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);

  const start = Date.now();
  for (;;) {
    // Both conditions given → both must hold (AND).
    const selOk = selector === null || (await selectorVisible(tab.id!, selector));
    const textOk = !selOk || text === null || (await textPresent(tab.id!, text));
    const elapsedMs = Date.now() - start;
    if (selOk && textOk) {
      return { tabId: tab.id, url: tab.url, data: { found: true, elapsedMs } };
    }
    if (elapsedMs + POLL_MS > timeoutMs) {
      return { tabId: tab.id, url: tab.url, data: { found: false, elapsedMs, timeoutMs } };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
};
