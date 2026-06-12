import {
  buildTree,
  collectInteractive,
  treeHasRefs,
  type AXNode,
  type TreeNode,
} from './axtree.js';
import { attach, cdp } from './cdp.js';
import { collectDomTree, type DomTreeNode, type DomTreeResult } from './domtree.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { newRef, resetRefsForTab } from './refs.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

// The serialised `collectDomTree` (domtree.ts) applied to the page document.
// A FIXED literal — no agent input is interpolated — so it carries the same
// trust shape as fetch_in_page's fixed body / keyboard.ts's
// ACTIVE_FIELD_PROBE and does not require the per-domain evaluate flag.
const DOM_TREE_PROBE = '(' + collectDomTree.toString() + ')(document)';

/** DOM fallback for pages whose accessibility tree is empty (Telegram Web K
 * and friends): run the fixed walker probe, pull the tree by value, then swap
 * each interactive element's `idx` for a per-tab `@eN` ref by resolving the
 * element handle to a backendNodeId (DOM.describeNode) — the same ref space
 * the a11y path uses, so click/fill/read_text work unchanged. */
async function domSnapshot(tabId: number): Promise<{ tree: TreeNode[]; truncated: boolean }> {
  const GROUP = 'sallyport_snapshot';
  const ev = await cdp<{
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

export const snapshot: Tool = async (args) => {
  const mode = args.mode === 'a11y' || args.mode === 'dom' ? args.mode : 'auto';
  const compact = args.compact === true;
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  resetRefsForTab(tab.id!);

  let tree: TreeNode[] = [];
  let source: 'a11y' | 'dom' = 'a11y';
  let truncated = false;
  if (mode !== 'dom') {
    try {
      const result = await cdp<{ nodes: AXNode[] }>(tab.id!, 'Accessibility.getFullAXTree');
      tree = buildTree(result.nodes, (backendDOMNodeId, role, name) =>
        newRef(tab.id!, backendDOMNodeId, role, name),
      );
    } catch (e) {
      if (mode === 'a11y') throw e;
      tree = []; // a11y unavailable on this page — fall through to DOM
    }
  }
  // No interactive nodes in the a11y tree means the page is effectively
  // invisible to the agent (Telegram Web K renders an empty tree) — fall
  // back to walking the DOM for visible text + interactive elements.
  if (mode === 'dom' || (mode === 'auto' && !treeHasRefs(tree))) {
    resetRefsForTab(tab.id!); // drop any refs the discarded a11y pass made
    const dom = await domSnapshot(tab.id!);
    tree = dom.tree;
    source = 'dom';
    truncated = dom.truncated;
  }
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
