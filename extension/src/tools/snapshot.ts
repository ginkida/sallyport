import { buildTree, collectInteractive, type AXNode, type TreeNode } from './axtree.js';
import { attach, cdp } from './cdp.js';
import { resolveSelectorOrRef } from './resolve.js';
import { collectDomTree, type DomTreeNode, type DomTreeResult } from './domtree.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { newRef, refWatermark, resetRefsForTab } from './refs.js';
import { resolveTab } from './tab-resolve.js';
import type { Tool } from './types.js';

// The serialised `collectDomTree` (domtree.ts) applied to the page document
// (whole page) or to a resolved element (`snapshot selector=…` — the element
// travels as `this`, never as text). FIXED literals — no agent input is
// interpolated — so they carry the same trust shape as fetch_in_page's fixed
// body / keyboard.ts's ACTIVE_FIELD_PROBE and do not require the per-domain
// evaluate flag.
const DOM_TREE_PROBE = '(' + collectDomTree.toString() + ')(document)';
const DOM_SUBTREE_PROBE =
  'function() { return (' + collectDomTree.toString() + ')(document, this); }';

/** DOM fallback for pages whose accessibility tree is empty (Telegram Web K
 * and friends): run the fixed walker probe, pull the tree by value, then swap
 * each interactive element's `idx` for a per-tab `@eN` ref by resolving the
 * element handle to a backendNodeId (DOM.describeNode) — the same ref space
 * the a11y path uses, so click/fill/read_text work unchanged. */
async function domSnapshot(
  tabId: number,
  rootObjectId?: string,
): Promise<{ tree: TreeNode[]; truncated: boolean }> {
  const GROUP = 'sallyport_snapshot';
  const ev = rootObjectId
    ? await cdp<{
        result: { objectId?: string };
        exceptionDetails?: { text: string; exception?: { description?: string } };
      }>(tabId, 'Runtime.callFunctionOn', {
        objectId: rootObjectId,
        functionDeclaration: DOM_SUBTREE_PROBE,
        objectGroup: GROUP,
      })
    : await cdp<{
        result: { objectId?: string };
        exceptionDetails?: { text: string; exception?: { description?: string } };
      }>(tabId, 'Runtime.evaluate', { expression: DOM_TREE_PROBE, objectGroup: GROUP });
  if (ev.exceptionDetails || !ev.result.objectId) {
    const msg = ev.exceptionDetails?.exception?.description ?? ev.exceptionDetails?.text ?? '';
    throw new BridgeError('snapshot_failed', `snapshot: DOM probe failed ${msg}`.trim());
  }
  try {
    const treeRes = await cdp<{ result: { value?: Omit<DomTreeResult, 'els'> } }>(
      tabId,
      'Runtime.callFunctionOn',
      {
        objectId: ev.result.objectId,
        functionDeclaration:
          'function() { return { tree: this.tree, truncated: this.truncated }; }',
        returnByValue: true,
        objectGroup: GROUP,
      },
    );
    const out = treeRes.result.value;
    if (!out) throw new BridgeError('snapshot_failed', 'snapshot: DOM probe returned nothing');

    const elsRes = await cdp<{ result: { objectId?: string } }>(tabId, 'Runtime.callFunctionOn', {
      objectId: ev.result.objectId,
      functionDeclaration: 'function() { return this.els; }',
      objectGroup: GROUP,
    });
    const elIds = new Map<number, string>();
    if (elsRes.result.objectId) {
      const props = await cdp<{ result: Array<{ name: string; value?: { objectId?: string } }> }>(
        tabId,
        'Runtime.getProperties',
        { objectId: elsRes.result.objectId, ownProperties: true },
      );
      for (const p of props.result) {
        const i = Number(p.name);
        if (Number.isInteger(i) && p.value?.objectId) elIds.set(i, p.value.objectId);
      }
    }

    // Collect first, in DOCUMENT order, then describe, then number. Splitting
    // the three is what makes the middle step safe to parallelise while the
    // ids stay exactly what a sequential walk would have produced.
    const pending: Array<{ node: DomTreeNode; objectId: string }> = [];
    const collect = (nodes: DomTreeNode[]): void => {
      for (const n of nodes) {
        if (n.idx !== undefined) {
          const objectId = elIds.get(n.idx);
          delete n.idx;
          if (objectId) pending.push({ node: n, objectId });
        }
        if (n.children) collect(n.children);
      }
    };
    collect(out.tree);

    // One `DOM.describeNode` per element, and there can be hundreds — a
    // sequential walk spent that many serial round-trips, ×41 inside `reveal`,
    // which could burn its whole budget minting refs it never returns.
    //
    // Concurrency here is safe in a way it is NOT for `DOM.getDocument`: that
    // command calls DiscardFrontendBindings and invalidates every nodeId handed
    // out so far, which is exactly how a batched `get_state` broke. `describeNode`
    // invalidates nothing, and we read only `backendNodeId` — the browser's own
    // identity for the node, unaffected by anything another in-flight command
    // does. Bounded so a 400-element page doesn't dump 400 commands at once.
    const backendIds: Array<number | undefined> = new Array(pending.length);
    for (let i = 0; i < pending.length; i += DESCRIBE_CONCURRENCY) {
      const slice = pending.slice(i, i + DESCRIBE_CONCURRENCY);
      const described = await Promise.all(
        slice.map(async (entry) => {
          try {
            const d = await cdp<{ node: { backendNodeId?: number } }>(tabId, 'DOM.describeNode', {
              objectId: entry.objectId,
            });
            return d.node.backendNodeId;
          } catch {
            // Node died between probe and describe (SPA re-render) — the entry
            // stays in the tree, just without a ref.
            return undefined;
          }
        }),
      );
      for (let j = 0; j < described.length; j += 1) backendIds[i + j] = described[j];
    }

    // Numbering happens HERE, sequentially over the document-ordered list, so
    // `@eN` is identical to what the old serial walk produced no matter what
    // order the describes came back in.
    for (let i = 0; i < pending.length; i += 1) {
      const backendNodeId = backendIds[i];
      if (backendNodeId === undefined) continue;
      const n = pending[i].node;
      n.ref = '@' + newRef(tabId, backendNodeId, n.role, n.name ?? '');
    }
    return { tree: out.tree as TreeNode[], truncated: out.truncated };
  } finally {
    try {
      await cdp(tabId, 'Runtime.releaseObjectGroup', { objectGroup: GROUP });
    } catch {
      // best-effort cleanup
    }
  }
}

// Below this many interactive elements, the a11y tree is not trusted on its
// own and the DOM walk runs as a cross-check. A tree with zero refs is
// obviously blind (Telegram Web K renders an empty tree); a tree with one or
// two can be just as blind — after /k/'s hash-navigation Chrome kept a stale
// a11y tree whose single "interactive element" belonged to a third-party
// extension while read_text saw the whole rendered chat. Whichever side
// finds more actionable elements wins; ties keep a11y (richer semantics).
const MIN_TRUSTED_AX_REFS = 4;

// How many `DOM.describeNode` calls the DOM path keeps in flight. Enough to
// turn hundreds of serial round-trips into a dozen waves; small enough that a
// huge page does not hand Chrome one enormous burst.
const DESCRIBE_CONCURRENCY = 24;

export type SnapshotResult = { tree: TreeNode[]; source: 'a11y' | 'dom'; truncated: boolean };

/** Whole-page snapshot core: build the a11y tree, cross-check against the DOM
 * walk when it looks blind (mode=dom, or auto + fewer than MIN_TRUSTED_AX_REFS
 * actionable elements), and let whichever side finds more actionable elements
 * win (ties keep a11y). Mints a FRESH @eN ref space for the tab as a side
 * effect (resets refs first), so the refs in the returned tree are exactly the
 * tab's live refs (invariant #7). The caller must have already done resolveTab
 * + ensureAllowed + attach. Whole-page only: the scoped path (snapshot
 * selector=…) has its own resolve-before-reset choreography and does NOT go
 * through here. Shared by `snapshot`, `find` and `reveal` so they can't drift
 * on the a11y-vs-DOM decision. */
export async function buildSnapshotTree(
  tabId: number,
  mode: 'auto' | 'a11y' | 'dom',
  watermark?: number,
): Promise<SnapshotResult> {
  // Refs are monotonic per tab (refs.ts), so a ref from the PREVIOUS snapshot
  // fails as `bad_ref` instead of rebinding to whatever is now in that slot.
  // Within THIS call, though, the a11y attempt / DOM cross-check / a11y rebuild
  // below mint refs that are then discarded, and those never reach the agent —
  // so each retry rewinds to the mark taken here and only the surviving walk's
  // ids advance the counter.
  // A caller that snapshots REPEATEDLY inside one tool call (reveal, once per
  // scroll step) passes its own mark so every discarded pass rewinds to the
  // same point — otherwise 40 steps of never-returned refs push the agent's
  // ids up by 40 snapshots' worth for no reason.
  const mark = watermark ?? refWatermark(tabId);
  resetRefsForTab(tabId, mark);
  const makeRef = (backendDOMNodeId: number, role: string, name: string): string =>
    newRef(tabId, backendDOMNodeId, role, name);

  let axNodes: AXNode[] = [];
  let tree: TreeNode[] = [];
  let source: 'a11y' | 'dom' = 'a11y';
  let truncated = false;
  if (mode !== 'dom') {
    try {
      const result = await cdp<{ nodes: AXNode[] }>(tabId, 'Accessibility.getFullAXTree');
      axNodes = result.nodes;
      tree = buildTree(axNodes, makeRef);
    } catch (e) {
      if (mode === 'a11y') throw e;
      tree = []; // a11y unavailable on this page — fall through to DOM
    }
  }
  const axCount = collectInteractive(tree).length;
  if (mode === 'dom' || (mode === 'auto' && axCount < MIN_TRUSTED_AX_REFS)) {
    resetRefsForTab(tabId, mark); // drop the a11y attempt's refs; the DOM pass re-mints
    let dom: { tree: TreeNode[]; truncated: boolean } | null = null;
    try {
      dom = await domSnapshot(tabId);
    } catch (e) {
      // The cross-check must not lose a working (if sparse) a11y tree.
      if (axCount === 0) throw e;
    }
    if (dom && (mode === 'dom' || collectInteractive(dom.tree).length > axCount)) {
      tree = dom.tree;
      source = 'dom';
      truncated = dom.truncated;
    } else {
      // a11y stays authoritative — rebuild it so its refs are valid again.
      resetRefsForTab(tabId, mark);
      tree = buildTree(axNodes, makeRef);
    }
  }
  return { tree, source, truncated };
}

export const snapshot: Tool = async (args) => {
  const mode = args.mode === 'a11y' || args.mode === 'dom' ? args.mode : 'auto';
  const compact = args.compact === true;
  const scope = typeof args.selector === 'string' && args.selector !== '' ? args.selector : null;
  if (scope && mode === 'a11y') {
    throw new BridgeError(
      'bad_args',
      'snapshot: selector scoping implies a DOM walk — drop mode or use mode=dom',
    );
  }
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);

  // Scoped snapshot: walk just the selected subtree. Resolve the scope
  // BEFORE resetting refs — the selector may itself be an @eN from the
  // previous snapshot (the resolved objectId stays valid past the reset).
  if (scope) {
    const rootObjectId = await resolveSelectorOrRef(tab.id!, scope, 'snapshot');
    resetRefsForTab(tab.id!);
    const dom = await domSnapshot(tab.id!, rootObjectId);
    return {
      tabId: tab.id,
      url: tab.url,
      data: {
        url: tab.url,
        title: tab.title,
        source: 'dom' as const,
        scope,
        ...(compact ? { elements: collectInteractive(dom.tree) } : { tree: dom.tree }),
        ...(dom.truncated ? { truncated: true } : {}),
      },
    };
  }

  const { tree, source, truncated } = await buildSnapshotTree(tab.id!, mode);
  return {
    tabId: tab.id,
    url: tab.url,
    data: {
      url: tab.url,
      title: tab.title,
      source,
      // compact: just the actionable elements, flat — for when the agent
      // needs something to click, not the page's whole text content.
      ...(compact ? { elements: collectInteractive(tree) } : { tree }),
      ...(truncated ? { truncated: true } : {}),
    },
  };
};
