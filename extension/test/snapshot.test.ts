/**
 * The DOM-path snapshot's ref minting, over a mocked CDP channel.
 *
 * One `DOM.describeNode` per element, and there can be hundreds — so they are
 * now issued in bounded parallel batches. The safety claim that makes that
 * sound is: describes may COMPLETE in any order, but `@eN` numbering happens
 * afterwards, walking the document-ordered list. This test drives the real
 * function with a channel that answers describes in REVERSE, which is exactly
 * the case a naive `Promise.all` + mint-on-resolve would get wrong.
 *
 * Concurrency is safe here in a way it is not for `DOM.getDocument`: that
 * command discards every nodeId handed out so far (which is how a batched
 * `get_state` broke), while `describeNode` invalidates nothing and we read only
 * the browser-owned `backendNodeId`.
 */

import { beforeAll, describe, expect, it } from 'vitest';

let snapshot: (a: Record<string, unknown>, c?: unknown) => Promise<unknown>;
let getRef: typeof import('../src/tools/refs.js').getRef;
let clearRefsForTab: typeof import('../src/tools/refs.js').clearRefsForTab;
let setAllowlist: typeof import('../src/storage.js').setAllowlist;
let resetAttachedTabs: typeof import('../src/tools/cdp.js').resetAttachedTabs;

const TAB = 77;

/** N interactive nodes in document order, nested so the walk has to recurse. */
function fixtureTree(n: number) {
  const leaf = (i: number) => ({ role: 'button', name: `btn${i}`, idx: i });
  return [
    { role: 'group', name: 'top', children: [leaf(0), leaf(1)] },
    {
      role: 'group',
      name: 'mid',
      children: [leaf(2), { role: 'group', name: 'deep', children: [leaf(3)] }],
    },
    ...Array.from({ length: n - 4 }, (_, k) => leaf(k + 4)),
  ];
}

/** A channel that answers describes in REVERSE completion order. */
function installChrome(nodeCount: number): { describeOrder: number[] } {
  const describeOrder: number[] = [];
  const store = new Map<string, unknown>();
  const tree = fixtureTree(nodeCount);
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        async get(keys: string | string[]) {
          const out: Record<string, unknown> = {};
          for (const k of Array.isArray(keys) ? keys : [keys])
            if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        async set(obj: Record<string, unknown>) {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
        async remove() {},
      },
      session: {
        async get() {
          return {};
        },
        async set() {},
      },
    },
    tabs: {
      async get() {
        return { id: TAB, url: 'https://app.example.com/', title: 'app' };
      },
      onRemoved: { addListener() {} },
    },
    debugger: {
      async attach() {},
      async sendCommand(_t: unknown, method: string, params?: Record<string, unknown>) {
        if (method === 'Runtime.evaluate') return { result: { objectId: 'probe' } };
        if (method === 'Runtime.callFunctionOn') {
          const fn = String(params?.functionDeclaration ?? '');
          if (fn.includes('this.tree')) return { result: { value: { tree, truncated: false } } };
          if (fn.includes('this.els')) return { result: { objectId: 'els' } };
          return { result: { value: {} } };
        }
        if (method === 'Runtime.getProperties') {
          return {
            result: Array.from({ length: nodeCount }, (_, i) => ({
              name: String(i),
              value: { objectId: `el${i}` },
            })),
          };
        }
        if (method === 'DOM.describeNode') {
          const i = Number(String(params?.objectId).replace('el', ''));
          // Later elements resolve FIRST: a mint-on-resolve implementation
          // would number them backwards.
          const delay = (nodeCount - i) % 7;
          return new Promise((resolve) => {
            setTimeout(() => {
              describeOrder.push(i);
              resolve({ node: { backendNodeId: 1000 + i } });
            }, delay);
          });
        }
        return {};
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
  return { describeOrder };
}

beforeAll(async () => {
  installChrome(4);
  ({ snapshot } = (await import('../src/tools/snapshot.js')) as unknown as {
    snapshot: typeof snapshot;
  });
  ({ getRef, clearRefsForTab } = await import('../src/tools/refs.js'));
  ({ setAllowlist } = await import('../src/storage.js'));
  ({ resetAttachedTabs } = await import('../src/tools/cdp.js'));
});

describe('DOM-path ref minting', () => {
  it('numbers refs in DOCUMENT order however the describes come back', async () => {
    const N = 30;
    const { describeOrder } = installChrome(N);
    resetAttachedTabs();
    clearRefsForTab(TAB);
    await setAllowlist([{ pattern: 'app.example.com', allowEvaluate: false, addedAt: 0 }]);

    const out = (await snapshot({ mode: 'dom', compact: true, tabId: TAB }, undefined)) as {
      data: { elements: Array<{ ref: string; name: string }> };
    };

    // The channel really did answer out of order — otherwise this test proves
    // nothing about the ordering guarantee.
    expect(describeOrder).not.toEqual([...describeOrder].sort((a, b) => a - b));

    // Refs run e1..eN in document order, and each maps to ITS OWN element.
    const els = out.data.elements;
    expect(els).toHaveLength(N);
    els.forEach((e, i) => {
      expect(e.name).toBe(`btn${i}`);
      expect(e.ref).toBe(`@e${i + 1}`);
      expect(getRef(TAB, e.ref)).toMatchObject({ backendDOMNodeId: 1000 + i, name: `btn${i}` });
    });
  });

  it('leaves an element that died between probe and describe without a ref, not mis-numbered', async () => {
    installChrome(6);
    resetAttachedTabs();
    clearRefsForTab(TAB);
    await setAllowlist([{ pattern: 'app.example.com', allowEvaluate: false, addedAt: 0 }]);
    const chrome = (globalThis as unknown as { chrome: { debugger: Record<string, unknown> } })
      .chrome;
    const inner = chrome.debugger.sendCommand as (
      t: unknown,
      m: string,
      p?: Record<string, unknown>,
    ) => Promise<unknown>;
    chrome.debugger.sendCommand = async (t: unknown, m: string, p?: Record<string, unknown>) => {
      if (m === 'DOM.describeNode' && String(p?.objectId) === 'el2')
        throw new Error('No node found');
      return inner(t, m, p);
    };

    const out = (await snapshot({ mode: 'dom', compact: true, tabId: TAB }, undefined)) as {
      data: { elements: Array<{ ref: string; name: string }> };
    };
    // The dead one is simply absent from the actionable list; the survivors
    // keep contiguous ids in document order.
    expect(out.data.elements.map((e) => e.name)).toEqual(['btn0', 'btn1', 'btn3', 'btn4', 'btn5']);
    expect(out.data.elements.map((e) => e.ref)).toEqual(['@e1', '@e2', '@e3', '@e4', '@e5']);
  });
});
