/** Pure a11y-tree builder behind `snapshot`'s primary path.
 *
 * Extracted from snapshot.ts so vitest can cover the pruning rules without
 * stubbing `chrome.*` (snapshot.ts imports cdp.ts which touches Chrome APIs
 * at module load). Ref allocation is injected (`makeRef`) for the same
 * reason — snapshot.ts binds it to the per-tab map in refs.ts.
 *
 * Pruning (always on — the dropped nodes carry no information the agent can
 * act on, and on real SPAs they are most of the payload):
 *   - `InlineTextBox` nodes: layout fragments that duplicate their
 *     StaticText parent's name line by line.
 *   - Empty leaves: no name, value, description, ref, or children.
 *   - Text children that merely repeat their parent's accessible name
 *     (`<button>Send</button>` is one node, not a button plus a StaticText).
 */

export const INTERACTIVE_ROLES = new Set([
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

export type AXNode = {
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

/** Allocates the `@eN` ref for an interactive node. snapshot.ts binds this
 * to `newRef` with the tab id; tests pass a counter. */
export type MakeRef = (backendDOMNodeId: number, role: string, name: string) => string;

function isTextLeaf(n: TreeNode): boolean {
  return (
    (n.role === 'StaticText' || n.role === 'text') &&
    !n.children &&
    !n.ref &&
    n.value === undefined &&
    !n.description
  );
}

/** Drop text children that only repeat the parent's accessible name —
 * either one leaf equal to the whole name, or several leaves whose
 * space-joined concatenation is the name (how the a11y name computation
 * builds it from text descendants). */
function pruneDuplicateText(name: string | undefined, kids: TreeNode[]): TreeNode[] {
  if (!name) return kids;
  const out = kids.filter((k) => !(isTextLeaf(k) && k.name === name));
  const textKids = out.filter(isTextLeaf);
  if (textKids.length > 1 && textKids.map((k) => k.name).join(' ') === name) {
    return out.filter((k) => !isTextLeaf(k));
  }
  return out;
}

export function buildTree(nodes: AXNode[], makeRef: MakeRef): TreeNode[] {
  if (nodes.length === 0) return [];
  const byId = new Map<string, AXNode>();
  for (const n of nodes) byId.set(n.nodeId, n);

  const formatChildren = (childIds: string[]): TreeNode[] => {
    const kids: TreeNode[] = [];
    for (const cid of childIds) {
      const c = byId.get(cid);
      if (!c) continue;
      const r = formatNode(c);
      if (!r) continue;
      if (Array.isArray(r)) kids.push(...r);
      else kids.push(r);
    }
    return kids;
  };

  const formatNode = (n: AXNode): TreeNode | TreeNode[] | null => {
    const role = n.role?.value;
    // Layout fragments of their StaticText parent — pure duplication.
    if (role === 'InlineTextBox') return null;
    if (!role || role === 'none' || role === 'generic') {
      // Skip uninteresting wrappers, but bubble up their children.
      if (!n.childIds?.length) return null;
      const kids = formatChildren(n.childIds);
      if (kids.length === 1) return kids[0];
      if (kids.length > 1) return kids;
      return null;
    }

    const out: TreeNode = { role };
    if (n.name?.value) out.name = n.name.value;
    if (n.value?.value !== undefined && n.value.value !== '') out.value = n.value.value;
    if (n.description?.value) out.description = n.description.value;
    if (INTERACTIVE_ROLES.has(role) && n.backendDOMNodeId !== undefined) {
      out.ref = '@' + makeRef(n.backendDOMNodeId, role, n.name?.value ?? '');
    }
    if (n.childIds?.length) {
      const kids = pruneDuplicateText(out.name, formatChildren(n.childIds));
      if (kids.length > 0) out.children = kids;
    }
    // A leaf that names nothing, holds no value and is not actionable
    // carries no information for the agent (empty StaticText et al.).
    if (!out.name && out.value === undefined && !out.description && !out.ref && !out.children) {
      return null;
    }
    return out;
  };

  const root = nodes[0];
  if (!root.childIds) return [];
  return formatChildren(root.childIds);
}

export function treeHasRefs(nodes: TreeNode[]): boolean {
  for (const n of nodes) {
    if (n.ref) return true;
    if (n.children && treeHasRefs(n.children)) return true;
  }
  return false;
}

export type CompactElement = { ref: string; role: string; name?: string; value?: unknown };

/** Flatten a snapshot tree (a11y or DOM source) to just the actionable
 * elements — the `compact: true` shape. Document order is preserved. */
export function collectInteractive(nodes: TreeNode[]): CompactElement[] {
  const out: CompactElement[] = [];
  const walk = (list: TreeNode[]): void => {
    for (const n of list) {
      if (n.ref) {
        const el: CompactElement = { ref: n.ref, role: n.role };
        if (n.name) el.name = n.name;
        if (n.value !== undefined) el.value = n.value;
        out.push(el);
      }
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}
