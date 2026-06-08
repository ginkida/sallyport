import { attach, cdp } from './cdp.js';
import { ensureAllowed } from './gates.js';
import { newRef, resetRefsForTab } from './refs.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'treeitem',
]);

type AXNode = {
  nodeId: string;
  role?: { value: string };
  name?: { value: string };
  value?: { value: unknown };
  description?: { value: string };
  childIds?: string[];
  backendDOMNodeId?: number;
};

export type TreeNode = {
  role: string;
  name?: string;
  value?: unknown;
  description?: string;
  ref?: string;
  children?: TreeNode[];
};

function buildTree(tabId: number, nodes: AXNode[]): TreeNode[] {
  if (nodes.length === 0) return [];
  const byId = new Map<string, AXNode>();
  for (const n of nodes) byId.set(n.nodeId, n);

  const formatNode = (n: AXNode): TreeNode | TreeNode[] | null => {
    const role = n.role?.value;
    if (!role || role === 'none' || role === 'generic') {
      // Skip uninteresting wrappers, but bubble up their children.
      if (!n.childIds?.length) return null;
      const kids: TreeNode[] = [];
      for (const cid of n.childIds) {
        const c = byId.get(cid);
        if (!c) continue;
        const r = formatNode(c);
        if (!r) continue;
        if (Array.isArray(r)) kids.push(...r);
        else kids.push(r);
      }
      if (kids.length === 1) return kids[0];
      if (kids.length > 1) return kids;
      return null;
    }

    const out: TreeNode = { role };
    if (n.name?.value) out.name = n.name.value;
    if (n.value?.value !== undefined && n.value.value !== '') out.value = n.value.value;
    if (n.description?.value) out.description = n.description.value;
    if (INTERACTIVE_ROLES.has(role) && n.backendDOMNodeId !== undefined) {
      out.ref = '@' + newRef(tabId, n.backendDOMNodeId, role, n.name?.value ?? '');
    }
    if (n.childIds?.length) {
      const kids: TreeNode[] = [];
      for (const cid of n.childIds) {
        const c = byId.get(cid);
        if (!c) continue;
        const r = formatNode(c);
        if (!r) continue;
        if (Array.isArray(r)) kids.push(...r);
        else kids.push(r);
      }
      if (kids.length > 0) out.children = kids;
    }
    return out;
  };

  const root = nodes[0];
  const out: TreeNode[] = [];
  if (!root.childIds) return out;
  for (const cid of root.childIds) {
    const c = byId.get(cid);
    if (!c) continue;
    const r = formatNode(c);
    if (!r) continue;
    if (Array.isArray(r)) out.push(...r);
    else out.push(r);
  }
  return out;
}

export const snapshot: Tool = async (args) => {
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  resetRefsForTab(tab.id!);
  const result = await cdp<{ nodes: AXNode[] }>(tab.id!, 'Accessibility.getFullAXTree');
  const tree = buildTree(tab.id!, result.nodes);
  return { tabId: tab.id, url: tab.url, data: { url: tab.url, title: tab.title, tree } };
};
