/** Pure response parsing for the CDP-level keystroke password gate.
 *
 * keyboard.ts asks Page.getFrameTree for every document, then
 * Accessibility.getFullAXTree for the focused node in each frame. AX nodes
 * expose a backendDOMNodeId even through closed shadow roots; DOM.describeNode
 * then supplies the browser-owned tag name and attributes without invoking
 * page JavaScript. Keeping the parsers here chrome-free makes every
 * fail-closed decision unit-testable. */

export type FrameTree = {
  frame?: { id?: unknown };
  childFrames?: unknown;
};

export type AXNode = {
  backendDOMNodeId?: unknown;
  properties?: unknown;
};

export type DOMNode = {
  nodeName?: unknown;
  attributes?: unknown;
};

/** Return all frame ids, or null when the tree is malformed. A partial list
 * would falsely claim coverage while silently skipping a child frame. */
export function collectFrameIds(root: unknown): string[] | null {
  const ids: string[] = [];
  const visit = (raw: unknown): boolean => {
    if (!raw || typeof raw !== 'object') return false;
    const tree = raw as FrameTree;
    if (!tree.frame || typeof tree.frame.id !== 'string' || !tree.frame.id) return false;
    ids.push(tree.frame.id);
    if (tree.childFrames === undefined) return true;
    if (!Array.isArray(tree.childFrames)) return false;
    return tree.childFrames.every(visit);
  };
  return visit(root) ? ids : null;
}

/** Extract backend ids for every AX node explicitly marked focused. An empty
 * array is a well-formed frame that does not own focus; null is malformed or
 * contains a focused node without a backend id. */
export function focusedBackendNodeIds(rawNodes: unknown): number[] | null {
  if (!Array.isArray(rawNodes)) return null;
  const ids: number[] = [];
  for (const raw of rawNodes) {
    if (!raw || typeof raw !== 'object') return null;
    const node = raw as AXNode;
    if (node.properties !== undefined && !Array.isArray(node.properties)) return null;
    let focused = false;
    for (const rawProperty of node.properties ?? []) {
      if (!rawProperty || typeof rawProperty !== 'object') return null;
      const property = rawProperty as { name?: unknown; value?: { value?: unknown } };
      if (typeof property.name !== 'string') return null;
      if (property.name === 'focused') {
        if (!property.value || typeof property.value.value !== 'boolean') return null;
        if (property.value.value) focused = true;
      }
    }
    if (!focused) continue;
    if (
      typeof node.backendDOMNodeId !== 'number' ||
      !Number.isInteger(node.backendDOMNodeId) ||
      node.backendDOMNodeId <= 0
    ) {
      return null;
    }
    ids.push(node.backendDOMNodeId);
  }
  return [...new Set(ids)];
}

/** Browser-DOM password classification. null means the node could not be
 * classified safely; false is a well-formed non-password node. */
export function domNodeIsPassword(raw: unknown): boolean | null {
  if (!raw || typeof raw !== 'object') return null;
  const node = raw as DOMNode;
  if (typeof node.nodeName !== 'string') return null;
  if (node.attributes !== undefined && !Array.isArray(node.attributes)) return null;
  if (node.nodeName.toUpperCase() !== 'INPUT') return false;
  if (!Array.isArray(node.attributes)) return null;
  for (let i = 0; i + 1 < node.attributes.length; i += 2) {
    const name = node.attributes[i];
    const value = node.attributes[i + 1];
    if (typeof name !== 'string' || typeof value !== 'string') return null;
    if (name.toLowerCase() === 'type') return value.trim().toLowerCase() === 'password';
  }
  return false;
}

/** Input types that cannot hold typed text at all. Everything else — including
 * the date/time family, whose behaviour varies — is treated as text-accepting,
 * because refusing a call that WOULD have worked is worse than letting an
 * unusual field try. Same direction as the aim probe's fail-open. */
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** Can `Input.insertText` actually put text into this node?
 *
 * `key_type` inserts into whatever holds focus, and when nothing editable does,
 * focus sits on `<body>` — which is not a password field, so the password gate
 * waved it through and the insert went nowhere while the tool answered
 * `ok:true, length:N`. That is the silent no-op this project treats as its worst
 * outcome: the agent believes it typed, and only discovers otherwise several
 * steps later, if at all.
 *
 * The classification is deliberately aligned with what `insertText` can do,
 * which is narrower than "the element has a key handler": a `<div tabindex=0>`
 * listening for keydown receives NOTHING from an insert (no key events are
 * dispatched), so refusing it is correct rather than conservative.
 *
 * `null` for an unclassifiable node, the same fail-closed convention as
 * `domNodeIsPassword` — the caller turns that into `focus_probe_failed`. */
export function domNodeAcceptsText(raw: unknown): boolean | null {
  if (!raw || typeof raw !== 'object') return null;
  const node = raw as DOMNode;
  if (typeof node.nodeName !== 'string') return null;
  if (node.attributes !== undefined && !Array.isArray(node.attributes)) return null;
  const tag = node.nodeName.toUpperCase();

  let type: string | null = null;
  let editable: string | null = null;
  if (Array.isArray(node.attributes)) {
    for (let i = 0; i + 1 < node.attributes.length; i += 2) {
      const name = node.attributes[i];
      const value = node.attributes[i + 1];
      if (typeof name !== 'string' || typeof value !== 'string') return null;
      const lower = name.toLowerCase();
      if (lower === 'type') type = value.trim().toLowerCase();
      if (lower === 'contenteditable') editable = value.trim().toLowerCase();
    }
  }

  // contenteditable is how every rich composer works (Slack, Notion, Gmail,
  // ProseMirror/Slate editors) — and `contenteditable=""` means true.
  if (editable !== null && editable !== 'false') return true;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    if (node.attributes === undefined) return null;
    return type === null || !NON_TEXT_INPUT_TYPES.has(type);
  }
  return false;
}
