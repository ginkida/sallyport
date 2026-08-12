/** Turning a caller's `selector` — a CSS selector or an `@eN` ref — into a live
 * page objectId, with the two failures that actually happen classified.
 *
 * Its own module rather than a corner of `dom.ts` for the same reason `poll.ts`
 * exists: `snapshot.ts` needs it, and anything `dom.ts` imports must therefore
 * not reach back through `snapshot.ts`. Keeping the resolver at the bottom of
 * the graph is what lets `observe.ts` (which builds a snapshot) be imported by
 * the action tools without a cycle.
 */

import { cdp, looksLikeMissingNodeError, looksLikeSelectorSyntaxError } from './cdp.js';
import { BridgeError, invalidSelectorError, staleRefError } from './errors.js';
import { getRef, isRef } from './refs.js';

/** Resolve a browser-owned backendNodeId to a live page objectId.
 *
 * Split out of `resolveSelectorOrRef` for callers that have PINNED a node up
 * front and can no longer go through the ref map — `reveal`, whose own loop
 * re-snapshots on every pass and therefore renumbers the tab's refs out from
 * under the container it was handed. A backendNodeId is the browser's own
 * identity for the node and survives that. `label` is only for the error text. */
export async function resolveBackendNode(
  tabId: number,
  backendNodeId: number,
  label: string,
  tool: string,
): Promise<string> {
  let resolved: { object: { objectId?: string } };
  try {
    resolved = await cdp<{ object: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
      backendNodeId,
    });
  } catch (e) {
    if (looksLikeMissingNodeError(e)) throw staleRefError(tool, label);
    throw e;
  }
  if (!resolved.object.objectId) {
    throw new BridgeError('bad_ref', `${tool}: could not resolve ref to DOM`);
  }
  return resolved.object.objectId;
}

export async function resolveSelectorOrRef(
  tabId: number,
  selector: string,
  tool: string,
): Promise<string> {
  if (isRef(selector)) {
    const r = getRef(tabId, selector);
    if (!r) {
      throw new BridgeError(
        'bad_ref',
        `${tool}: unknown ref "${selector}" for tab ${tabId} — run snapshot first`,
      );
    }
    return resolveBackendNode(tabId, r.backendDOMNodeId, selector, tool);
  }
  const doc = await cdp<{ root: { nodeId: number } }>(tabId, 'DOM.getDocument', { depth: 0 });
  let q: { nodeId: number };
  try {
    q = await cdp<{ nodeId: number }>(tabId, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector,
    });
  } catch (e) {
    if (looksLikeSelectorSyntaxError(e)) throw invalidSelectorError(tool, selector);
    throw e;
  }
  if (!q.nodeId) {
    throw new BridgeError('not_found', `${tool}: element not found: ${selector}`);
  }
  const resolved = await cdp<{ object: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
    nodeId: q.nodeId,
  });
  if (!resolved.object.objectId) {
    throw new BridgeError('not_found', `${tool}: could not resolve element`);
  }
  return resolved.object.objectId;
}
