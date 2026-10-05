import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADD_LISTENER_FN,
  CLEAR_HANDLER_FN,
  READ_HANDLER_FN,
  REMOVE_LISTENER_FN,
  RESTORE_HANDLER_FN,
  beforeUnloadHandlers,
  closeAgentTab,
  disarmBeforeUnload,
  mayCloseQuietly,
  mayLeaveQuietly,
  rearmIfSameDocument,
} from '../src/tools/quiet-leave.js';
import { clearAllEpochs, markHumanTab, mintEpoch, setBrokerMode } from '../src/tools/ownership.js';
import { CALL_GROUP, attach, isAttached, resetAttachedTabs } from '../src/tools/cdp.js';

beforeEach(() => {
  clearAllEpochs();
  resetAttachedTabs();
});
afterEach(() => vi.unstubAllGlobals());

describe('who may leave without the prompt', () => {
  it('only an agent-created tab the human has not engaged with', () => {
    expect(mayCloseQuietly(7)).toBe(false); // not ours: the human's tab
    mintEpoch(7);
    expect(mayCloseQuietly(7)).toBe(true);
    markHumanTab(7);
    expect(mayCloseQuietly(7)).toBe(false); // the prompt may guard their typing
  });

  it('navigation additionally needs broker mode', () => {
    mintEpoch(7);
    expect(mayLeaveQuietly(7)).toBe(false);
    setBrokerMode(true);
    expect(mayLeaveQuietly(7)).toBe(true);
  });
});

describe('beforeUnloadHandlers', () => {
  it('keeps well-formed beforeunload entries only, capture read strictly', () => {
    expect(
      beforeUnloadHandlers([
        { type: 'beforeunload', useCapture: true, handler: { objectId: 'a' } },
        { type: 'beforeunload', useCapture: 'yes', handler: { objectId: 'b' } },
        { type: 'beforeunload' }, // no handler object (objectGroup not honoured)
        { type: 'unload', handler: { objectId: 'c' } },
        null,
        'junk',
      ]),
    ).toEqual([
      { objectId: 'a', capture: true },
      { objectId: 'b', capture: false },
    ]);
    expect(beforeUnloadHandlers(undefined)).toEqual([]);
  });

  it('prefers originalHandler — the REGISTERED object removeEventListener matches', () => {
    // A handleEvent object or a bound function: `handler` is the function
    // Chrome calls, `originalHandler` what the page passed to addEventListener.
    expect(
      beforeUnloadHandlers([
        {
          type: 'beforeunload',
          useCapture: false,
          handler: { objectId: 'fn' },
          originalHandler: { objectId: 'obj' },
        },
        { type: 'beforeunload', useCapture: false, handler: { objectId: 'plain' } },
      ]),
    ).toEqual([
      { objectId: 'obj', capture: false },
      { objectId: 'plain', capture: false },
    ]);
  });
});

describe('the fixed page functions, run standalone', () => {
  it('REMOVE_LISTENER_FN removes exactly the listener it is handed', () => {
    const target = new EventTarget();
    const hits: string[] = [];
    const capture = () => hits.push('capture');
    const bubble = () => hits.push('bubble');
    target.addEventListener('beforeunload', capture, true);
    target.addEventListener('beforeunload', bubble);
    const fn = new Function(`return (${REMOVE_LISTENER_FN})`)() as (
      this: EventTarget,
      f: unknown,
      c: unknown,
    ) => void;
    fn.call(target, capture, true);
    fn.call(target, bubble, false);
    target.dispatchEvent(new Event('beforeunload'));
    expect(hits).toEqual([]);
  });

  it('removes a handleEvent object listener when handed that object', () => {
    const target = new EventTarget();
    let hits = 0;
    const listener = { handleEvent: () => hits++ };
    target.addEventListener('beforeunload', listener);
    const fn = new Function(`return (${REMOVE_LISTENER_FN})`)() as (
      this: EventTarget,
      f: unknown,
      c: unknown,
    ) => void;
    fn.call(target, listener, false);
    target.dispatchEvent(new Event('beforeunload'));
    expect(hits).toBe(0);
  });

  it('READ/CLEAR/RESTORE round-trip the IDL handler, and RESTORE never overwrites a new one', () => {
    const fn = <T>(src: string) => new Function(`return (${src})`)() as T;
    const handler = () => 'dirty';
    const win: { onbeforeunload: unknown } = { onbeforeunload: handler };
    const saved = fn<(this: unknown) => unknown>(READ_HANDLER_FN).call(win);
    fn<(this: unknown) => void>(CLEAR_HANDLER_FN).call(win);
    expect(win.onbeforeunload).toBeNull();
    fn<(this: unknown, f: unknown) => void>(RESTORE_HANDLER_FN).call(win, saved);
    expect(win.onbeforeunload).toBe(handler);
    const newer = () => 'newer';
    win.onbeforeunload = newer;
    fn<(this: unknown, f: unknown) => void>(RESTORE_HANDLER_FN).call(win, saved);
    expect(win.onbeforeunload).toBe(newer);
  });

  it('ADD_LISTENER_FN puts a listener back but never re-adds the IDL handler as one', () => {
    const target = new EventTarget();
    const hits: string[] = [];
    const listener = () => hits.push('listener');
    const idl = () => hits.push('idl');
    const add = new Function(`return (${ADD_LISTENER_FN})`)() as (
      this: EventTarget,
      f: unknown,
      c: unknown,
      i: unknown,
    ) => void;
    add.call(target, listener, false, idl);
    add.call(target, idl, false, idl);
    target.dispatchEvent(new Event('beforeunload'));
    expect(hits).toEqual(['listener']);
  });
});

type Sent = { tabId: number; method: string; params?: Record<string, unknown> };

function stubChrome(opts: {
  attachError?: string;
  /** How Target.closeTarget answers: closes (default), {success:false}, or a refusal. */
  closeTarget?: 'closes' | 'declines' | 'refuses';
  tabs?: number[];
  targets?: Array<{ id: string; tabId: number; type: string }>;
  evaluate?: () => Promise<unknown>;
  listeners?: unknown[];
  loaderIds?: string[];
  /** Runs when Target.closeTarget arrives (e.g. a concurrent tool attaching). */
  onClose?: () => Promise<void>;
}) {
  const sent: Sent[] = [];
  const removed: number[] = [];
  const detached: number[] = [];
  const attachCalls: number[] = [];
  let getTargetsCalls = 0;
  const live = new Set(opts.tabs ?? [7]);
  const listeners = new Set<(id: number) => void>();
  const loaders = [...(opts.loaderIds ?? [])];
  const gone = (id: number) => {
    live.delete(id);
    for (const fn of [...listeners]) fn(id);
  };
  const store = new Map<string, unknown>();
  vi.stubGlobal('chrome', {
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
      },
    },
    tabs: {
      async get(id: number) {
        if (!live.has(id)) throw new Error(`No tab with id: ${id}.`);
        return { id };
      },
      async remove(id: number) {
        if (!live.has(id)) throw new Error(`No tab with id: ${id}.`);
        removed.push(id);
        gone(id);
      },
      onRemoved: {
        addListener: (fn: (id: number) => void) => listeners.add(fn),
        removeListener: (fn: (id: number) => void) => listeners.delete(fn),
      },
    },
    debugger: {
      async getTargets() {
        getTargetsCalls++;
        return opts.targets ?? [...live].map((tabId) => ({ id: `T${tabId}`, tabId, type: 'page' }));
      },
      async attach(t: { tabId: number }) {
        attachCalls.push(t.tabId);
        if (opts.attachError) throw new Error(opts.attachError);
      },
      async detach(t: { tabId: number }) {
        detached.push(t.tabId);
      },
      async sendCommand(t: { tabId: number }, method: string, params?: Record<string, unknown>) {
        sent.push({ tabId: t.tabId, method, ...(params ? { params } : {}) });
        if (method === 'Target.closeTarget') {
          await opts.onClose?.();
          if (opts.closeTarget === 'declines') return { success: false };
          if (opts.closeTarget === 'refuses')
            throw new Error('Debugger is not attached to the tab with id: 7.');
          gone(t.tabId);
          throw new Error('Detached while handling command.');
        }
        if (method === 'Runtime.evaluate') {
          return opts.evaluate ? opts.evaluate() : { result: { objectId: 'win' } };
        }
        if (method === 'Page.getFrameTree') {
          const loaderId = loaders.length > 1 ? loaders.shift() : loaders[0];
          return loaderId ? { frameTree: { frame: { id: 'F', loaderId } } } : {};
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          params?.functionDeclaration === READ_HANDLER_FN
        ) {
          return { result: { type: 'function', objectId: 'idl' } };
        }
        if (method === 'DOMDebugger.getEventListeners') {
          return {
            listeners: opts.listeners ?? [
              { type: 'beforeunload', useCapture: false, handler: { objectId: 'h1' } },
              { type: 'click', useCapture: false, handler: { objectId: 'h2' } },
            ],
          };
        }
        return {};
      },
      onDetach: { addListener() {} },
      onEvent: { addListener() {} },
    },
  });
  return { sent, removed, detached, attachCalls, getTargets: () => getTargetsCalls };
}

const closes = (io: { sent: Sent[] }) => io.sent.filter((s) => s.method === 'Target.closeTarget');

describe('closeAgentTab', () => {
  it('closes an agent tab through its own page target and never calls tabs.remove', async () => {
    mintEpoch(7);
    const io = stubChrome({});
    expect(await closeAgentTab(7)).toBe('quiet');
    expect(closes(io)).toEqual([
      { tabId: 7, method: 'Target.closeTarget', params: { targetId: 'T7' } },
    ]);
    expect(io.removed).toEqual([]);
    expect(isAttached(7)).toBe(false); // nothing left behind in cdp.ts
  });

  it('closes the PAGE target, never a frame/worker target sharing the tabId', async () => {
    mintEpoch(7);
    const io = stubChrome({
      targets: [
        { id: 'W7', tabId: 7, type: 'worker' },
        { id: 'F7', tabId: 7, type: 'iframe' },
        { id: 'T7', tabId: 7, type: 'page' },
      ],
    });
    expect(await closeAgentTab(7)).toBe('quiet');
    expect(closes(io).map((c) => c.params?.targetId)).toEqual(['T7']);
  });

  it('a human tab (no epoch) or a human-engaged agent tab goes through tabs.remove untouched', async () => {
    let io = stubChrome({});
    expect(await closeAgentTab(7)).toBe('removed');
    expect(io.attachCalls).toEqual([]);
    expect(io.removed).toEqual([7]);
    mintEpoch(8);
    markHumanTab(8);
    io = stubChrome({ tabs: [8] });
    expect(await closeAgentTab(8)).toBe('removed');
    expect(io.sent).toEqual([]);
  });

  it('uses the session cdp.ts already holds — no second attach, never detached', async () => {
    mintEpoch(7);
    const io = stubChrome({ closeTarget: 'refuses' });
    await attach(7);
    io.attachCalls.length = 0;
    expect(await closeAgentTab(7)).toBe('removed');
    expect(io.attachCalls).toEqual([]);
    expect(io.detached).toEqual([]);
  });

  it("another client's session: a definite refusal falls back AT ONCE, nothing detached", async () => {
    mintEpoch(7);
    const io = stubChrome({
      attachError: 'Another debugger is already attached to the tab with id: 7.',
      closeTarget: 'refuses',
    });
    const t0 = Date.now();
    expect(await closeAgentTab(7)).toBe('removed');
    expect(Date.now() - t0).toBeLessThan(500); // no QUIET_CLOSE_CONFIRM_MS wait
    expect(io.detached).toEqual([]);
    expect(io.removed).toEqual([7]);
  });

  it('a close that did not take: falls back at once and leaves no session or cdp.ts state', async () => {
    mintEpoch(7);
    const io = stubChrome({ closeTarget: 'declines' });
    const t0 = Date.now();
    expect(await closeAgentTab(7)).toBe('removed');
    expect(Date.now() - t0).toBeLessThan(500);
    expect(io.detached).toEqual([7]);
    expect(isAttached(7)).toBe(false);
  });

  it('a concurrent attach that adopted our session is cleared when we detach it', async () => {
    // Chrome sends no onDetach for our own detach, so cdp.ts would otherwise
    // keep an `attached` entry for a session that no longer exists.
    mintEpoch(7);
    stubChrome({ closeTarget: 'declines', onClose: () => attach(7) });
    expect(await closeAgentTab(7)).toBe('removed');
    expect(isAttached(7)).toBe(false);
  });

  it('no foothold at all → plain removal', async () => {
    mintEpoch(7);
    const io = stubChrome({ attachError: 'Cannot access a chrome:// URL' });
    expect(await closeAgentTab(7)).toBe('removed');
    expect(io.sent).toEqual([]);
  });

  it('quietOnly never removes: a tab that cannot go quietly is kept', async () => {
    mintEpoch(7);
    const io = stubChrome({ attachError: 'Cannot access a chrome:// URL' });
    expect(await closeAgentTab(7, { quietOnly: true })).toBe('kept');
    expect(io.removed).toEqual([]);
    markHumanTab(7);
    expect(await closeAgentTab(7, { quietOnly: true })).toBe('kept');
    expect(io.removed).toEqual([]);
  });

  it('a batch shares one target lookup', async () => {
    mintEpoch(7);
    mintEpoch(8);
    const io = stubChrome({ tabs: [7, 8] });
    const targets = new Map([
      [7, 'T7'],
      [8, 'T8'],
    ]);
    await closeAgentTab(7, { targets });
    await closeAgentTab(8, { targets });
    expect(io.getTargets()).toBe(0);
  });

  it('a missing tab still rejects like tabs.remove does', async () => {
    stubChrome({ tabs: [] });
    await expect(closeAgentTab(9)).rejects.toThrow(/No tab with id/);
  });
});

describe('disarmBeforeUnload / rearmIfSameDocument', () => {
  it('removes only the beforeunload listeners, by structured argument, in the call group', async () => {
    const io = stubChrome({ loaderIds: ['L1'] });
    const d = await disarmBeforeUnload(7);
    expect(d).toEqual({
      windowId: 'win',
      handlers: [{ objectId: 'h1', capture: false }],
      idl: 'idl',
      loaderId: 'L1',
    });
    expect(io.sent[0]).toEqual({
      tabId: 7,
      method: 'Runtime.evaluate',
      params: { expression: 'window', objectGroup: CALL_GROUP },
    });
    const calls = io.sent.filter((s) => s.method === 'Runtime.callFunctionOn');
    expect(calls.map((c) => c.params?.functionDeclaration)).toEqual([
      READ_HANDLER_FN,
      REMOVE_LISTENER_FN,
      CLEAR_HANDLER_FN,
    ]);
    expect(calls[1].params?.arguments).toEqual([{ objectId: 'h1' }, { value: false }]);
  });

  it('touches nothing when the page has no beforeunload listener', async () => {
    const io = stubChrome({ listeners: [{ type: 'click', handler: { objectId: 'x' } }] });
    expect(await disarmBeforeUnload(7)).toBeNull();
    expect(io.sent.filter((s) => s.method === 'Runtime.callFunctionOn')).toEqual([]);
  });

  it('puts everything back when the tab is still on the same document', async () => {
    const io = stubChrome({ loaderIds: ['L1'] });
    const d = await disarmBeforeUnload(7);
    io.sent.length = 0;
    expect(await rearmIfSameDocument(7, d)).toBe(true);
    const calls = io.sent.filter((s) => s.method === 'Runtime.callFunctionOn');
    expect(calls.map((c) => c.params?.functionDeclaration)).toEqual([
      ADD_LISTENER_FN,
      RESTORE_HANDLER_FN,
    ]);
    expect(calls[0].params?.arguments).toEqual([
      { objectId: 'h1' },
      { value: false },
      { objectId: 'idl' },
    ]);
  });

  it('puts nothing back on a new document, or when the document is unknown', async () => {
    let io = stubChrome({ loaderIds: ['L1', 'L2'] });
    let d = await disarmBeforeUnload(7);
    io.sent.length = 0;
    expect(await rearmIfSameDocument(7, d)).toBe(false);
    expect(io.sent.filter((s) => s.method === 'Runtime.callFunctionOn')).toEqual([]);
    io = stubChrome({});
    d = await disarmBeforeUnload(7);
    expect(d?.loaderId).toBeNull();
    io.sent.length = 0;
    expect(await rearmIfSameDocument(7, d)).toBe(false);
    expect(io.sent).toEqual([]);
  });

  it('never throws and gives up at its deadline on a page that never answers', async () => {
    vi.useFakeTimers();
    try {
      stubChrome({ evaluate: () => new Promise(() => {}) });
      const out = disarmBeforeUnload(7);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await out).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends nothing when the call has no budget left', async () => {
    const io = stubChrome({});
    expect(await disarmBeforeUnload(7, Date.now() - 60_000)).toBeNull();
    expect(io.sent).toEqual([]);
  });

  it('a failing page is not an error', async () => {
    stubChrome({ evaluate: () => Promise.reject(new Error('Execution context was destroyed')) });
    expect(await disarmBeforeUnload(7)).toBeNull();
  });
});
