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

/** Roles Chrome gives a frame host (`<iframe>`/`<frame>`). Kept even when the
 * node is otherwise empty: a frame's CONTENT is not in this tree (a separate
 * document, and for a cross-origin one a separate process), so the empty-leaf
 * pruning below used to delete the only evidence that the page's real content
 * was somewhere the snapshot cannot reach. An agent then read a checkout, an
 * SSO step or an embedded dashboard as a blank shell with nothing to click and
 * no reason given. */
const FRAME_ROLES = new Set(['Iframe', 'IframePresentational', 'iframe', 'frame']);

export function isFrameRole(role: string | undefined): boolean {
  return role !== undefined && FRAME_ROLES.has(role);
}

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
  // The element's HTML input type (DOM-sourced snapshots only) — surfaces a
  // field whose a11y role reads `textbox` but is actually `type=password`,
  // so the agent doesn't pick it by mistake. The a11y path can't read it
  // cheaply, so it's absent there.
  type?: string;
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
    // carries no information for the agent (empty StaticText et al.) — unless
    // it is a FRAME, where "there is content here that this tree does not
    // contain" is the single most useful thing the snapshot can say.
    if (
      !out.name &&
      out.value === undefined &&
      !out.description &&
      !out.ref &&
      !out.children &&
      !isFrameRole(role)
    ) {
      return null;
    }
    return out;
  };

  const root = nodes[0];
  if (!root.childIds) return [];
  return formatChildren(root.childIds);
}

export type CompactElement = {
  ref: string;
  role: string;
  name?: string;
  value?: unknown;
  type?: string;
};

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
        if (n.type) el.type = n.type;
        out.push(el);
      }
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

// --- emission caps ----------------------------------------------------------
//
// `buildTree` walks whatever `Accessibility.getFullAXTree` returns, and that is
// unbounded: a long feed, a big table or a docs page can be tens of thousands of
// nodes with paragraph-sized names. The DOM fallback has had hard bounds since
// it was written ("keep the probe's output well under the 16 MiB frame cap even
// on pathological pages", domtree.ts) — the PRIMARY path never got them, and it
// is the one that runs on nearly every snapshot.
//
// Two things go wrong without a bound, in ascending order of damage. The tree
// lands in the agent's context whole, which is the token equivalent of
// `read_text` with no `maxChars` (it caps at 20k for exactly this reason). And
// past 16 MiB the tool_result frame is refused by the daemon with a 1009 close
// — which does not fail one call, it drops the SINGLE shared extension leg
// (invariant #8) and takes every concurrent session's in-flight work with it.
//
// The caps apply to what is EMITTED, not to what is walked: `find` and `reveal`
// match over the full tree and return at most `limit` matches, so bounding the
// walk would make a target beyond the cap unfindable — a real regression for the
// long lists `reveal` exists to serve. Only the shapes that ship the tree itself
// (`snapshot`, and the `observe` folded into an action) are capped.

/** Nodes a snapshot may emit. Same value as the DOM walk's `MAX_NODES`, so the
 * two paths stay comparable — `buildSnapshotTree` picks between them by ref
 * count, and a cap that differed would bias that choice. */
export const SNAPSHOT_MAX_NODES = 2000;
/** Characters per emitted name/description/string value (DOM walk parity). */
export const SNAPSHOT_MAX_TEXT = 200;
/** Actionable elements the compact form may emit (DOM walk parity: `MAX_ELS`).
 * Higher than any page an agent can usefully act on in one pass — past this,
 * `find` with a predicate is the right tool, not a longer list. */
export const SNAPSHOT_MAX_ELEMENTS = 400;

/** Cap one emitted string, stepping back off a surrogate pair.
 *
 * A lone half is unsignable (protocol.ts), and it would not fail the one name —
 * it discards the WHOLE tool result as `unserialisable_result`. Same reasoning,
 * and same two lines, as the DOM walker's own `cap`. */
export function capName(s: string, max: number = SNAPSHOT_MAX_TEXT): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, end) + '…';
}

/** Copy a tree, keeping at most `maxNodes` nodes in document order and capping
 * every emitted string. Returns `truncated` when NODES were dropped, so the
 * caller can tell the agent to narrow the walk (`selector`, `compact`, or
 * `find`) rather than believe it is looking at the whole page.
 *
 * A cut STRING does not raise that flag: the DOM walk has always trimmed names
 * silently, with the trailing ellipsis as the visible signal, and `truncated`
 * has always meant "there is more of the page than this". Flagging a trimmed
 * name too would raise it on almost every real snapshot — and would fire twice
 * over on the DOM path, whose names arrive already trimmed.
 *
 * A parent kept with its children dropped keeps its own row — an ancestor
 * without its subtree is still true, while dropping it would silently move its
 * surviving siblings up a level and misdescribe the page's structure. */
export function capTree(
  nodes: TreeNode[],
  maxNodes: number = SNAPSHOT_MAX_NODES,
  maxText: number = SNAPSHOT_MAX_TEXT,
): { tree: TreeNode[]; truncated: boolean } {
  let budget = maxNodes;
  let truncated = false;

  const copy = (list: TreeNode[]): TreeNode[] => {
    const out: TreeNode[] = [];
    for (const n of list) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      budget -= 1;
      const next: TreeNode = { role: n.role };
      if (n.name !== undefined) next.name = capName(n.name, maxText);
      if (n.value !== undefined) {
        next.value = typeof n.value === 'string' ? capName(n.value, maxText) : n.value;
      }
      if (n.description !== undefined) next.description = capName(n.description, maxText);
      if (n.type !== undefined) next.type = n.type;
      if (n.ref !== undefined) next.ref = n.ref;
      if (n.children?.length) {
        const kids = copy(n.children);
        if (kids.length) next.children = kids;
      }
      out.push(next);
    }
    return out;
  };

  return { tree: copy(nodes), truncated };
}

/** The compact form's cap: at most `max` elements, every string capped. Refs
 * already minted for dropped elements stay valid — they are simply not
 * reported, which is what `truncated` tells the agent. As in `capTree`, a
 * trimmed string is not itself a truncation. */
export function capElements(
  els: CompactElement[],
  max: number,
  maxText: number = SNAPSHOT_MAX_TEXT,
): { elements: CompactElement[]; truncated: boolean } {
  const kept = els.slice(0, max);
  const elements = kept.map((e) => {
    const next: CompactElement = { ref: e.ref, role: e.role };
    if (e.name !== undefined) next.name = capName(e.name, maxText);
    if (e.value !== undefined) {
      next.value = typeof e.value === 'string' ? capName(e.value, maxText) : e.value;
    }
    if (e.type !== undefined) next.type = e.type;
    return next;
  });
  return { elements, truncated: kept.length < els.length };
}
