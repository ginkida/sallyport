/**
 * A ref never crosses a navigation the PAGE started (invariant #7).
 *
 * A link, a form submit or a script redirect goes through no tool that wipes
 * the ref map, and a backendNodeId is only unique within one renderer process:
 * after a cross-process navigation the new process numbers its nodes from 1
 * again, and the old ids resolve to LIVE nodes of the new document (measured on
 * Chrome 154: 41 of 41 old ids, `DOM.resolveNode` + `callFunctionOn`, after any
 * call that mints ids on the new page). So every ref is stamped with the main
 * frame's loader id of the document it was minted in (refs.ts), and every
 * resolve compares it with the tab's current one — AFTER the resolve, BEFORE
 * the action (resolve.ts:refDocumentState).
 *
 * Chrome-mocked: the mock resolves ANY backendNodeId, which is exactly the
 * hostile case — only the loader id tells the documents apart.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TAB = 41;
type Cmd = { method: string; params?: Record<string, unknown> };

let loader: string | Error | 'hang' = 'L1';

function installChrome(): Cmd[] {
  const sent: Cmd[] = [];
  const store = new Map<string, unknown>();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        async get(keys: string | string[]) {
          const out: Record<string, unknown> = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            if (store.has(k)) out[k] = store.get(k);
          }
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
        return { id: TAB, url: 'http://127.0.0.1:8080/account', title: 'account' };
      },
      onRemoved: { addListener() {} },
    },
    debugger: {
      async attach() {},
      async sendCommand(_t: unknown, method: string, params: Record<string, unknown> = {}) {
        sent.push({ method, params });
        if (method === 'Page.getFrameTree') {
          if (loader instanceof Error) throw loader;
          if (loader === 'hang') return new Promise(() => {}); // a renderer that never answers
          return { frameTree: { frame: { id: 'top', loaderId: loader } } };
        }
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelector') return { nodeId: 0 };
        // Whatever id is asked for resolves — as an old id does on a new process.
        if (method === 'DOM.resolveNode') return { object: { objectId: 'node' } };
        if (method === 'Runtime.callFunctionOn') {
          return { result: { value: { tag: 'BUTTON', text: 'Delete account' } } };
        }
        return {};
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
  return sent;
}

async function setup(): Promise<{
  sent: Cmd[];
  refs: typeof import('../src/tools/refs.js');
  dom: typeof import('../src/tools/dom.js');
}> {
  const sent = installChrome();
  const { setAllowlist } = await import('../src/storage.js');
  const { resetAttachedTabs } = await import('../src/tools/cdp.js');
  resetAttachedTabs();
  await setAllowlist([{ pattern: '127.0.0.1', allowEvaluate: false, addedAt: 0 }]);
  const refs = await import('../src/tools/refs.js');
  refs.clearRefsForTab(TAB);
  const dom = await import('../src/tools/dom.js');
  return { sent, refs, dom };
}

const actions = (sent: Cmd[]) => sent.filter((c) => c.method === 'Runtime.callFunctionOn');

beforeEach(() => {
  loader = 'L1';
});

describe('a ref is bound to the document it was minted in', () => {
  it('refuses a ref from a navigated-away document as bad_ref, and never acts on the node', async () => {
    const { sent, refs, dom } = await setup();
    const ref = '@' + refs.newRef(TAB, 7, 'button', 'Delete account', 'L1');
    loader = 'L2'; // the page navigated itself (e.g. a link to another site)

    await expect(dom.click({ selector: ref, tabId: TAB }, undefined)).rejects.toMatchObject({
      code: 'bad_ref',
      message: expect.stringContaining('navigated'),
    });
    expect(actions(sent)).toHaveLength(0);
    // Checked AFTER the resolve: a resolve that reached the new document is
    // caught by a loader id read later.
    const methods = sent.map((c) => c.method);
    expect(methods.indexOf('Page.getFrameTree')).toBeGreaterThan(
      methods.indexOf('DOM.resolveNode'),
    );
    // …and the next ref is a NEW number: the held one can never come back.
    const next = refs.newRef(TAB, 8, 'button', 'Other', 'L2');
    expect(Number(next.slice(1))).toBeGreaterThan(Number(ref.slice(2)));
  });

  it('keeps a ref across same-document navigation (pushState keeps the loader id)', async () => {
    const { sent, refs, dom } = await setup();
    const ref = '@' + refs.newRef(TAB, 7, 'button', 'Next', 'L1');
    const out = (await dom.click({ selector: ref, tabId: TAB }, undefined)) as {
      data: { ok: boolean };
    };
    expect(out.data.ok).toBe(true);
    expect(actions(sent)).toHaveLength(1);
  });

  it('fails closed when the browser will not say which document the tab shows', async () => {
    const { sent, refs, dom } = await setup();
    const ref = '@' + refs.newRef(TAB, 7, 'button', 'Delete account', 'L1');
    loader = new Error('Page.getFrameTree failed');
    await expect(dom.click({ selector: ref, tabId: TAB }, undefined)).rejects.toThrow(
      'Page.getFrameTree failed',
    );
    expect(actions(sent)).toHaveLength(0);
  });

  it('fails closed as bad_ref when the answer is lost to a navigation mid-question', async () => {
    const { sent, refs, dom } = await setup();
    const ref = '@' + refs.newRef(TAB, 7, 'button', 'Delete account', 'L1');
    loader = new Error('Inspected target navigated or closed');
    await expect(dom.click({ selector: ref, tabId: TAB }, undefined)).rejects.toMatchObject({
      code: 'bad_ref',
      message: expect.stringContaining('could not confirm'),
    });
    expect(actions(sent)).toHaveLength(0);
  });

  // Page.getFrameTree is answered by the RENDERER: a hung page never answers,
  // and an unbounded gate held the tab's call queue to the daemon's 60 s.
  it('bounds the question by what the call has left, and fails closed when time runs out', async () => {
    const { sent, refs, dom } = await setup();
    const ref = '@' + refs.newRef(TAB, 7, 'button', 'Delete account', 'L1');
    loader = 'hang';
    const began = Date.now();
    // 49.95 s of the 50 s budget already spent: 50 ms left for the question.
    await expect(
      dom.click({ selector: ref, tabId: TAB }, { startedAt: Date.now() - 49_950 }),
    ).rejects.toMatchObject({
      code: 'bad_ref',
      message: expect.stringContaining('could not confirm'),
    });
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(actions(sent)).toHaveLength(0);
  });

  it('caps the question at REF_DOCUMENT_DEADLINE_MS even with budget to spare', async () => {
    vi.useFakeTimers();
    try {
      const { sent, refs, dom } = await setup();
      const { REF_DOCUMENT_DEADLINE_MS } = await import('../src/tools/resolve.js');
      const ref = '@' + refs.newRef(TAB, 7, 'button', 'Delete account', 'L1');
      loader = 'hang';
      const pending = dom.click({ selector: ref, tabId: TAB }, { startedAt: Date.now() });
      const rejected = expect(pending).rejects.toMatchObject({ code: 'bad_ref' });
      await vi.advanceTimersByTimeAsync(REF_DOCUMENT_DEADLINE_MS + 10);
      await rejected;
      expect(REF_DOCUMENT_DEADLINE_MS).toBeLessThanOrEqual(5_000);
      expect(actions(sent)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never resolves a ref minted without a document stamp', async () => {
    const { sent, refs, dom } = await setup();
    const ref = '@' + refs.newRef(TAB, 7, 'button', 'Delete account', null);
    await expect(dom.click({ selector: ref, tabId: TAB }, undefined)).rejects.toMatchObject({
      code: 'bad_ref',
    });
    expect(actions(sent)).toHaveLength(0);
  });

  it('read_text refuses the same way, reading nothing off the foreign node', async () => {
    const { sent, refs, dom } = await setup();
    const ref = '@' + refs.newRef(TAB, 7, 'heading', 'Balance', 'L1');
    loader = 'L2';
    await expect(dom.readText({ ref, tabId: TAB }, undefined)).rejects.toMatchObject({
      code: 'bad_ref',
    });
    expect(actions(sent)).toHaveLength(0);
  });

  it('a CSS selector needs no document check — it always means the CURRENT document', async () => {
    const { sent, dom } = await setup();
    loader = 'L2';
    // The mock finds nothing for the query; what matters is what was not asked.
    await expect(dom.click({ selector: '#next', tabId: TAB }, undefined)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(sent.some((c) => c.method === 'Page.getFrameTree')).toBe(false);
  });
});
