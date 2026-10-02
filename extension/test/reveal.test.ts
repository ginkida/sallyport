/**
 * `reveal` with an `@eN` container, over a chrome-mocked CDP channel.
 *
 * This is the one tool that re-snapshots INSIDE its own loop, which makes it
 * the tool monotonic refs (refs.ts) can break: by the time the loop resolves
 * the container the ref map has been wiped and re-minted above the caller's id.
 * It only ever worked because the counter used to restart at `e1` and the walk
 * is deterministic — i.e. by accident. The fix pins the container's
 * browser-owned backendNodeId before the first snapshot; these tests pin that
 * it stays pinned, and that the loop's discarded passes cost the agent no ids.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { CALL_GROUP } from '../src/tools/cdp.js';

type Cmd = { method: string; params?: Record<string, unknown> };

let reveal: typeof import('../src/tools/reveal.js').reveal;
let newRef: typeof import('../src/tools/refs.js').newRef;
let clearRefsForTab: typeof import('../src/tools/refs.js').clearRefsForTab;
let refWatermark: typeof import('../src/tools/refs.js').refWatermark;
let setAllowlist: typeof import('../src/storage.js').setAllowlist;
let resetAttachedTabs: typeof import('../src/tools/cdp.js').resetAttachedTabs;

const TAB = 3;
const CONTAINER_BACKEND_ID = 900;
const LOADER = 'L1';

/** An a11y tree with enough interactive nodes that buildSnapshotTree trusts it
 * and never falls through to the DOM cross-check (MIN_TRUSTED_AX_REFS = 4). */
function axNodes(withTarget: boolean) {
  const buttons = ['Alpha', 'Beta', 'Gamma', 'Delta'].map((name, i) => ({
    nodeId: String(i + 2),
    role: { value: 'button' },
    name: { value: name },
    backendDOMNodeId: 100 + i,
  }));
  if (withTarget) {
    buttons.push({
      nodeId: '99',
      role: { value: 'button' },
      name: { value: 'Older' },
      backendDOMNodeId: 500,
    });
  }
  return [
    { nodeId: '1', role: { value: 'RootWebArea' }, childIds: buttons.map((b) => b.nodeId) },
    ...buttons,
  ];
}

/** Install a CDP channel that answers exactly what reveal issues. `foundAtStep`
 * is the pass on which the target finally appears. */
function installChrome(opts: {
  foundAtStep: number;
  urls?: string[];
  scrollHeight?: number;
  /** The main-frame loader id each `Page.getFrameTree` answers, the last one
   * repeating — i.e. which DOCUMENT the tab shows (refs.ts `loaderId`). */
  loaders?: string[];
}): Cmd[] {
  const sent: Cmd[] = [];
  let frameTrees = 0;
  let axCalls = 0;
  let scrollTop = 0;
  let tabGets = 0;
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
        // `urls` lets a test move the page under the loop: each call answers the
        // next entry, the last one repeating.
        const urls = opts.urls ?? ['https://chat.example.com/'];
        const url = urls[Math.min(tabGets++, urls.length - 1)];
        return { id: TAB, url, title: 'chat' };
      },
      onRemoved: { addListener() {} },
    },
    debugger: {
      async attach() {},
      async sendCommand(
        _target: { tabId: number },
        method: string,
        params?: Record<string, unknown>,
      ) {
        sent.push({ method, params });
        if (method === 'Page.getFrameTree') {
          const loaders = opts.loaders ?? [LOADER];
          return {
            frameTree: { frame: { loaderId: loaders[Math.min(frameTrees++, loaders.length - 1)] } },
          };
        }
        if (method === 'Accessibility.getFullAXTree') {
          const step = axCalls++;
          return { nodes: axNodes(step >= opts.foundAtStep) };
        }
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-container' } };
        if (
          method === 'Runtime.callFunctionOn' &&
          String(params?.functionDeclaration).includes('MutationObserver')
        ) {
          // The per-step settle's observer, installed on the container.
          return { result: { objectId: 'quiescence' } };
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          /this\.(sample|stop)\(/.test(String(params?.functionDeclaration))
        ) {
          // Quiescence observer — a steady reading so the per-step settle is
          // quick; its cleanup must not count as a scroll.
          return { result: { value: 0 } };
        }
        if (method === 'Runtime.callFunctionOn') {
          const before = scrollTop;
          scrollTop += 500;
          return {
            result: {
              value: {
                before,
                after: scrollTop,
                scrollHeight: opts.scrollHeight ?? 99_999,
                clientHeight: 500,
              },
            },
          };
        }
        if (method === 'Runtime.evaluate') return { result: { objectId: 'quiescence' } };
        return {};
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
  return sent;
}

beforeEach(async () => {
  installChrome({ foundAtStep: 0 });
  ({ reveal } = await import('../src/tools/reveal.js'));
  ({ newRef, clearRefsForTab, refWatermark } = await import('../src/tools/refs.js'));
  ({ setAllowlist } = await import('../src/storage.js'));
  ({ resetAttachedTabs } = await import('../src/tools/cdp.js'));
  resetAttachedTabs();
  clearRefsForTab(TAB);
});

async function allowChat(): Promise<void> {
  await setAllowlist([{ pattern: 'chat.example.com', allowEvaluate: false, addedAt: 0 }]);
}

describe('reveal with an @eN container', () => {
  it('resolves a container ref that its OWN snapshot has already renumbered away', async () => {
    const sent = installChrome({ foundAtStep: 2 });
    await allowChat();
    // The ref the agent holds from an earlier snapshot.
    const container = '@' + newRef(TAB, CONTAINER_BACKEND_ID, 'list', 'messages', LOADER);

    const out = (await reveal(
      { container, role: 'button', name: 'Older', tabId: TAB },
      undefined,
    )) as { data: { found: boolean; steps: number } };

    expect(out.data.found).toBe(true);
    // It scrolled, which means the container resolved on every pass — the
    // regression made the very first resolve throw bad_ref.
    expect(out.data.steps).toBe(2);
    const resolves = sent.filter((c) => c.method === 'DOM.resolveNode');
    expect(resolves).toHaveLength(2);
    // …and by the browser-owned id, never by a nodeId from the wiped ref map —
    // into the per-call group, so the per-pass handles are released on idle
    // instead of each pinning the list as it was on that pass.
    for (const r of resolves) {
      expect(r.params).toEqual({ backendNodeId: CONTAINER_BACKEND_ID, objectGroup: CALL_GROUP });
    }
  });

  it('still refuses a container ref this tab never minted', async () => {
    installChrome({ foundAtStep: 0 });
    await allowChat();
    await expect(
      reveal({ container: '@e999', role: 'button', name: 'Older', tabId: TAB }, undefined),
    ).rejects.toMatchObject({ code: 'bad_ref' });
  });

  it('refuses the pinned container once the page navigated mid-reveal, before scrolling a node of the new page', async () => {
    // Per pass: one frame-tree read stamps the pass's snapshot, one checks the
    // container's resolve. The document changes on the SECOND pass's check —
    // after a cross-process navigation the old backendNodeId still resolves
    // (the mock answers resolveNode happily), to a node of the NEW document.
    const sent = installChrome({ foundAtStep: 99, loaders: [LOADER, LOADER, LOADER, 'L2'] });
    await allowChat();
    const container = '@' + newRef(TAB, CONTAINER_BACKEND_ID, 'list', 'messages', LOADER);

    await expect(
      reveal({ container, role: 'button', name: 'Older', tabId: TAB }, undefined),
    ).rejects.toMatchObject({ code: 'bad_ref', message: expect.stringContaining('navigated') });
    const scrolls = sent.filter(
      (c) =>
        c.method === 'Runtime.callFunctionOn' &&
        !/this\.(sample|stop)\(|MutationObserver/.test(String(c.params?.functionDeclaration)),
    );
    // Exactly the first pass's scroll: nothing was sent to the foreign node.
    expect(scrolls).toHaveLength(1);
    expect(sent.filter((c) => c.method === 'DOM.resolveNode')).toHaveLength(2);
  });

  it('charges the agent only for the refs it actually returns, not one set per scroll step', async () => {
    installChrome({ foundAtStep: 3 });
    await allowChat();
    const container = '@' + newRef(TAB, CONTAINER_BACKEND_ID, 'list', 'messages', LOADER);
    const before = refWatermark(TAB);

    const out = (await reveal(
      { container, role: 'button', name: 'Older', tabId: TAB },
      undefined,
    )) as { data: { found: boolean; matches: Array<{ ref: string }> } };

    expect(out.data.found).toBe(true);
    // Four passes ran; only the matching one's refs survive, so the counter
    // advanced by ONE snapshot's worth (5 buttons), not four.
    expect(refWatermark(TAB) - before).toBe(5);
    for (const m of out.data.matches) {
      expect(Number(m.ref.replace('@e', ''))).toBeGreaterThan(before);
    }
  });
});

describe('reveal — the page must stay allowlisted for the WHOLE scroll (invariant #3)', () => {
  it('stops when the page navigates off the allowlist mid-loop', async () => {
    // reveal scrolls and re-snapshots up to forty times, returning roles and
    // names out of each pass. Gating only at entry meant one check licensed
    // every later read — including of a page the tab drifted onto seconds
    // later (an SSO bounce, a consent wall, the site's own redirect).
    const chat = 'https://chat.example.com/';
    const sent = installChrome({
      // Never found, so only the drift can end the loop; the tab moves on the
      // THIRD pass, proving the check runs every pass and not just at entry.
      foundAtStep: 99,
      urls: [chat, chat, chat, chat, 'https://elsewhere.example/inbox'],
    });
    await allowChat();
    const container = '@' + newRef(TAB, CONTAINER_BACKEND_ID, 'list', 'messages', LOADER);

    await expect(
      reveal({ container, role: 'button', name: 'Older', tabId: TAB }, undefined),
    ).rejects.toMatchObject({ code: 'domain_not_allowed' });
    // It really was mid-loop: passes had already run and scrolled the list.
    const scrolls = sent.filter(
      (c) =>
        c.method === 'Runtime.callFunctionOn' &&
        !/this\.(sample|stop)\(|MutationObserver/.test(String(c.params?.functionDeclaration)),
    );
    expect(scrolls.length).toBeGreaterThan(0);
  });

  it('keeps going while the page stays put, and reports the url it read', async () => {
    installChrome({ foundAtStep: 2 });
    await allowChat();
    const container = '@' + newRef(TAB, CONTAINER_BACKEND_ID, 'list', 'messages', LOADER);

    const res = await reveal({ container, role: 'button', name: 'Older', tabId: TAB }, undefined);
    const data = res.data as { found: boolean; steps: number };
    expect(data.found).toBe(true);
    expect(data.steps).toBe(2);
    // The url is re-read each pass now, so it describes the page the result
    // came off rather than the one the call started on.
    expect(res.url).toBe('https://chat.example.com/');
  });

  it('waits between steps on the CONTAINER, not the whole document', async () => {
    // A document-wide observer made a ticking clock anywhere on the page cost
    // every step the full settle budget; the rows live in the container.
    const sent = installChrome({ foundAtStep: 2 });
    await allowChat();
    const container = '@' + newRef(TAB, CONTAINER_BACKEND_ID, 'list', 'messages', LOADER);
    await reveal({ container, role: 'button', name: 'Older', tabId: TAB }, undefined);
    const observers = sent.filter((c) =>
      String(c.params?.functionDeclaration).includes('MutationObserver'),
    );
    expect(observers).toHaveLength(2); // one per scroll step
    for (const c of observers) {
      expect(c.method).toBe('Runtime.callFunctionOn');
      expect(c.params).toMatchObject({
        objectId: 'obj-container',
        objectGroup: 'sallyport-settle',
      });
    }
    expect(sent.some((c) => c.method === 'Runtime.evaluate')).toBe(false);
  });

  it('waits on the whole document for a step that reaches the end of the container', async () => {
    // An infinite feed fetches its next page at the bottom, often behind a
    // progress bar OUTSIDE the container while the container sits unchanged —
    // a scoped wait would snapshot before the rows land and call it a stall.
    // Container is 500 px tall over 1500 px: the 2nd step (to 1000) is the end.
    const sent = installChrome({ foundAtStep: 2, scrollHeight: 1500 });
    await allowChat();
    const container = '@' + newRef(TAB, CONTAINER_BACKEND_ID, 'list', 'messages', LOADER);
    await reveal({ container, role: 'button', name: 'Older', tabId: TAB }, undefined);
    const creates = sent.filter(
      (c) =>
        c.method === 'Runtime.evaluate' ||
        String(c.params?.functionDeclaration).includes('MutationObserver'),
    );
    expect(creates.map((c) => c.method)).toEqual(['Runtime.callFunctionOn', 'Runtime.evaluate']);
  });
});

describe('standalone polls spend what the CALL has left, and survive a navigation tick', () => {
  it('find with timeoutMs treats a tick that lost its document as unread', async () => {
    const sent = installChrome({ foundAtStep: 2 });
    await allowChat();
    const send = chrome.debugger.sendCommand as unknown as (
      t: unknown,
      m: string,
      p?: unknown,
    ) => Promise<unknown>;
    let ax = 0;
    (chrome.debugger as unknown as { sendCommand: typeof send }).sendCommand = async (t, m, p) => {
      if (m === 'Accessibility.getFullAXTree' && ax++ === 1) {
        throw new Error('Cannot find context with specified id');
      }
      return send(t, m, p);
    };
    const { find } = await import('../src/tools/find.js');
    const res = await find({
      role: 'button',
      name: 'Older',
      mode: 'a11y',
      timeoutMs: 5000,
      tabId: TAB,
    });
    expect((res.data as { total: number }).total).toBe(1);
    expect(
      sent.filter((c) => c.method === 'Accessibility.getFullAXTree').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('find still fails on an error that is not a lost document', async () => {
    installChrome({ foundAtStep: 2 });
    await allowChat();
    (chrome.debugger as unknown as { sendCommand: unknown }).sendCommand = async () => {
      throw new Error('Debugger is not attached to the tab with id: 7.');
    };
    const { find } = await import('../src/tools/find.js');
    await expect(
      find({ role: 'button', name: 'Older', mode: 'a11y', timeoutMs: 5000, tabId: TAB }),
    ).rejects.toThrow('Debugger is not attached');
  });

  it('find clamps its poll to the budget and says so', async () => {
    installChrome({ foundAtStep: 99 });
    await allowChat();
    const { find } = await import('../src/tools/find.js');
    const t0 = Date.now();
    const res = await find(
      { role: 'button', name: 'Older', mode: 'a11y', timeoutMs: 30_000, tabId: TAB },
      { startedAt: t0 - 49_000 },
    );
    expect(res.data).toMatchObject({ total: 0, budgetLimited: true });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('a batched find flags the budget cut too', async () => {
    installChrome({ foundAtStep: 99 });
    await allowChat();
    const { find } = await import('../src/tools/find.js');
    const res = await find(
      {
        queries: [
          { role: 'button', name: 'Older' },
          { role: 'button', name: 'Newer' },
        ],
        mode: 'a11y',
        timeoutMs: 30_000,
        tabId: TAB,
      },
      { startedAt: Date.now() - 49_000 },
    );
    expect(res.data).toMatchObject({ budgetLimited: true });
  });

  it('a navigation on the LAST tick is a clear error, not a raw CDP message', async () => {
    installChrome({ foundAtStep: 99 });
    await allowChat();
    const send = chrome.debugger.sendCommand as unknown as (
      t: unknown,
      m: string,
      p?: unknown,
    ) => Promise<unknown>;
    (chrome.debugger as unknown as { sendCommand: typeof send }).sendCommand = async (t, m, p) => {
      if (m === 'Accessibility.getFullAXTree') {
        throw new Error('Cannot find context with specified id');
      }
      return send(t, m, p);
    };
    const { find } = await import('../src/tools/find.js');
    await expect(
      find({ role: 'button', name: 'Older', mode: 'a11y', timeoutMs: 600, tabId: TAB }),
    ).rejects.toThrow(/navigated during the last poll/);
  });

  it('reveal clamps its loop to the budget and says so', async () => {
    installChrome({ foundAtStep: 99 });
    await allowChat();
    const t0 = Date.now();
    const res = await reveal(
      { container: '#list', role: 'button', name: 'Older', timeoutMs: 30_000, tabId: TAB },
      { startedAt: t0 - 49_000 },
    );
    expect(res.data).toMatchObject({ found: false, budgetLimited: true });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});
