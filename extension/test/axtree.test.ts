import { describe, expect, it } from 'vitest';

import { buildTree, collectInteractive, type AXNode, type MakeRef } from '../src/tools/axtree.js';

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
});
