/** Pure DOM walker behind `snapshot`'s DOM fallback.
 *
 * Some SPAs (Telegram Web K, canvas-heavy apps) expose no useful
 * accessibility tree — `Accessibility.getFullAXTree` returns no interactive
 * nodes and `snapshot` is blind. `snapshot.ts` then serialises
 * `collectDomTree` into a page probe via `Function.prototype.toString` and
 * runs it through `Runtime.evaluate`. The probe is a FIXED literal — no
 * agent input is interpolated — so it carries the same trust shape as
 * `fetch_in_page`'s fixed body and `keyboard.ts`'s ACTIVE_FIELD_PROBE and
 * does NOT require the per-domain evaluate flag.
 *
 * It lives here, free of any `chrome.*` import, so vitest can run it
 * against fake DOM shapes; the real-page run is exercised manually via
 * `sallyport-daemon exec snapshot`.
 *
 * MUST stay self-contained — no imports, no closure references — so
 * `toString()` serialisation yields a runnable standalone page expression.
 *
 * Coverage notes (same blind spots as the rest of the extension, see
 * SECURITY.md): descends OPEN shadow roots only; iframes are separate
 * documents and are not entered; slotted light-DOM content under a shadow
 * root is not re-projected.
 */

export type DomNodeLike = {
  nodeType: number;
  nodeValue?: string | null;
  tagName?: string;
  childNodes?: ArrayLike<DomNodeLike>;
  shadowRoot?: { childNodes?: ArrayLike<DomNodeLike> } | null;
  getAttribute?: (name: string) => string | null;
  isContentEditable?: boolean;
};

export type DomDocumentLike = {
  body?: DomNodeLike | null;
  defaultView?: {
    getComputedStyle?: (el: DomNodeLike) => { display?: string; visibility?: string };
  } | null;
};

/** One output node. Interactive elements carry `idx` — an index into the
 * returned `els` array — which `snapshot.ts` swaps for a per-tab `@eN` ref
 * (via DOM.describeNode → backendNodeId) before the tree leaves the
 * extension. `ref` is only ever set by that swap, never by the probe. */
export type DomTreeNode = {
  role: string;
  name?: string;
  idx?: number;
  ref?: string;
  children?: DomTreeNode[];
};

export type DomTreeResult = { tree: DomTreeNode[]; els: unknown[]; truncated: boolean };

/** Walk `root` (a single element) instead of the whole body when given —
 * `snapshot selector=…` uses this to scope the result to one subtree.
 * Optional second parameter so the original whole-page probe literal
 * `(collectDomTree)(document)` keeps working unchanged. */
export function collectDomTree(doc: DomDocumentLike, root?: DomNodeLike | null): DomTreeResult {
  // Bounds keep the probe's output well under the 16 MiB frame cap even on
  // pathological pages, and keep the snapshot readable for the model.
  const MAX_ELS = 400; // interactive elements that get refs
  const MAX_TEXT = 200; // chars per text fragment / element name
  const MAX_NODES = 2000; // total output nodes

  // Subtrees that render nothing the agent can act on.
  const SKIP: Record<string, number> = {
    SCRIPT: 1,
    STYLE: 1,
    NOSCRIPT: 1,
    TEMPLATE: 1,
    HEAD: 1,
    META: 1,
    LINK: 1,
    SVG: 1, // icon noise; the host element's aria-label/title carries the name
    IFRAME: 1, // separate document — unreachable from this probe
  };
  // Mirrors INTERACTIVE_ROLES in snapshot.ts so a11y and DOM snapshots
  // hand out refs for the same kinds of elements.
  const ARIA_ROLES: Record<string, number> = {
    button: 1,
    link: 1,
    textbox: 1,
    checkbox: 1,
    radio: 1,
    combobox: 1,
    listbox: 1,
    menuitem: 1,
    menuitemcheckbox: 1,
    menuitemradio: 1,
    option: 1,
    searchbox: 1,
    slider: 1,
    spinbutton: 1,
    switch: 1,
    tab: 1,
    treeitem: 1,
  };
  const TAG_ROLES: Record<string, string> = {
    BUTTON: 'button',
    TEXTAREA: 'textbox',
    SELECT: 'combobox',
    OPTION: 'option',
    SUMMARY: 'button',
  };
  const INPUT_ROLES: Record<string, string> = {
    checkbox: 'checkbox',
    radio: 'radio',
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'button',
    range: 'slider',
    search: 'searchbox',
    file: 'button',
  };

  const els: unknown[] = [];
  let nodeCount = 0;
  let truncated = false;

  function cap(s: string): string {
    return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s;
  }

  function norm(s: string | null | undefined): string {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function attr(el: DomNodeLike, name: string): string {
    if (!el.getAttribute) return '';
    return el.getAttribute(name) || '';
  }

  function hidden(el: DomNodeLike): boolean {
    if (attr(el, 'aria-hidden') === 'true') return true;
    const view = doc.defaultView;
    if (!view || !view.getComputedStyle) return false;
    let cs;
    try {
      cs = view.getComputedStyle(el);
    } catch {
      return false; // not a styleable element — let the walk decide
    }
    return !cs || cs.display === 'none' || cs.visibility === 'hidden';
  }

  function roleFor(el: DomNodeLike): string | null {
    const aria = attr(el, 'role').toLowerCase();
    if (aria && ARIA_ROLES[aria]) return aria;
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'A') return attr(el, 'href') ? 'link' : null;
    if (tag === 'INPUT') {
      const t = (attr(el, 'type') || 'text').toLowerCase();
      if (t === 'hidden') return null;
      return INPUT_ROLES[t] || 'textbox';
    }
    if (TAG_ROLES[tag]) return TAG_ROLES[tag];
    if (el.isContentEditable) return 'textbox';
    const tabindex = attr(el, 'tabindex');
    if (attr(el, 'onclick') || (tabindex !== '' && tabindex !== '-1')) return 'button';
    return null;
  }

  function textOf(el: DomNodeLike): string {
    // Recompute from visible descendants rather than trusting innerText —
    // innerText is not in DomNodeLike and textContent includes hidden text.
    let out = '';
    const stack: DomNodeLike[] = [el];
    while (stack.length && out.length <= MAX_TEXT) {
      const n = stack.pop() as DomNodeLike;
      if (n.nodeType === 3) {
        const t = norm(n.nodeValue);
        if (t) out = out ? out + ' ' + t : t;
        continue;
      }
      if (n.nodeType !== 1) continue;
      if (n !== el && (SKIP[(n.tagName || '').toUpperCase()] || hidden(n))) continue;
      const kids = n.shadowRoot && n.shadowRoot.childNodes ? n.shadowRoot.childNodes : n.childNodes;
      if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return cap(out);
  }

  function nameFor(el: DomNodeLike): string {
    let n =
      attr(el, 'aria-label') || attr(el, 'placeholder') || attr(el, 'title') || attr(el, 'alt');
    if (!n && (el.tagName || '').toUpperCase() === 'INPUT') {
      // The value ATTRIBUTE (initial value), never the live .value — the
      // live one can hold user-typed secrets; and never for passwords.
      const t = (attr(el, 'type') || 'text').toLowerCase();
      if (t !== 'password') n = attr(el, 'value');
    }
    if (!n) n = textOf(el);
    return cap(norm(n));
  }

  function walkElement(el: DomNodeLike): DomTreeNode[] {
    if (truncated) return [];
    if (el.nodeType !== 1) return [];
    if (SKIP[(el.tagName || '').toUpperCase()] || hidden(el)) return [];

    const role = roleFor(el);
    // Inside an interactive element the subtree text IS the name —
    // <button><span>Send</span></button> is one node, not three. Containers
    // whose children are themselves actionable still descend.
    const descend = !role || role === 'combobox' || role === 'listbox';
    const kids = descend ? walkChildren(el) : [];

    if (!role) return kids; // wrapper — bubble children up (like the AX builder)

    if (nodeCount >= MAX_NODES) {
      truncated = true;
      return kids;
    }
    nodeCount++;
    const out: DomTreeNode = { role };
    const name = nameFor(el);
    if (name) out.name = name;
    if (els.length < MAX_ELS) {
      out.idx = els.length;
      els.push(el);
    } else {
      truncated = true;
    }
    if (kids.length) out.children = kids;
    return [out];
  }

  function walkChildren(el: DomNodeLike): DomTreeNode[] {
    const out: DomTreeNode[] = [];
    // An open shadow root replaces the light DOM in rendering — walk it
    // instead of childNodes (slotted content is a documented gap).
    const list =
      el.shadowRoot && el.shadowRoot.childNodes ? el.shadowRoot.childNodes : el.childNodes;
    if (!list) return out;
    // Adjacent DIRECT text-node siblings merge into one fragment; text
    // bubbled out of element children stays separate so distinct blocks
    // (e.g. two chat messages) don't fuse into one blob.
    let lastDirectText: DomTreeNode | null = null;
    for (let i = 0; i < list.length; i++) {
      if (truncated || nodeCount >= MAX_NODES) {
        truncated = true;
        break;
      }
      const child = list[i];
      if (child.nodeType === 3) {
        const t = norm(child.nodeValue);
        if (!t) continue;
        if (lastDirectText) {
          lastDirectText.name = cap((lastDirectText.name || '') + ' ' + t);
        } else {
          nodeCount++;
          lastDirectText = { role: 'text', name: cap(t) };
          out.push(lastDirectText);
        }
        continue;
      }
      lastDirectText = null;
      if (child.nodeType !== 1) continue;
      const sub = walkElement(child);
      for (let j = 0; j < sub.length; j++) out.push(sub[j]);
    }
    return out;
  }

  const start = root || doc.body;
  const tree = start ? walkElement(start) : [];
  return { tree, els, truncated };
}
