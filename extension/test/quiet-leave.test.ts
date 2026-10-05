import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DISARM_FN,
  PREPARE_LEAVE_FN,
  REARM_FN,
  beforeUnloadHandlers,
  closeAgentTab,
  disarmBeforeUnload,
  inFrontOfHuman,
  isFragmentNavigation,
  mayCloseQuietly,
  mayLeaveQuietly,
  quietLeaveApproved,
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

describe('PREPARE_LEAVE_FN, run standalone', () => {
  // A stand-in for the page's window: an EventTarget whose `onbeforeunload` is
  // an accessor, as the browser's own is.
  type Win = EventTarget & { onbeforeunload: unknown };
  type Controller = { disarm: () => void; restore: () => boolean };
  function fakeWindow(): { w: Win; ownIdl: PropertyDescriptor } {
    const w = new EventTarget() as Win;
    let handler: unknown = null;
    Object.defineProperty(w, 'onbeforeunload', {
      configurable: true,
      enumerable: true,
      get: () => handler,
      set: (v: unknown) => {
        handler = typeof v === 'function' ? v : null;
      },
    });
    return { w, ownIdl: Object.getOwnPropertyDescriptor(w, 'onbeforeunload')! };
  }
  const prepare = new Function(`return (${PREPARE_LEAVE_FN})`)() as (
    this: Win,
    ...args: unknown[]
  ) => Controller;
  function fire(w: Win): void {
    w.dispatchEvent(new Event('beforeunload'));
  }
  function pageshow(w: Win, persisted: boolean): void {
    const e = new Event('pageshow');
    Object.defineProperty(e, 'persisted', { value: persisted });
    w.dispatchEvent(e);
  }
  function setup() {
    const { w, ownIdl } = fakeWindow();
    const hits: string[] = [];
    const plain = () => hits.push('plain');
    const obj = { handleEvent: () => hits.push('object') };
    const idl = () => hits.push('idl');
    w.addEventListener('beforeunload', plain);
    w.addEventListener('beforeunload', obj, true);
    w.onbeforeunload = idl;
    // Chrome reports the IDL handler among the listeners too.
    const ctl = prepare.call(w, plain, false, obj, true, idl, false);
    return { w, ownIdl, hits, plain, obj, idl, ctl };
  }

  it('changes nothing until disarm, then removes every listener and the IDL handler', () => {
    const { w, hits, ctl } = setup();
    fire(w);
    expect(hits).toEqual(['plain', 'object']);
    hits.length = 0;
    ctl.disarm();
    fire(w);
    expect(hits).toEqual([]);
    expect(w.onbeforeunload).toBeNull();
  });

  it('restore puts back exactly what was there — no duplicate, the IDL handler as a handler', () => {
    const { w, hits, idl, ctl } = setup();
    ctl.disarm();
    expect(ctl.restore()).toBe(true);
    fire(w);
    expect(hits.sort()).toEqual(['object', 'plain']);
    expect(w.onbeforeunload).toBe(idl);
    expect(ctl.restore()).toBe(false); // once
  });

  it('a listener the PAGE removed meanwhile stays removed (an SPA unmounting its editor)', () => {
    const { w, hits, plain, obj, ctl } = setup();
    ctl.disarm();
    // The router's cleanup, while the guard is down: a no-op on its own…
    w.removeEventListener('beforeunload', plain);
    // …capture spelled as an options object, matched like the browser does.
    w.removeEventListener('beforeunload', obj, { capture: true });
    ctl.restore();
    fire(w);
    expect(hits).toEqual([]);
  });

  it('only a matching removal counts: another type, another capture flag, another target', () => {
    const { w, hits, plain, ctl } = setup();
    ctl.disarm();
    w.removeEventListener('unload', plain);
    w.removeEventListener('beforeunload', plain, true); // registered without capture
    const other = new EventTarget();
    w.removeEventListener.call(other, 'beforeunload', plain);
    ctl.restore();
    fire(w);
    expect(hits).toContain('plain');
  });

  it('an IDL handler the page cleared or replaced meanwhile is not overwritten', () => {
    let t = setup();
    t.ctl.disarm();
    t.w.onbeforeunload = null; // the page dropping its own guard
    t.ctl.restore();
    expect(t.w.onbeforeunload).toBeNull();
    t = setup();
    t.ctl.disarm();
    const newer = () => 'newer';
    t.w.onbeforeunload = newer;
    t.ctl.restore();
    expect(t.w.onbeforeunload).toBe(newer);
  });

  it('takes its watch down on restore: no own removeEventListener, the original accessor back', () => {
    const { w, ownIdl, ctl } = setup();
    ctl.disarm();
    expect(Object.prototype.hasOwnProperty.call(w, 'removeEventListener')).toBe(true);
    ctl.restore();
    expect(Object.prototype.hasOwnProperty.call(w, 'removeEventListener')).toBe(false);
    expect(Object.getOwnPropertyDescriptor(w, 'onbeforeunload')?.get).toBe(ownIdl.get);
    // and the page's own removals go straight to the browser again
    const late = () => {};
    w.addEventListener('beforeunload', late);
    w.removeEventListener('beforeunload', late);
  });

  it('never takes down a removeEventListener the page put there itself', () => {
    const { w, ctl } = setup();
    ctl.disarm();
    const pages = () => {};
    (w as unknown as { removeEventListener: unknown }).removeEventListener = pages;
    ctl.restore();
    expect((w as unknown as { removeEventListener: unknown }).removeEventListener).toBe(pages);
  });

  it('a document restored from the back/forward cache gets its guard back on pageshow', () => {
    const { w, hits, idl, ctl } = setup();
    ctl.disarm();
    pageshow(w, false); // an ordinary pageshow is not a return
    fire(w);
    expect(hits).toEqual([]);
    pageshow(w, true);
    fire(w);
    expect(hits.sort()).toEqual(['object', 'plain']);
    expect(w.onbeforeunload).toBe(idl);
    expect(ctl.restore()).toBe(false); // already done — the extension's rearm is a no-op
  });

  it('…minus what the page removed on its way out (pagehide cleanup)', () => {
    const { w, hits, plain, ctl } = setup();
    ctl.disarm();
    w.removeEventListener('beforeunload', plain);
    pageshow(w, true);
    fire(w);
    expect(hits).toEqual(['object']);
  });

  it('restore before disarm changes nothing', () => {
    const { w, hits, ctl } = setup();
    expect(ctl.restore()).toBe(false);
    ctl.disarm(); // a late disarm after a restore must not strip the guard either
    fire(w);
    expect(hits).toEqual(['plain', 'object']);
  });
});

describe('isFragmentNavigation', () => {
  it('only a change of the #fragment on the same URL', () => {
    expect(isFragmentNavigation('https://a.example/x', 'https://a.example/x#s')).toBe(true);
    expect(isFragmentNavigation('https://a.example/x#a', 'https://a.example/x#b')).toBe(true);
    expect(isFragmentNavigation('https://a.example/x?q=1', 'https://a.example/x?q=1#s')).toBe(true);
    // Not: another path or query, no fragment at all, the very same URL, junk.
    expect(isFragmentNavigation('https://a.example/x', 'https://a.example/y#s')).toBe(false);
    expect(isFragmentNavigation('https://a.example/x?q=1', 'https://a.example/x?q=2#s')).toBe(
      false,
    );
    expect(isFragmentNavigation('https://a.example/x#s', 'https://a.example/x')).toBe(false);
    expect(isFragmentNavigation('https://a.example/x#s', 'https://a.example/x#s')).toBe(false);
    expect(isFragmentNavigation(undefined, 'https://a.example/x#s')).toBe(false);
    expect(isFragmentNavigation('not a url', 'https://a.example/x#s')).toBe(false);
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
  /** The tab's own state as `chrome.tabs.get` reports it. */
  tab?: { active?: boolean; windowId?: number };
  /** `chrome.windows.get(...).focused`; undefined = no windows API at all. */
  windowFocused?: boolean;
  /** Answers a command before the defaults do (undefined = fall through). */
  onCommand?: (method: string, params?: Record<string, unknown>) => Promise<unknown> | undefined;
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
        return { id, windowId: 1, ...opts.tab };
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
    ...(opts.windowFocused === undefined
      ? {}
      : {
          windows: {
            async get(id: number) {
              return { id, focused: opts.windowFocused };
            },
          },
        }),
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
        const custom = opts.onCommand?.(method, params);
        if (custom !== undefined) return custom;
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
          params?.functionDeclaration === PREPARE_LEAVE_FN
        ) {
          return { result: { type: 'object', objectId: 'state' } };
        }
        if (method === 'Runtime.callFunctionOn' && params?.functionDeclaration === REARM_FN) {
          return { result: { type: 'boolean', value: true } };
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

describe('who is in front of the human', () => {
  it('the active tab of a focused window keeps its prompt — close and navigation alike', async () => {
    // The first tab of an agent window that took focus anyway, clicked into
    // inside the grace: no event ever marked it human, but a person is on it.
    mintEpoch(7);
    setBrokerMode(true);
    const io = stubChrome({ tab: { active: true }, windowFocused: true });
    expect(await inFrontOfHuman(7)).toBe(true);
    expect(await quietLeaveApproved(7)).toBe(false);
    expect(await closeAgentTab(7)).toBe('removed');
    expect(closes(io)).toEqual([]);
    expect(await closeAgentTab(7, { quietOnly: true }).catch(() => 'kept')).toBe('kept');
  });

  it('a background tab, or the active tab of an unfocused window, still goes quietly', async () => {
    mintEpoch(7);
    setBrokerMode(true);
    stubChrome({ tab: { active: false }, windowFocused: true });
    expect(await quietLeaveApproved(7)).toBe(true);
    stubChrome({ tab: { active: true }, windowFocused: false });
    expect(await quietLeaveApproved(7)).toBe(true);
    expect(await closeAgentTab(7)).toBe('quiet');
  });

  it('fails closed: a window it cannot read counts as in front', async () => {
    stubChrome({ tab: { active: true } }); // no windows API
    expect(await inFrontOfHuman(7)).toBe(true);
  });
});

describe('disarmBeforeUnload / rearmIfSameDocument', () => {
  const fns = (io: { sent: Sent[] }) =>
    io.sent
      .filter((s) => s.method === 'Runtime.callFunctionOn')
      .map((s) => s.params?.functionDeclaration);

  it('one fixed function, the handlers as structured arguments, in the call group', async () => {
    const io = stubChrome({
      loaderIds: ['L1'],
      listeners: [
        { type: 'beforeunload', useCapture: false, handler: { objectId: 'h1' } },
        { type: 'beforeunload', useCapture: true, originalHandler: { objectId: 'o2' } },
        { type: 'click', useCapture: false, handler: { objectId: 'c' } },
      ],
    });
    const d = await disarmBeforeUnload(7);
    expect(d).toEqual({ stateId: 'state', count: 2, loaderId: 'L1' });
    expect(io.sent[0]).toEqual({
      tabId: 7,
      method: 'Runtime.evaluate',
      params: { expression: 'window', objectGroup: CALL_GROUP },
    });
    const calls = io.sent.filter((s) => s.method === 'Runtime.callFunctionOn');
    expect(calls.map((c) => c.params?.functionDeclaration)).toEqual([PREPARE_LEAVE_FN, DISARM_FN]);
    expect(calls[0].params).toMatchObject({
      objectId: 'win',
      arguments: [{ objectId: 'h1' }, { value: false }, { objectId: 'o2' }, { value: true }],
    });
    expect(calls[1].params).toEqual({ objectId: 'state', functionDeclaration: DISARM_FN });
  });

  it('touches nothing when the page has no beforeunload listener', async () => {
    const io = stubChrome({ listeners: [{ type: 'click', handler: { objectId: 'x' } }] });
    expect(await disarmBeforeUnload(7)).toBeNull();
    expect(fns(io)).toEqual([]);
  });

  it('gives the guard back on the same document', async () => {
    const io = stubChrome({ loaderIds: ['L1'] });
    const d = await disarmBeforeUnload(7);
    io.sent.length = 0;
    expect(await rearmIfSameDocument(7, d)).toBe(true);
    const rearm = io.sent.find((s) => s.method === 'Runtime.callFunctionOn');
    expect(rearm?.params).toEqual({
      objectId: 'state',
      functionDeclaration: REARM_FN,
      returnByValue: true,
    });
  });

  it('sends nothing to a document that is known to be another one', async () => {
    const io = stubChrome({ loaderIds: ['L1', 'L2'] });
    const d = await disarmBeforeUnload(7);
    io.sent.length = 0;
    expect(await rearmIfSameDocument(7, d)).toBe(false);
    expect(fns(io)).toEqual([]);
  });

  it('an UNKNOWN loader id does not strand the guard: the restore is still sent', async () => {
    // getFrameTree unanswered at disarm time used to mean "never restorable".
    let io = stubChrome({});
    let d = await disarmBeforeUnload(7);
    expect(d?.loaderId).toBeNull();
    io.sent.length = 0;
    expect(await rearmIfSameDocument(7, d)).toBe(true);
    expect(fns(io)).toEqual([REARM_FN]);
    // …and the same when it is the after-read that goes unanswered.
    let first = true;
    io = stubChrome({
      loaderIds: ['L1'],
      onCommand: (method) => {
        if (method !== 'Page.getFrameTree' || first) {
          if (method === 'Page.getFrameTree') first = false;
          return undefined;
        }
        return new Promise(() => {});
      },
    });
    d = await disarmBeforeUnload(7);
    io.sent.length = 0;
    expect(await rearmIfSameDocument(7, d)).toBe(true);
    expect(fns(io)).toEqual([REARM_FN]);
  });

  it('nothing to give back is not an error, and a dead document is not either', async () => {
    stubChrome({});
    expect(await rearmIfSameDocument(7, null)).toBe(false);
    stubChrome({
      onCommand: (method) =>
        method === 'Runtime.callFunctionOn'
          ? Promise.reject(new Error('Cannot find context with specified id'))
          : undefined,
    });
    expect(await rearmIfSameDocument(7, { stateId: 'state', count: 1, loaderId: null })).toBe(
      false,
    );
  });

  it('a disarm that loses its deadline BEFORE the change sends nothing that changes the page — not even late', async () => {
    vi.useFakeTimers();
    try {
      let answer: (v: unknown) => void = () => {};
      const io = stubChrome({
        loaderIds: ['L1'],
        onCommand: (method) =>
          method === 'DOMDebugger.getEventListeners'
            ? new Promise((resolve) => (answer = resolve))
            : undefined,
      });
      const out = disarmBeforeUnload(7);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await out).toBeNull();
      // The busy renderer answers after the caller moved on (a #hash kept the
      // same document): the old code removed the guard now, with no record.
      answer({ listeners: [{ type: 'beforeunload', handler: { objectId: 'h1' } }] });
      await vi.advanceTimersByTimeAsync(100);
      expect(fns(io)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a disarm that loses its deadline AFTER sending the change still hands back the handle', async () => {
    vi.useFakeTimers();
    try {
      const io = stubChrome({
        loaderIds: ['L1'],
        onCommand: (method, params) =>
          method === 'Runtime.callFunctionOn' && params?.functionDeclaration === DISARM_FN
            ? new Promise(() => {})
            : undefined,
      });
      const out = disarmBeforeUnload(7);
      await vi.advanceTimersByTimeAsync(1_500);
      const d = await out;
      expect(d).toEqual({ stateId: 'state', count: 1, loaderId: 'L1' });
      // …so the caller's finally can still restore (CDP runs it after the disarm).
      const back = rearmIfSameDocument(7, d);
      await vi.advanceTimersByTimeAsync(100);
      expect(await back).toBe(true);
      expect(fns(io)).toEqual([PREPARE_LEAVE_FN, DISARM_FN, REARM_FN]);
    } finally {
      vi.useRealTimers();
    }
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

  it('a page that threw inside the prepare step is left alone', async () => {
    const io = stubChrome({
      onCommand: (method, params) =>
        method === 'Runtime.callFunctionOn' && params?.functionDeclaration === PREPARE_LEAVE_FN
          ? Promise.resolve({ result: { objectId: 'err' }, exceptionDetails: { text: 'x' } })
          : undefined,
    });
    expect(await disarmBeforeUnload(7)).toBeNull();
    expect(fns(io)).toEqual([PREPARE_LEAVE_FN]);
  });
});
