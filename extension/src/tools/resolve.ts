/** Turning a caller's `selector` — a CSS selector or an `@eN` ref — into a live
 * page objectId, with the two failures that actually happen classified.
 *
 * Its own module rather than a corner of `dom.ts` for the same reason `poll.ts`
 * exists: `snapshot.ts` needs it, and anything `dom.ts` imports must therefore
 * not reach back through `snapshot.ts`. Keeping the resolver at the bottom of
 * the graph is what lets `observe.ts` (which builds a snapshot) be imported by
 * the action tools without a cycle.
 */

import { budgetLeft, raceDeadline } from './budget.js';
import {
  CALL_GROUP,
  cdp,
  looksLikeLostContextError,
  looksLikeMissingNodeError,
  looksLikeSelectorSyntaxError,
} from './cdp.js';
import {
  BridgeError,
  invalidSelectorError,
  navigatedRefError,
  staleRefError,
  unverifiedRefError,
} from './errors.js';
import { getRef, isRef } from './refs.js';

/** How long the ref gate waits for the tab to say which document it shows.
 *
 * `Page.getFrameTree` is answered by the RENDERER (Blink's InspectorPageAgent),
 * so a busy or hung page leaves it pending — and an unbounded gate would hold
 * the tab's call queue until the daemon gives up. Past this (or past what the
 * call has left, if less) the answer is UNKNOWN: never "same document". */
export const REF_DOCUMENT_DEADLINE_MS = 3_000;

/** Where a ref stands against the document the tab shows now.
 * `current` = minted in this document; `navigated` = minted in another one (the
 * page moved on); `unknown` = could not tell — the ref carries no stamp, or the
 * browser did not answer in time / lost the context mid-question. `unknown` is
 * never proof of anything: an action refuses it (`unverifiedRefError`), a wait
 * treats the tick as unread, `get_state` says so. */
export type RefDocument = 'current' | 'navigated' | 'unknown';

class DocumentQueryTimeout extends Error {}

/** The tab's current main-frame loader id: which DOCUMENT the tab shows.
 *
 * A ref is stamped with this at mint time and checked against it at every
 * resolve (`refDocumentState`), because a backendNodeId alone does not name
 * a node across a navigation the page starts itself: a cross-process navigation
 * restarts the browser's node numbering, so an old id lands on a live node of
 * the new document. The loader id changes with every cross-document navigation
 * (same process or not) and NOT with `pushState`, so SPA routing keeps its refs.
 * `Page.getFrameTree` needs no `Page.enable` (the opt-in footprint stays opt-in)
 * and is answered from Blink's own frame/loader state (InspectorPageAgent —
 * renderer-side, but not page JavaScript), so no page script can shape it.
 * Being renderer-answered, it is bounded: `REF_DOCUMENT_DEADLINE_MS`, or what
 * the call has left (`startedAt`), whichever is less.
 *
 * `null` = UNKNOWN: the answer carried no usable id, the deadline passed, or
 * the question lost its context mid-flight (a navigation committing). Any other
 * rejection — a detached debugger, a closed target — is NOT caught: those end
 * the call anyway, and saying so beats a wait that polls "unknown" until it
 * times out. */
export async function mainFrameLoaderId(tabId: number, startedAt?: number): Promise<string | null> {
  const ms = Math.min(REF_DOCUMENT_DEADLINE_MS, budgetLeft(startedAt, Date.now()));
  if (ms <= 0) return null;
  let r: { frameTree?: { frame?: { loaderId?: unknown } } };
  try {
    r = await raceDeadline(
      cdp<{ frameTree?: { frame?: { loaderId?: unknown } } }>(tabId, 'Page.getFrameTree'),
      ms,
      () => new DocumentQueryTimeout(),
    );
  } catch (e) {
    if (e instanceof DocumentQueryTimeout || looksLikeLostContextError(e)) return null;
    throw e;
  }
  const id = r?.frameTree?.frame?.loaderId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** The mint-time read: the same answer, but a browser that will not say yields
 * `null` instead of failing the snapshot — those refs then carry no stamp, and
 * every later use of them is `unknown` (an action refuses them with `bad_ref`
 * and a re-snapshot hint). */
export async function mintLoaderId(tabId: number, startedAt?: number): Promise<string | null> {
  try {
    return await mainFrameLoaderId(tabId, startedAt);
  } catch {
    return null;
  }
}

/** Pure: a ref's stamp against the tab's current loader id (`null` = the tab
 * would not say). Exported so a caller that asks the tab ONCE for several refs
 * (`get_state`'s batch) classifies each of them the same way. */
export function classifyRefDocument(stamp: string | null, now: string | null): RefDocument {
  if (stamp === null || now === null) return 'unknown';
  return stamp === now ? 'current' : 'navigated';
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
 * A ref stamped `null` is `unknown` without asking. */
export async function refDocumentState(
  tabId: number,
  stamp: string | null,
  startedAt?: number,
): Promise<RefDocument> {
  if (stamp === null) return 'unknown';
  return classifyRefDocument(stamp, await mainFrameLoaderId(tabId, startedAt));
}

/** `refDocumentState` as a gate for something about to ACT on (or read off)
 * the node: only `current` passes. `navigated` is the navigated-ref `bad_ref`;
 * `unknown` fails closed too — not knowing which document a node belongs to is
 * never licence to touch it. */
export async function assertRefDocument(
  tabId: number,
  stamp: string | null,
  label: string,
  tool: string,
  startedAt?: number,
): Promise<void> {
  const state = await refDocumentState(tabId, stamp, startedAt);
  if (state === 'navigated') throw navigatedRefError(tool, label);
  if (state === 'unknown') throw unverifiedRefError(tool, label);
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
  startedAt?: number,
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
  // AFTER the resolve, BEFORE anyone acts on the object (see refDocumentState).
  await assertRefDocument(tabId, loaderId, label, tool, startedAt);
  return resolved.object.objectId;
}

export async function resolveSelectorOrRef(
  tabId: number,
  selector: string,
  tool: string,
  startedAt?: number,
): Promise<string> {
  if (isRef(selector)) {
    const r = getRef(tabId, selector);
    if (!r) {
      throw new BridgeError(
        'bad_ref',
        `${tool}: unknown ref "${selector}" for tab ${tabId} — run snapshot first`,
      );
    }
    return resolveBackendNode(tabId, r.backendDOMNodeId, r.loaderId, selector, tool, startedAt);
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
