import { buildTree, collectInteractive, type AXNode, type TreeNode } from './axtree.js';
import { attach, cdp } from './cdp.js';
import { resolveSelectorOrRef } from './dom.js';
import { collectDomTree, type DomTreeNode, type DomTreeResult } from './domtree.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { newRef, resetRefsForTab } from './refs.js';
import { resolveTab } from './tabs.js';
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

    const assignRefs = async (nodes: DomTreeNode[]): Promise<void> => {
      for (const n of nodes) {
        if (n.idx !== undefined) {
          const objectId = elIds.get(n.idx);
          delete n.idx;
          if (objectId) {
            try {
              const d = await cdp<{ node: { backendNodeId?: number } }>(tabId, 'DOM.describeNode', {
                objectId,
              });
              if (d.node.backendNodeId !== undefined) {
                n.ref = '@' + newRef(tabId, d.node.backendNodeId, n.role, n.name ?? '');
              }
            } catch {
              // Node died between probe and describe (SPA re-render) — the
              // entry stays in the tree, just without a ref.
            }
          }
        }
        if (n.children) await assignRefs(n.children);
      }
    };
    await assignRefs(out.tree);
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
): Promise<SnapshotResult> {
  resetRefsForTab(tabId);
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
    resetRefsForTab(tabId); // drop the a11y refs; the DOM pass reallocates from @e1
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
      resetRefsForTab(tabId);
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
