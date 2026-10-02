/**
 * `@eN` ids across an MV3 worker restart (invariant #7).
 *
 * The ref maps and counters are worker memory; the tab — and the document an
 * agent's `@e5` was minted in — outlives the worker. A counter that started at
 * `e1` again in the new worker let the next snapshot re-issue `@e5` on the SAME
 * document, where the loader-id stamp cannot tell the two apart, so the held
 * ref silently named a different element. Every id is now covered by a mark
 * persisted before the result carrying it leaves the extension, and the next
 * worker counts on from there.
 *
 * A restart is simulated with `vi.resetModules()` + a fresh import: new module
 * state, same `chrome.storage.local`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let store: Record<string, unknown>;
let liveTabs: number[];

beforeEach(() => {
  store = {};
  liveTabs = [7, 8];
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, structuredClone(items));
        }),
      },
    },
    tabs: { query: vi.fn(async () => liveTabs.map((id) => ({ id }))) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fresh worker: new module instances over the same storage. */
async function boot() {
  vi.resetModules();
  const refs = await import('../src/tools/refs.js');
  const store = await import('../src/tools/ref-store.js');
  await store.loadRefMarks();
  return { ...refs, ...store };
}

function mint(refs: Awaited<ReturnType<typeof boot>>, tabId: number, n: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(Number(refs.newRef(tabId, 100 + i, 'button', `b${i}`, 'L1').slice(1)));
  }
  return ids;
}

describe('ref counters across a worker restart', () => {
  it('never re-issues an id handed out before the restart, on the same document', async () => {
    const before = await boot();
    const held = mint(before, 7, 5);
    await before.persistRefMarks();
    expect(before.getRef(7, '@e5')?.name).toBe('b4');

    const after = await boot();
    // The map is gone with the worker: the held ref misses for now…
    expect(after.getRef(7, '@e5')).toBeNull();
    // …and a re-snapshot of the very same page never brings it back.
    after.resetRefsForTab(7, after.refWatermark(7));
    const fresh = mint(after, 7, 50);
    expect(fresh.filter((id) => held.includes(id))).toEqual([]);
    expect(after.getRef(7, '@e5')).toBeNull();
    expect(Math.min(...fresh)).toBeGreaterThan(Math.max(...held));
  });

  it('holds across several restarts', async () => {
    let w = await boot();
    const handedOut = new Set<number>();
    for (let restart = 0; restart < 4; restart++) {
      for (const id of mint(w, 7, 1500)) {
        expect(handedOut.has(id)).toBe(false);
        handedOut.add(id);
      }
      await w.persistRefMarks();
      w = await boot();
    }
  });

  // The mark is the counter itself, not a reserved block ahead of it: a
  // restart used to jump every live tab's ids by up to 1024 (`@e51200` after
  // enough of them), costing tokens on every ref for nothing.
  it('costs no ids: after a restart the next id is the one after the last handed out', async () => {
    let w = await boot();
    for (let restart = 0; restart < 5; restart++) {
      const held = mint(w, 7, 3);
      await w.persistRefMarks();
      w = await boot();
      w.resetRefsForTab(7, w.refWatermark(7));
      expect(mint(w, 7, 1)).toEqual([Math.max(...held) + 1]);
      await w.persistRefMarks();
    }
    expect((store.sallyport_ref_marks as Record<string, number>)['7']).toBe(20);
  });

  it('writes once per call that minted ids, and not at all for a call that minted none', async () => {
    const w = await boot();
    const set = vi.mocked(chrome.storage.local.set);
    mint(w, 7, 3);
    await w.persistRefMarks();
    expect(set).toHaveBeenCalledTimes(1);
    expect((store.sallyport_ref_marks as Record<string, number>)['7']).toBe(3);
    await w.persistRefMarks(); // a call that minted nothing
    expect(set).toHaveBeenCalledTimes(1);
    mint(w, 7, 10);
    await w.persistRefMarks();
    expect(set).toHaveBeenCalledTimes(2);
    expect((store.sallyport_ref_marks as Record<string, number>)['7']).toBe(13);
  });

  it("a snapshot's rewound internal ids never lower the mark below what was handed out", async () => {
    const w = await boot();
    const held = mint(w, 7, 5); // handed out: e1..e5
    await w.persistRefMarks();
    // The next snapshot mints a discarded pass, then rewinds and re-mints.
    const mark = w.refWatermark(7);
    mint(w, 7, 40);
    w.resetRefsForTab(7, mark);
    const kept = mint(w, 7, 2);
    await w.persistRefMarks();
    const stored = (store.sallyport_ref_marks as Record<string, number>)['7'];
    expect(stored).toBeGreaterThanOrEqual(Math.max(...held, ...kept));
    const after = await boot();
    after.resetRefsForTab(7, after.refWatermark(7));
    expect(Math.min(...mint(after, 7, 3))).toBeGreaterThan(Math.max(...kept));
  });

  it('drops the mark of a tab that is gone, and a closed tab restarts at e1', async () => {
    const w = await boot();
    mint(w, 7, 3);
    mint(w, 8, 3);
    await w.persistRefMarks();
    w.clearRefsForTab(8);
    await w.persistRefMarks();
    expect(Object.keys(store.sallyport_ref_marks as object)).toEqual(['7']);

    liveTabs = [];
    const after = await boot();
    expect(mint(after, 7, 1)).toEqual([1]); // tab 7 closed while no worker ran
    await after.persistRefMarks();
    expect(Object.keys(store.sallyport_ref_marks as object)).toEqual(['7']);
    expect((store.sallyport_ref_marks as Record<string, number>)['7']).toBe(1);
  });

  it('ignores a malformed snapshot and survives storage that refuses', async () => {
    store.sallyport_ref_marks = { '7': 'x', nope: 3, '8': -1 };
    let w = await boot();
    expect(mint(w, 7, 1)).toEqual([1]);
    store.sallyport_ref_marks = [1, 2];
    w = await boot();
    expect(mint(w, 7, 1)).toEqual([1]);

    vi.mocked(chrome.storage.local.get).mockRejectedValue(new Error('no'));
    vi.mocked(chrome.storage.local.set).mockRejectedValue(new Error('no'));
    w = await boot();
    mint(w, 7, 1);
    await expect(w.persistRefMarks()).resolves.toBeUndefined();
  });

  it('retries a refused write, so the ids it was for are covered across a restart', async () => {
    let w = await boot();
    mint(w, 7, 1);
    await w.persistRefMarks(); // mark 1
    const set = vi.mocked(chrome.storage.local.set);
    set.mockRejectedValueOnce(new Error('quota'));
    const refused = mint(w, 7, 20); // e2..e21, write refused
    await w.persistRefMarks();
    expect((store.sallyport_ref_marks as Record<string, number>)['7']).toBe(1);
    // The next call mints nothing past the refused snapshot, yet still writes.
    await w.persistRefMarks();
    expect((store.sallyport_ref_marks as Record<string, number>)['7']).toBe(Math.max(...refused));

    w = await boot();
    w.resetRefsForTab(7, w.refWatermark(7));
    const fresh = mint(w, 7, 5);
    expect(Math.min(...fresh)).toBeGreaterThan(Math.max(...refused));
  });

  it("a worker whose load failed never erases another tab's mark", async () => {
    let w = await boot();
    const held = mint(w, 8, 10);
    await w.persistRefMarks();

    const get = vi.mocked(chrome.storage.local.get);
    get.mockRejectedValueOnce(new Error('io'));
    w = await boot(); // this worker's load fails
    mint(w, 7, 3);
    await w.persistRefMarks();
    expect((store.sallyport_ref_marks as Record<string, number>)['8']).toBeGreaterThanOrEqual(
      Math.max(...held),
    );

    w = await boot();
    w.resetRefsForTab(8, w.refWatermark(8));
    expect(Math.min(...mint(w, 8, 5))).toBeGreaterThan(Math.max(...held));
  });

  it('retries a failed load on the next call instead of memoising the failure', async () => {
    const before = await boot();
    const held = mint(before, 7, 5);
    await before.persistRefMarks();

    const get = vi.mocked(chrome.storage.local.get);
    get.mockRejectedValueOnce(new Error('io'));
    const w = await boot(); // first load fails
    await w.loadRefMarks(); // next call: retried, succeeds
    w.resetRefsForTab(7, w.refWatermark(7));
    expect(Math.min(...mint(w, 7, 5))).toBeGreaterThan(Math.max(...held));
  });
});

describe('runTool', () => {
  it('waits for the marks to load before a tool runs, and persists before returning', async () => {
    vi.resetModules();
    const order: string[] = [];
    const get = vi.mocked(chrome.storage.local.get);
    const set = vi.mocked(chrome.storage.local.set);
    get.mockImplementation(async (key: string) => {
      if (key === 'sallyport_ref_marks') order.push('load');
      return key === 'sallyport_ref_marks' ? { [key]: { '7': 40 } } : {};
    });
    set.mockImplementation(async (items: Record<string, unknown>) => {
      if ('sallyport_ref_marks' in items) order.push('persist');
    });
    vi.doMock('../src/storage.js', () => ({
      getSettings: vi.fn(async () => ({ paused: false })),
      appendAudit: vi.fn(async () => {
        order.push('audit');
      }),
      redactAuditArgs: vi.fn((_n: string, a: Record<string, unknown>) => a),
    }));
    const refs = await import('../src/tools/refs.js');
    vi.doMock('../src/tools/snapshot.js', () => ({
      snapshot: async () => {
        order.push('tool');
        return { tabId: 7, data: { ref: refs.newRef(7, 1, 'button', 'x', 'L1') } };
      },
    }));
    const { runTool } = await import('../src/tools.js');
    const data = (await runTool('snapshot', { tabId: 7 })) as { ref: string };
    expect(data.ref).toBe('e41');
    expect(order).toEqual(['load', 'tool', 'persist', 'audit']);
    vi.doUnmock('../src/storage.js');
    vi.doUnmock('../src/tools/snapshot.js');
  });
});
