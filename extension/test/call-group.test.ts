/**
 * Every remote object a tool mints lands in a GROUP somebody releases.
 *
 * A handle minted without `objectGroup` lives until its execution context dies
 * or the debugger detaches, and it pins whatever it points at: a resolved row
 * of a virtualised list keeps the whole unmounted SPA view alive (measured: 2000
 * groupless resolves on removed rows held ~69k DOM nodes, +40 MB, in the
 * renderer). The per-call handles therefore go into `CALL_GROUP`, which the idle
 * hygiene flush (cdp.ts) releases; tools with their own group (snapshot, mouse
 * aim, fill guard, waits, settle) release theirs in a `finally` — and that
 * `finally` has to cover the FIRST command too, since a probe that throws in
 * the page still mints its exception object into the group.
 *
 * `Runtime.callFunctionOn` is not listed: called on an objectId without its own
 * `objectGroup`, it inherits the receiver's group, so a grouped receiver is
 * enough.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CALL_GROUP } from '../src/tools/cdp.js';

const TAB = 23;
type Cmd = { method: string; params?: Record<string, unknown> };
type Respond = (method: string, params: Record<string, unknown>) => unknown;

function installChrome(respond: Respond = () => undefined): Cmd[] {
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
        return { id: TAB, url: 'https://app.example.com/', title: 'app' };
      },
      onRemoved: { addListener() {} },
    },
    debugger: {
      async attach() {},
      async sendCommand(_t: unknown, method: string, params: Record<string, unknown> = {}) {
        sent.push({ method, params });
        const custom = respond(method, params);
        if (custom !== undefined) return custom;
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelector') return { nodeId: 2 };
        if (method === 'DOM.resolveNode') return { object: { objectId: 'el' } };
        if (method === 'Runtime.evaluate') {
          return params.returnByValue
            ? { result: { type: 'object', value: { status: 200, data: 'ok' } } }
            : { result: { objectId: 'doc' } };
        }
        if (method === 'Runtime.callFunctionOn') return { result: { value: {} } };
        return {};
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
  return sent;
}

async function allow(allowEvaluate = false): Promise<void> {
  const { setAllowlist } = await import('../src/storage.js');
  const { resetAttachedTabs } = await import('../src/tools/cdp.js');
  resetAttachedTabs();
  await setAllowlist([{ pattern: 'app.example.com', allowEvaluate, addedAt: 0 }]);
}

async function refFor(backendNodeId: number): Promise<string> {
  const { newRef, clearRefsForTab } = await import('../src/tools/refs.js');
  clearRefsForTab(TAB);
  return '@' + newRef(TAB, backendNodeId, 'button', 'Save');
}

/** Every command that can mint a remote object, with the group it asked for. */
function minted(sent: Cmd[]): Array<{ method: string; group: unknown }> {
  return sent
    .filter((c) => c.method === 'DOM.resolveNode' || c.method === 'Runtime.evaluate')
    .map((c) => ({ method: c.method, group: c.params?.objectGroup }));
}

describe('per-call handles go into CALL_GROUP', () => {
  it('is the fixed name the idle flush releases', () => {
    expect(CALL_GROUP).toBe('sallyport-call');
  });

  it('resolves a CSS selector into the group (click)', async () => {
    const sent = installChrome((m) =>
      m === 'Runtime.callFunctionOn' ? { result: { value: { tag: 'BUTTON' } } } : undefined,
    );
    await allow();
    const { click } = await import('../src/tools/dom.js');
    await click({ tabId: TAB, selector: '#save' }, undefined);
    expect(minted(sent)).toEqual([{ method: 'DOM.resolveNode', group: CALL_GROUP }]);
  });

  it('resolves an @eN ref into the group (click)', async () => {
    const sent = installChrome((m) =>
      m === 'Runtime.callFunctionOn' ? { result: { value: { tag: 'BUTTON' } } } : undefined,
    );
    await allow();
    const ref = await refFor(501);
    const { click } = await import('../src/tools/dom.js');
    await click({ tabId: TAB, selector: ref }, undefined);
    const resolves = sent.filter((c) => c.method === 'DOM.resolveNode');
    expect(resolves).toHaveLength(1);
    expect(resolves[0].params).toMatchObject({ backendNodeId: 501, objectGroup: CALL_GROUP });
  });

  it('get_state groups both its CSS and its ref resolves', async () => {
    const sent = installChrome((m) =>
      m === 'Runtime.callFunctionOn'
        ? {
            result: {
              value: { tag: 'DIV', textLen: 2, text: 'ok', x: 0, y: 0, width: 1, height: 1 },
            },
          }
        : undefined,
    );
    await allow();
    const ref = await refFor(77);
    const { getState } = await import('../src/tools/state.js');
    await getState({ tabId: TAB, selector: ['#dialog', ref] }, undefined);
    expect(minted(sent)).toEqual([
      { method: 'DOM.resolveNode', group: CALL_GROUP },
      { method: 'DOM.resolveNode', group: CALL_GROUP },
    ]);
  });

  it('read_text groups the body handle and a ref handle', async () => {
    const sent = installChrome((m) =>
      m === 'Runtime.callFunctionOn' ? { result: { value: 'hello' } } : undefined,
    );
    await allow();
    const { readText } = await import('../src/tools/dom.js');
    await readText({ tabId: TAB }, undefined);
    const ref = await refFor(9);
    await readText({ tabId: TAB, ref }, undefined);
    expect(minted(sent)).toEqual([
      { method: 'DOM.resolveNode', group: CALL_GROUP },
      { method: 'DOM.resolveNode', group: CALL_GROUP },
    ]);
  });

  it("scroll groups the page's scrolling element", async () => {
    const sent = installChrome((m) =>
      m === 'Runtime.callFunctionOn'
        ? { result: { value: { x: 0, y: 100, scrollHeight: 2000, clientHeight: 800 } } }
        : undefined,
    );
    await allow();
    const { scroll } = await import('../src/tools/scroll.js');
    await scroll({ tabId: TAB, dy: 100 }, undefined);
    expect(minted(sent)).toEqual([{ method: 'Runtime.evaluate', group: CALL_GROUP }]);
  });

  it("mouse_click's coordinate check groups its document handle", async () => {
    const sent = installChrome((m) =>
      m === 'Runtime.callFunctionOn'
        ? { result: { value: { vw: 1280, vh: 800, tag: 'DIV' } } }
        : undefined,
    );
    await allow();
    const { mouseClick } = await import('../src/tools/mouse.js');
    await mouseClick({ tabId: TAB, x: 10, y: 10 }, undefined);
    expect(minted(sent)).toEqual([{ method: 'Runtime.evaluate', group: CALL_GROUP }]);
  });

  it('evaluate and fetch_in_page group what a throw would mint', async () => {
    // returnByValue still wraps a thrown value as a remote object, and an
    // abandoned awaitPromise keeps its promise strong until its group goes.
    const sent = installChrome();
    await allow(true);
    const { evaluate } = await import('../src/tools/evaluate.js');
    const { fetchInPage } = await import('../src/tools/fetch.js');
    await evaluate({ tabId: TAB, code: '1 + 1' }, undefined);
    await fetchInPage({ tabId: TAB, url: '/api/x' }, undefined);
    expect(minted(sent)).toEqual([
      { method: 'Runtime.evaluate', group: CALL_GROUP },
      { method: 'Runtime.evaluate', group: CALL_GROUP },
    ]);
  });
});

describe('own-group probes release their group even when the FIRST command fails', () => {
  const released = (sent: Cmd[], group: string) =>
    sent.filter((c) => c.method === 'Runtime.releaseObjectGroup' && c.params?.objectGroup === group)
      .length;

  it('snapshot: a DOM probe that throws in the page still releases sallyport_snapshot', async () => {
    const sent = installChrome((m) =>
      m === 'Runtime.evaluate'
        ? {
            result: { objectId: 'thrown' },
            exceptionDetails: { text: 'Uncaught', exception: { description: 'boom' } },
          }
        : undefined,
    );
    await allow();
    const { buildSnapshotTree } = await import('../src/tools/snapshot.js');
    await expect(buildSnapshotTree(TAB, 'dom')).rejects.toMatchObject({
      code: 'snapshot_failed',
    });
    expect(released(sent, 'sallyport_snapshot')).toBe(1);
  });

  it('mouse aim: a probe that throws in the page still releases sallyport_mouse', async () => {
    const sent = installChrome((m, p) =>
      m === 'Runtime.callFunctionOn' && p.objectGroup === 'sallyport_mouse'
        ? { result: { objectId: 'thrown' }, exceptionDetails: { text: 'Uncaught' } }
        : undefined,
    );
    await allow();
    const { mouseClick } = await import('../src/tools/mouse.js');
    await expect(mouseClick({ tabId: TAB, selector: '#buy' }, undefined)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(released(sent, 'sallyport_mouse')).toBe(1);
    expect(sent.some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(false);
  });
});

/**
 * The exhaustive half. The tests above drive the common paths; this one reads
 * every tool module and refuses ANY `DOM.resolveNode` / `Runtime.evaluate` call
 * whose parameter object names no `objectGroup` — so a new site (or a fill
 * readback path no mock reaches) can't quietly go back to pinning the page.
 */
describe('no groupless object-minting command anywhere in src/tools', () => {
  const dir = new URL('../src/tools/', import.meta.url).pathname;

  /** The `{ … }` that follows a method literal, braces balanced. */
  function paramsAfter(src: string, at: number): string | null {
    const open = src.indexOf('{', at);
    const close = src.indexOf(')', at);
    if (open === -1 || (close !== -1 && close < open)) return null; // no params at all
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}' && (depth -= 1) === 0) return src.slice(open, i + 1);
    }
    return null;
  }

  it('finds the call sites it is checking (non-vacuous)', () => {
    let count = 0;
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(dir + f, 'utf8');
      count += [...src.matchAll(/'(DOM\.resolveNode|Runtime\.evaluate)',/g)].length;
    }
    expect(count).toBeGreaterThanOrEqual(15);
  });

  it('every such call passes an objectGroup', () => {
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(dir + f, 'utf8');
      for (const m of src.matchAll(/'(DOM\.resolveNode|Runtime\.evaluate)',/g)) {
        const params = paramsAfter(src, m.index! + m[0].length);
        if (!params || !/\bobjectGroup\b/.test(params)) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${f}:${line} ${m[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
