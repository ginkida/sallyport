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

type Cmd = { method: string; params?: Record<string, unknown> };

let reveal: typeof import('../src/tools/reveal.js').reveal;
let newRef: typeof import('../src/tools/refs.js').newRef;
let clearRefsForTab: typeof import('../src/tools/refs.js').clearRefsForTab;
let refWatermark: typeof import('../src/tools/refs.js').refWatermark;
let setAllowlist: typeof import('../src/storage.js').setAllowlist;
let resetAttachedTabs: typeof import('../src/tools/cdp.js').resetAttachedTabs;

const TAB = 3;
const CONTAINER_BACKEND_ID = 900;

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
function installChrome(opts: { foundAtStep: number }): Cmd[] {
  const sent: Cmd[] = [];
  let axCalls = 0;
  let scrollTop = 0;
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
        return { id: TAB, url: 'https://chat.example.com/', title: 'chat' };
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
        if (method === 'Accessibility.getFullAXTree') {
          const step = axCalls++;
          return { nodes: axNodes(step >= opts.foundAtStep) };
        }
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-container' } };
        if (method === 'Runtime.callFunctionOn') {
          const before = scrollTop;
          scrollTop += 500;
          return { result: { value: { before, after: scrollTop, scrollHeight: 99_999 } } };
        }
        if (method === 'Runtime.evaluate') {
          // Quiescence probe — a steady reading so the per-step settle is quick.
          return { result: { value: { n: 10, len: 100 } } };
        }
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
    const container = '@' + newRef(TAB, CONTAINER_BACKEND_ID, 'list', 'messages');

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
    // …and by the browser-owned id, never by a nodeId from the wiped ref map.
    for (const r of resolves) {
      expect(r.params).toEqual({ backendNodeId: CONTAINER_BACKEND_ID });
    }
  });

  it('still refuses a container ref this tab never minted', async () => {
    installChrome({ foundAtStep: 0 });
    await allowChat();
    await expect(
      reveal({ container: '@e999', role: 'button', name: 'Older', tabId: TAB }, undefined),
    ).rejects.toMatchObject({ code: 'bad_ref' });
  });

  it('charges the agent only for the refs it actually returns, not one set per scroll step', async () => {
    installChrome({ foundAtStep: 3 });
    await allowChat();
    const container = '@' + newRef(TAB, CONTAINER_BACKEND_ID, 'list', 'messages');
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
