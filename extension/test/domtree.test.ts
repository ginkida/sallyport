/**
 * The DOM walker behind `snapshot`'s fallback for pages with an empty
 * accessibility tree (Telegram Web K). `collectDomTree` is serialised into a
 * fixed page probe by snapshot.ts (same trust shape as fetch_in_page's fixed
 * body); the chrome-bound plumbing around it is exercised via the daemon's
 * e2e harness / manual exec. These tests pin the pure walk: which elements
 * count as interactive, how names are derived (without leaking password
 * values), how hidden subtrees are pruned, and how text fragments merge.
 */

import { describe, expect, it } from 'vitest';
import {
  collectDomTree,
  type DomDocumentLike,
  type DomNodeLike,
  type DomTreeNode,
} from '../src/tools/domtree.js';

type FakeEl = DomNodeLike & { style?: { display?: string; visibility?: string } };

function el(
  tagName: string,
  attrs: Record<string, string> = {},
  children: DomNodeLike[] = [],
  extra: Partial<FakeEl> = {},
): FakeEl {
  return {
    nodeType: 1,
    tagName,
    childNodes: children,
    getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
    ...extra,
  };
}

function text(value: string): DomNodeLike {
  return { nodeType: 3, nodeValue: value };
}

function doc(body: DomNodeLike): DomDocumentLike {
  return {
    body,
    defaultView: {
      getComputedStyle: (node: DomNodeLike) => {
        const s = (node as FakeEl).style ?? {};
        return { display: s.display ?? 'block', visibility: s.visibility ?? 'visible' };
      },
    },
  };
}

function flatten(nodes: DomTreeNode[]): DomTreeNode[] {
  const out: DomTreeNode[] = [];
  for (const n of nodes) {
    out.push(n);
    if (n.children) out.push(...flatten(n.children));
  }
  return out;
}

describe('collectDomTree — snapshot DOM fallback', () => {
  it('collects visible text and skips whitespace-only nodes', () => {
    const d = doc(el('BODY', {}, [text('  hello  '), text('   '), text('world')]));
    const { tree } = collectDomTree(d);
    // Adjacent direct text siblings merge into one fragment.
    expect(tree).toEqual([{ role: 'text', name: 'hello world' }]);
  });

  it('keeps text from different block elements as separate fragments', () => {
    const d = doc(
      el('BODY', {}, [el('DIV', {}, [text('message one')]), el('DIV', {}, [text('message two')])]),
    );
    const { tree } = collectDomTree(d);
    expect(tree).toEqual([
      { role: 'text', name: 'message one' },
      { role: 'text', name: 'message two' },
    ]);
  });

  it('marks interactive elements with roles and sequential els indices', () => {
    const d = doc(
      el('BODY', {}, [
        el('A', { href: '/x' }, [text('a link')]),
        el('BUTTON', {}, [text('Send')]),
        el('INPUT', { type: 'checkbox' }),
        el('TEXTAREA', { placeholder: 'Write…' }),
      ]),
    );
    const { tree, els } = collectDomTree(d);
    expect(tree.map((n) => [n.role, n.name, n.idx])).toEqual([
      ['link', 'a link', 0],
      ['button', 'Send', 1],
      ['checkbox', undefined, 2],
      ['textbox', 'Write…', 3],
    ]);
    expect(els).toHaveLength(4);
  });

  it('treats an anchor without href as plain text, not a link', () => {
    const d = doc(el('BODY', {}, [el('A', {}, [text('not a link')])]));
    const { tree } = collectDomTree(d);
    expect(tree).toEqual([{ role: 'text', name: 'not a link' }]);
  });

  it('honours whitelisted ARIA roles and contenteditable/tabindex/onclick affordances', () => {
    const d = doc(
      el('BODY', {}, [
        el('DIV', { role: 'button' }, [text('aria button')]),
        el('DIV', {}, [], { isContentEditable: true }),
        el('DIV', { tabindex: '0' }, [text('focusable')]),
        el('DIV', { tabindex: '-1' }, [text('skipped')]),
        el('DIV', { onclick: 'go()' }, [text('clicky')]),
        el('DIV', { role: 'presentation' }, [text('just text')]),
      ]),
    );
    const { tree } = collectDomTree(d);
    expect(tree.map((n) => n.role)).toEqual([
      'button',
      'textbox',
      'button',
      'text', // tabindex=-1 is not interactive — its text bubbles out
      'button',
      'text', // unknown/presentation role falls back to text
    ]);
  });

  it('does not descend into interactive elements (their text is the name)', () => {
    const d = doc(el('BODY', {}, [el('BUTTON', {}, [el('SPAN', {}, [text('Send')])])]));
    const { tree } = collectDomTree(d);
    expect(tree).toEqual([{ role: 'button', name: 'Send', idx: 0 }]);
  });

  it('descends into comboboxes so options stay visible', () => {
    const d = doc(
      el('BODY', {}, [
        el('SELECT', {}, [el('OPTION', {}, [text('One')]), el('OPTION', {}, [text('Two')])]),
      ]),
    );
    const { tree } = collectDomTree(d);
    expect(tree[0].role).toBe('combobox');
    expect(tree[0].children?.map((n) => [n.role, n.name])).toEqual([
      ['option', 'One'],
      ['option', 'Two'],
    ]);
  });

  it('prefers aria-label over placeholder over subtree text for the name', () => {
    const d = doc(
      el('BODY', {}, [
        el('BUTTON', { 'aria-label': 'Close', title: 'x' }, [text('×')]),
        el('INPUT', { placeholder: 'Search', title: 'tip' }),
        el('BUTTON', { title: 'Tip' }, []),
      ]),
    );
    const { tree } = collectDomTree(d);
    expect(tree.map((n) => n.name)).toEqual(['Close', 'Search', 'Tip']);
  });

  it('uses the value ATTRIBUTE for a text input name, but never for passwords', () => {
    const d = doc(
      el('BODY', {}, [
        el('INPUT', { type: 'text', value: 'initial' }),
        el('INPUT', { type: 'password', value: 'hunter2' }),
      ]),
    );
    const { tree } = collectDomTree(d);
    expect(tree[0].name).toBe('initial');
    expect(tree[1].role).toBe('textbox');
    expect(tree[1].name).toBeUndefined();
    expect(JSON.stringify(tree)).not.toContain('hunter2');
  });

  it('skips hidden inputs entirely', () => {
    const d = doc(el('BODY', {}, [el('INPUT', { type: 'hidden', value: 'csrf' })]));
    expect(collectDomTree(d).tree).toEqual([]);
  });

  it('prunes display:none / visibility:hidden / aria-hidden subtrees', () => {
    const d = doc(
      el('BODY', {}, [
        el('DIV', {}, [text('gone')], { style: { display: 'none' } }),
        el('DIV', {}, [text('invisible')], { style: { visibility: 'hidden' } }),
        el('DIV', { 'aria-hidden': 'true' }, [text('decorative')]),
        el('DIV', {}, [text('visible')]),
      ]),
    );
    const { tree } = collectDomTree(d);
    expect(tree).toEqual([{ role: 'text', name: 'visible' }]);
  });

  it('skips script/style/template/svg/iframe subtrees', () => {
    const d = doc(
      el('BODY', {}, [
        el('SCRIPT', {}, [text('var x = 1;')]),
        el('STYLE', {}, [text('.a{}')]),
        el('TEMPLATE', {}, [text('tpl')]),
        el('SVG', {}, [text('icon path')]),
        el('IFRAME', {}, [text('inner doc')]),
        text('real'),
      ]),
    );
    expect(collectDomTree(d).tree).toEqual([{ role: 'text', name: 'real' }]);
  });

  it('descends OPEN shadow roots in place of the light DOM', () => {
    const host = el('DIV', {}, [text('light (not rendered)')], {
      shadowRoot: { childNodes: [el('BUTTON', {}, [text('shadow button')])] },
    });
    const { tree } = collectDomTree(doc(el('BODY', {}, [host])));
    expect(tree).toEqual([{ role: 'button', name: 'shadow button', idx: 0 }]);
  });

  it('derives a button name from visible subtree text, skipping hidden parts', () => {
    const btn = el('BUTTON', {}, [
      el('SPAN', {}, [text('ok')], { style: { display: 'none' } }),
      el('SPAN', {}, [text('Confirm')]),
    ]);
    const { tree } = collectDomTree(doc(el('BODY', {}, [btn])));
    expect(tree[0].name).toBe('Confirm');
  });

  it('caps element refs at 400 and reports truncation', () => {
    const kids: DomNodeLike[] = [];
    for (let i = 0; i < 450; i++) kids.push(el('BUTTON', {}, [text(`b${i}`)]));
    const { els, truncated, tree } = collectDomTree(doc(el('BODY', {}, kids)));
    expect(els).toHaveLength(400);
    expect(truncated).toBe(true);
    const flat = flatten(tree);
    expect(flat.filter((n) => n.idx !== undefined)).toHaveLength(400);
  });

  it('caps long text fragments at 200 chars with an ellipsis', () => {
    const long = 'x'.repeat(500);
    const { tree } = collectDomTree(doc(el('BODY', {}, [text(long)])));
    expect(tree[0].name).toHaveLength(201);
    expect(tree[0].name?.endsWith('…')).toBe(true);
  });

  it('returns an empty tree for a document with no body', () => {
    expect(collectDomTree({ body: null })).toEqual({ tree: [], els: [], truncated: false });
  });

  it('walks only the given root subtree when one is passed (scoped snapshot)', () => {
    const wanted = el('UL', {}, [el('BUTTON', {}, [text('In scope')])]);
    const noise = el('DIV', {}, [el('BUTTON', {}, [text('Out of scope')]), text('page noise')]);
    const body = el('BODY', {}, [noise, wanted]);
    const { tree, els } = collectDomTree(doc(body), wanted);
    expect(tree).toEqual([{ role: 'button', name: 'In scope', idx: 0 }]);
    expect(els).toHaveLength(1);
  });

  it('a null root falls back to the whole body', () => {
    const body = el('BODY', {}, [el('BUTTON', {}, [text('Go')])]);
    expect(collectDomTree(doc(body), null).tree).toEqual(collectDomTree(doc(body)).tree);
  });

  it('is self-contained: toString() yields a standalone expression', () => {
    // snapshot.ts serialises the function into the page; any closure
    // reference (import, module const) would throw a ReferenceError there.
    const src = collectDomTree.toString();
    const standalone = new Function('doc', `return (${src})(doc);`) as (
      d: DomDocumentLike,
    ) => ReturnType<typeof collectDomTree>;
    const out = standalone(doc(el('BODY', {}, [text('hi'), el('BUTTON', {}, [text('Go')])])));
    expect(out.tree).toEqual([
      { role: 'text', name: 'hi' },
      { role: 'button', name: 'Go', idx: 0 },
    ]);
  });
});
