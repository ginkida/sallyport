import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLEAR_HANDLER_FN,
  REMOVE_LISTENER_FN,
  beforeUnloadHandlers,
  closeTabQuietly,
  disarmBeforeUnload,
  mayCloseQuietly,
  mayLeaveQuietly,
} from '../src/tools/quiet-leave.js';
import { clearAllEpochs, markHumanTab, mintEpoch, setBrokerMode } from '../src/tools/ownership.js';
import { CALL_GROUP, resetAttachedTabs } from '../src/tools/cdp.js';

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

  it('CLEAR_HANDLER_FN clears the IDL handler', () => {
    const win: { onbeforeunload: unknown } = { onbeforeunload: () => 'dirty' };
    (new Function(`return (${CLEAR_HANDLER_FN})`)() as (this: unknown) => void).call(win);
    expect(win.onbeforeunload).toBeNull();
  });
});

type Sent = { tabId: number; method: string; params?: Record<string, unknown> };

function stubChrome(opts: {
  attachError?: string;
  closeTargetWorks?: boolean;
  tabs?: number[];
  evaluate?: () => Promise<unknown>;
}) {
  const sent: Sent[] = [];
  const removed: number[] = [];
  const detached: number[] = [];
  const live = new Set(opts.tabs ?? [7]);
  const listeners = new Set<(id: number) => void>();
  const gone = (id: number) => {
    live.delete(id);
    for (const fn of [...listeners]) fn(id);
  };
  vi.stubGlobal('chrome', {
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
        return [...live].map((tabId) => ({ id: `T${tabId}`, tabId }));
      },
      async attach() {
        if (opts.attachError) throw new Error(opts.attachError);
      },
      async detach(t: { tabId: number }) {
        detached.push(t.tabId);
      },
      async sendCommand(t: { tabId: number }, method: string, params?: Record<string, unknown>) {
        sent.push({ tabId: t.tabId, method, ...(params ? { params } : {}) });
        if (method === 'Target.closeTarget') {
          if (opts.closeTargetWorks === false) return { success: false };
          gone(t.tabId);
          throw new Error('Detached while handling command.');
        }
        if (method === 'Runtime.evaluate') {
          return opts.evaluate ? opts.evaluate() : { result: { objectId: 'win' } };
        }
        if (method === 'DOMDebugger.getEventListeners') {
          return {
            listeners: [
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
  return { sent, removed, detached };
}

describe('closeTabQuietly', () => {
  it('closes through the tab own target and never calls tabs.remove', async () => {
    const io = stubChrome({});
    expect(await closeTabQuietly(7)).toBe('quiet');
    expect(io.sent).toEqual([
      { tabId: 7, method: 'Target.closeTarget', params: { targetId: 'T7' } },
    ]);
    expect(io.removed).toEqual([]);
  });

  it('reuses our own existing session ("already attached")', async () => {
    const io = stubChrome({ attachError: 'Another debugger is already attached to the tab' });
    expect(await closeTabQuietly(7)).toBe('quiet');
    expect(io.removed).toEqual([]);
  });

  it('falls back to tabs.remove without a debugger foothold', async () => {
    const io = stubChrome({ attachError: 'Cannot access a chrome:// URL' });
    expect(await closeTabQuietly(7)).toBe('removed');
    expect(io.sent).toEqual([]);
    expect(io.removed).toEqual([7]);
  });

  it('falls back (and detaches what it attached) when the close did not take', async () => {
    vi.useFakeTimers();
    try {
      const io = stubChrome({ closeTargetWorks: false });
      const out = closeTabQuietly(7);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await out).toBe('removed');
      expect(io.detached).toEqual([7]);
      expect(io.removed).toEqual([7]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a missing tab still rejects like tabs.remove does', async () => {
    stubChrome({ tabs: [] });
    await expect(closeTabQuietly(9)).rejects.toThrow(/No tab with id/);
  });
});

describe('disarmBeforeUnload', () => {
  it('removes only the beforeunload listeners, by structured argument, in the call group', async () => {
    const io = stubChrome({});
    expect(await disarmBeforeUnload(7)).toBe(1);
    expect(io.sent[0]).toEqual({
      tabId: 7,
      method: 'Runtime.evaluate',
      params: { expression: 'window', objectGroup: CALL_GROUP },
    });
    const calls = io.sent.filter((s) => s.method === 'Runtime.callFunctionOn');
    expect(calls.map((c) => c.params?.functionDeclaration)).toEqual([
      REMOVE_LISTENER_FN,
      CLEAR_HANDLER_FN,
    ]);
    expect(calls[0].params?.arguments).toEqual([{ objectId: 'h1' }, { value: false }]);
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
