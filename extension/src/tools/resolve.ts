/** Turning a caller's `selector` — a CSS selector or an `@eN` ref — into a live
 * page objectId, with the two failures that actually happen classified.
 *
 * Its own module rather than a corner of `dom.ts` for the same reason `poll.ts`
 * exists: `snapshot.ts` needs it, and anything `dom.ts` imports must therefore
 * not reach back through `snapshot.ts`. Keeping the resolver at the bottom of
 * the graph is what lets `observe.ts` (which builds a snapshot) be imported by
 * the action tools without a cycle.
 */

import { CALL_GROUP, cdp, looksLikeMissingNodeError, looksLikeSelectorSyntaxError } from './cdp.js';
import { BridgeError, invalidSelectorError, navigatedRefError, staleRefError } from './errors.js';
import { getRef, isRef } from './refs.js';

/** The tab's current main-frame loader id: which DOCUMENT the tab shows.
 *
 * A ref is stamped with this at mint time and checked against it at every
 * resolve (`refDocumentIsCurrent`), because a backendNodeId alone does not name
 * a node across a navigation the page starts itself: a cross-process navigation
 * restarts the browser's node numbering, so an old id lands on a live node of
 * the new document. The loader id changes with every cross-document navigation
 * (same process or not) and NOT with `pushState`, so SPA routing keeps its refs.
 * `Page.getFrameTree` needs no `Page.enable` (the opt-in footprint stays opt-in)
 * and is browser-answered — no page script can shape it.
 *
 * `null` when the browser's answer carries no usable id. A rejection is NOT
 * caught: callers decide whether that fails the call (a resolve does) or just
 * mints refs that will never resolve (a snapshot). */
export async function mainFrameLoaderId(tabId: number): Promise<string | null> {
  const r = await cdp<{ frameTree?: { frame?: { loaderId?: unknown } } }>(
    tabId,
    'Page.getFrameTree',
  );
  const id = r?.frameTree?.frame?.loaderId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** The mint-time read: the same answer, but a browser that will not say yields
 * `null` instead of failing the snapshot — those refs then simply never resolve
 * (fail-closed at USE, where the agent gets `bad_ref` and a re-snapshot hint). */
export async function mintLoaderId(tabId: number): Promise<string | null> {
  try {
    return await mainFrameLoaderId(tabId);
  } catch {
    return null;
  }
}

/** Is the tab still showing the document a ref was minted in?
 *
 * Call it AFTER the step that turned the ref's backendNodeId into something
 * (an objectId, a box model, a description) and BEFORE acting on it: if that
 * step reached the new document, the loader id read here is the new one too —
 * a loader id never goes back to an old value, except when the back/forward
 * cache restores that very document, and then the old ids honestly name its
 * nodes again. The one residue is an A→B→(bfcache)A round trip between the two
 * CDP calls, documented in SECURITY.md.
 *
 * `false` for a ref stamped `null`. Throws when the browser will not answer
 * (fail-closed: no answer is never "same document"). */
export async function refDocumentIsCurrent(
  tabId: number,
  loaderId: string | null,
): Promise<boolean> {
  if (loaderId === null) return false;
  const now = await mainFrameLoaderId(tabId);
  return now !== null && now === loaderId;
}

/** `refDocumentIsCurrent` as a gate: throws `bad_ref` on a mismatch. */
export async function assertRefDocument(
  tabId: number,
  loaderId: string | null,
  label: string,
  tool: string,
): Promise<void> {
  if (!(await refDocumentIsCurrent(tabId, loaderId))) throw navigatedRefError(tool, label);
}

/** Resolve a browser-owned backendNodeId to a live page objectId.
 *
 * Split out of `resolveSelectorOrRef` for callers that have PINNED a node up
 * front and can no longer go through the ref map — `reveal`, whose own loop
 * re-snapshots on every pass and therefore renumbers the tab's refs out from
 * under the container it was handed. A backendNodeId is the browser's own
 * identity for the node and survives that — within ONE document, which is why
 * the caller also hands over the loader id the ref was minted under and the
 * resolved object is refused unless the tab still shows that document.
 * `label` is only for the error text. */
export async function resolveBackendNode(
  tabId: number,
  backendNodeId: number,
  loaderId: string | null,
  label: string,
  tool: string,
): Promise<string> {
  let resolved: { object: { objectId?: string } };
  try {
    resolved = await cdp<{ object: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
      backendNodeId,
      objectGroup: CALL_GROUP,
    });
  } catch (e) {
    if (looksLikeMissingNodeError(e)) throw staleRefError(tool, label);
    throw e;
  }
  if (!resolved.object.objectId) {
    throw new BridgeError('bad_ref', `${tool}: could not resolve ref to DOM`);
  }
  // AFTER the resolve, BEFORE anyone acts on the object (see refDocumentIsCurrent).
  await assertRefDocument(tabId, loaderId, label, tool);
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
    return resolveBackendNode(tabId, r.backendDOMNodeId, r.loaderId, selector, tool);
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
    objectGroup: CALL_GROUP,
  });
  if (!resolved.object.objectId) {
    throw new BridgeError('not_found', `${tool}: could not resolve element`);
  }
  return resolved.object.objectId;
}
