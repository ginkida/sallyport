import { describe, expect, it } from 'vitest';

import {
  buildTree,
  capElements,
  capName,
  capTree,
  collectInteractive,
  isFrameRole,
  SNAPSHOT_MAX_TEXT,
  type AXNode,
  type MakeRef,
  type TreeNode,
} from '../src/tools/axtree.js';

/** Deterministic ref allocator standing in for refs.ts's newRef. */
function counterRef(): MakeRef {
  let n = 0;
  return () => `e${++n}`;
}

function ax(
  nodeId: string,
  role: string | undefined,
  extra: Partial<AXNode> & { name?: string } = {},
): AXNode {
  const { name, ...rest } = extra;
  return {
    nodeId,
    ...(role !== undefined ? { role: { value: role } } : {}),
    ...(name !== undefined ? { name: { value: name } } : {}),
    ...rest,
  };
}

describe('buildTree', () => {
  it('returns [] for an empty node list', () => {
    expect(buildTree([], counterRef())).toEqual([]);
  });

  it('assigns refs to interactive roles with a backend node id', () => {
    const nodes = [
      ax('1', 'RootWebArea', { childIds: ['2', '3'] }),
      ax('2', 'button', { name: 'Send', backendDOMNodeId: 10 }),
      ax('3', 'image', { name: 'logo', backendDOMNodeId: 11 }),
    ];
    const tree = buildTree(nodes, counterRef());
    expect(tree).toEqual([
      { role: 'button', name: 'Send', ref: '@e1' },
      { role: 'image', name: 'logo' },
    ]);
  });

  it('bubbles children of none/generic wrappers up', () => {
    const nodes = [
      ax('1', 'RootWebArea', { childIds: ['2'] }),
      ax('2', 'generic', { childIds: ['3', '4'] }),
      ax('3', 'button', { name: 'A', backendDOMNodeId: 1 }),
      ax('4', 'button', { name: 'B', backendDOMNodeId: 2 }),
    ];
    const tree = buildTree(nodes, counterRef());
    expect(tree.map((n) => n.name)).toEqual(['A', 'B']);
  });

  it('prunes InlineTextBox nodes unconditionally', () => {
    const nodes = [
      ax('1', 'RootWebArea', { childIds: ['2'] }),
      ax('2', 'StaticText', { name: 'Hello world', childIds: ['3', '4'] }),
      ax('3', 'InlineTextBox', { name: 'Hello' }),
      ax('4', 'InlineTextBox', { name: 'world' }),
    ];
    const tree = buildTree(nodes, counterRef());
    expect(tree).toEqual([{ role: 'StaticText', name: 'Hello world' }]);
  });

  it('prunes empty leaves (no name, value, description, ref, children)', () => {
    const nodes = [
      ax('1', 'RootWebArea', { childIds: ['2', '3'] }),
      ax('2', 'StaticText', { name: '' }),
      ax('3', 'paragraph'),
    ];
    expect(buildTree(nodes, counterRef())).toEqual([]);
  });

  it('keeps an empty-named node if it has interactive descendants', () => {
    const nodes = [
      ax('1', 'RootWebArea', { childIds: ['2'] }),
      ax('2', 'paragraph', { childIds: ['3'] }),
      ax('3', 'link', { name: 'docs', backendDOMNodeId: 5 }),
    ];
    const tree = buildTree(nodes, counterRef());
    expect(tree).toEqual([
      { role: 'paragraph', children: [{ role: 'link', name: 'docs', ref: '@e1' }] },
    ]);
  });

  it('drops a StaticText child that repeats the parent name verbatim', () => {
    const nodes = [
      ax('1', 'RootWebArea', { childIds: ['2'] }),
      ax('2', 'button', { name: 'Send', backendDOMNodeId: 7, childIds: ['3'] }),
      ax('3', 'StaticText', { name: 'Send' }),
    ];
    const tree = buildTree(nodes, counterRef());
    expect(tree).toEqual([{ role: 'button', name: 'Send', ref: '@e1' }]);
  });

  it('drops several StaticText children whose join equals the parent name', () => {
    const nodes = [
      ax('1', 'RootWebArea', { childIds: ['2'] }),
      ax('2', 'link', { name: 'Read the docs', backendDOMNodeId: 7, childIds: ['3', '4', '5'] }),
      ax('3', 'StaticText', { name: 'Read' }),
      ax('4', 'StaticText', { name: 'the' }),
      ax('5', 'StaticText', { name: 'docs' }),
    ];
    const tree = buildTree(nodes, counterRef());
    expect(tree).toEqual([{ role: 'link', name: 'Read the docs', ref: '@e1' }]);
  });

  it('keeps text children that add information beyond the parent name', () => {
    const nodes = [
      ax('1', 'RootWebArea', { childIds: ['2'] }),
      ax('2', 'listitem', { name: 'Chat', childIds: ['3', '4'] }),
      ax('3', 'StaticText', { name: 'Chat' }),
      ax('4', 'StaticText', { name: 'last message at 12:01' }),
    ];
    const tree = buildTree(nodes, counterRef());
    expect(tree).toEqual([
      {
        role: 'listitem',
        name: 'Chat',
        children: [{ role: 'StaticText', name: 'last message at 12:01' }],
      },
    ]);
  });

  it('keeps duplicate-named children that carry a ref (actionable beats tidy)', () => {
    const nodes = [
      ax('1', 'RootWebArea', { childIds: ['2'] }),
      ax('2', 'listitem', { name: 'Open', childIds: ['3'] }),
      ax('3', 'button', { name: 'Open', backendDOMNodeId: 9 }),
    ];
    const tree = buildTree(nodes, counterRef());
    expect(tree[0].children).toEqual([{ role: 'button', name: 'Open', ref: '@e1' }]);
  });

  it('keeps value and description on nodes', () => {
    const nodes = [
      ax('1', 'RootWebArea', { childIds: ['2'] }),
      ax('2', 'textbox', {
        name: 'Search',
        backendDOMNodeId: 3,
        value: { value: 'query' },
        description: { value: 'site search' },
      }),
    ];
    const tree = buildTree(nodes, counterRef());
    expect(tree).toEqual([
      {
        role: 'textbox',
        name: 'Search',
        value: 'query',
        description: 'site search',
        ref: '@e1',
      },
    ]);
  });
});

describe('collectInteractive', () => {
  it('flattens ref-bearing nodes in document order, dropping the rest', () => {
    const tree = [
      { role: 'main', children: [{ role: 'button', name: 'A', ref: '@e1' }] },
      { role: 'StaticText', name: 'noise' },
      { role: 'textbox', name: 'B', value: 'x', ref: '@e2' },
    ];
    expect(collectInteractive(tree)).toEqual([
      { ref: '@e1', role: 'button', name: 'A' },
      { ref: '@e2', role: 'textbox', name: 'B', value: 'x' },
    ]);
  });

  it('descends into ref-bearing containers', () => {
    const tree = [
      {
        role: 'listbox',
        ref: '@e1',
        children: [{ role: 'option', name: 'one', ref: '@e2' }],
      },
    ];
    expect(collectInteractive(tree).map((e) => e.ref)).toEqual(['@e1', '@e2']);
  });

  it('forwards the input type (DOM-sourced) so a password field is visible', () => {
    const tree = [
      { role: 'textbox', name: 'Password', type: 'password', ref: '@e1' },
      { role: 'textbox', name: 'Email', type: 'email', ref: '@e2' },
    ];
    expect(collectInteractive(tree)).toEqual([
      { ref: '@e1', role: 'textbox', name: 'Password', type: 'password' },
      { ref: '@e2', role: 'textbox', name: 'Email', type: 'email' },
    ]);
  });
});

describe('emission caps (the a11y path was the unbounded one)', () => {
  const node = (over: Partial<TreeNode> = {}): TreeNode => ({ role: 'button', ...over });

  it('keeps a small tree byte-identical', () => {
    const tree = [node({ name: 'Send' }), node({ name: 'Cancel' })];
    const out = capTree(tree, 10, 100);
    expect(out.truncated).toBe(false);
    expect(out.tree).toEqual(tree);
  });

  it('stops at the node budget and says so', () => {
    const tree = [node({ name: 'a' }), node({ name: 'b' }), node({ name: 'c' })];
    const out = capTree(tree, 2, 100);
    expect(out.truncated).toBe(true);
    expect(out.tree.map((n) => n.name)).toEqual(['a', 'b']);
  });

  it('counts nested nodes against the same budget, in document order', () => {
    const tree = [
      node({
        role: 'list',
        name: 'items',
        children: [node({ name: 'one' }), node({ name: 'two' })],
      }),
      node({ name: 'after' }),
    ];
    const out = capTree(tree, 2, 100);
    expect(out.truncated).toBe(true);
    // The parent and its first child fit; the second child and the sibling do
    // not. The parent KEEPS its row — an ancestor without its subtree is still
    // true, while dropping it would move survivors up a level.
    expect(out.tree).toEqual([
      { role: 'list', name: 'items', children: [{ role: 'button', name: 'one' }] },
    ]);
  });

  it('caps a long name without splitting a surrogate pair', () => {
    // A lone half is unsignable, and it would not fail the name — it discards
    // the WHOLE tool result as unserialisable_result.
    const name = 'a'.repeat(SNAPSHOT_MAX_TEXT - 1) + '🙂';
    const out = capTree([node({ name })], 10);
    // A trimmed string is NOT a truncation: the DOM walk has always cut names
    // silently with the ellipsis as the signal, and `truncated` means "there is
    // more of the page than this". Flagging here would fire on almost every
    // snapshot — and twice over on the DOM path, whose names arrive trimmed.
    expect(out.truncated).toBe(false);
    const got = out.tree[0].name as string;
    expect(got.endsWith('…')).toBe(true);
    expect([...got].every((ch) => ch.codePointAt(0)! < 0xd800 || ch.codePointAt(0)! > 0xdfff)).toBe(
      true,
    );
  });

  it('caps a string value but leaves a non-string one alone', () => {
    const out = capTree([node({ value: 'y'.repeat(20) }), node({ value: 42 })], 10, 5);
    expect(out.tree[0].value).toBe('yyyyy…');
    expect(out.tree[1].value).toBe(42);
  });

  it('capName is a no-op below the limit', () => {
    expect(capName('short', 10)).toBe('short');
  });

  it('caps the compact list by element count as well as text', () => {
    const els = [1, 2, 3].map((i) => ({ ref: `@e${i}`, role: 'button', name: 'x'.repeat(10) }));
    const out = capElements(els, 2, 4);
    expect(out.truncated).toBe(true); // an element was DROPPED — that is the flag
    expect(out.elements).toEqual([
      { ref: '@e1', role: 'button', name: 'xxxx…' },
      { ref: '@e2', role: 'button', name: 'xxxx…' },
    ]);
  });

  it('a compact list inside the caps is untouched and not flagged', () => {
    const els = [{ ref: '@e1', role: 'link', name: 'Home' }];
    expect(capElements(els, 5, 100)).toEqual({ elements: els, truncated: false });
  });

  it('trimming every name in a full-but-not-overflowing list raises no flag', () => {
    const els = [{ ref: '@e1', role: 'link', name: 'x'.repeat(50) }];
    expect(capElements(els, 5, 4).truncated).toBe(false);
  });
});

describe('frame nodes survive the empty-leaf pruning', () => {
  const ref: MakeRef = (id) => `e${id}`;

  it('keeps a nameless Iframe node — it is the only evidence of the gap', () => {
    // A frame's document is NOT in this tree, so pruning the host as an empty
    // leaf deleted the one thing telling the agent that the page's real content
    // is somewhere the snapshot cannot reach.
    const nodes: AXNode[] = [
      { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
      { nodeId: '2', role: { value: 'Iframe' } },
    ];
    expect(buildTree(nodes, ref)).toEqual([{ role: 'Iframe' }]);
  });

  it('still prunes ordinary empty leaves', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
      { nodeId: '2', role: { value: 'StaticText' } },
    ];
    expect(buildTree(nodes, ref)).toEqual([]);
  });

  it('isFrameRole covers the roles Chrome actually uses', () => {
    expect(isFrameRole('Iframe')).toBe(true);
    expect(isFrameRole('IframePresentational')).toBe(true);
    expect(isFrameRole('button')).toBe(false);
    expect(isFrameRole(undefined)).toBe(false);
  });
});
