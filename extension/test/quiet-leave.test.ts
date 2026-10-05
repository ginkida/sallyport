import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DISARM_FN,
  PREPARE_LEAVE_FN,
  REARM_FN,
  beforeUnloadCount,
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

describe('beforeUnloadCount', () => {
  it('counts well-formed beforeunload entries only (the IDL handler is one)', () => {
    expect(
      beforeUnloadCount([
        { type: 'beforeunload', useCapture: true, handler: { objectId: 'a' } },
        { type: 'beforeunload', useCapture: false },
        { type: 'unload', handler: { objectId: 'c' } },
        null,
        'junk',
      ]),
    ).toBe(2);
    expect(beforeUnloadCount(undefined)).toBe(0);
    expect(beforeUnloadCount({ length: 3 })).toBe(0);
  });
});

describe('PREPARE_LEAVE_FN, run standalone', () => {
  type Listener = ((e: unknown) => unknown) | { handleEvent: (e: unknown) => unknown };
  type Opts = boolean | { capture?: boolean; once?: boolean; signal?: AbortSignal } | undefined;
  type Entry = { type: string; fn: Listener; capture: boolean; once: boolean };
  type Controller = { disarm: () => void; restore: () => boolean };

  /** A miniature page realm: its OWN Event / BeforeUnloadEvent prototypes
   * (never Node's), a window whose listener list the test can see, and the
   * browser's leave algorithm — listeners in registration order, then the IDL
   * handler, whose return value cancels NATIVELY (past any JS shadow), then
   * "would Chrome ask?". */
  function fakePage() {
    class PEvent {
      _type: string;
      _cancelled = false;
      persisted = false;
      constructor(type: string) {
        this._type = type;
      }
    }
    Object.defineProperty(PEvent.prototype, 'type', {
      configurable: true,
      get(this: PEvent) {
        return this._type;
      },
    });
    Object.defineProperty(PEvent.prototype, 'preventDefault', {
      configurable: true,
      writable: true,
      value: function (this: PEvent) {
        this._cancelled = true;
      },
    });
    class PBeforeUnloadEvent extends PEvent {
      _rv = '';
      constructor() {
        super('beforeunload');
      }
    }
    Object.defineProperty(PBeforeUnloadEvent.prototype, 'returnValue', {
      configurable: true,
      enumerable: true,
      get(this: PBeforeUnloadEvent) {
        return this._rv;
      },
      set(this: PBeforeUnloadEvent, v: unknown) {
        this._rv = String(v);
      },
    });
    const nativeCancel = (e: PEvent) => (e._cancelled = true); // C++, no JS involved
    const list: Entry[] = [];
    let idl: unknown = null;
    const capOf = (o: Opts) => (typeof o === 'boolean' ? o : !!o?.capture);
    const drop = (entry: Entry) => {
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
    };
    const proto = {};
    Object.defineProperty(proto, 'onbeforeunload', {
      configurable: true,
      enumerable: true,
      get: () => idl,
      set: (v: unknown) => {
        idl = typeof v === 'function' ? v : null;
      },
    });
    const w = Object.create(proto) as Record<string, unknown> & {
      addEventListener: (type: string, fn: Listener, o?: Opts) => void;
      removeEventListener: (type: string, fn: Listener, o?: Opts) => void;
      onbeforeunload: unknown;
    };
    Object.assign(w, {
      Event: PEvent,
      BeforeUnloadEvent: PBeforeUnloadEvent,
      addEventListener(type: string, fn: Listener, o?: Opts) {
        const capture = capOf(o);
        if (list.some((e) => e.type === type && e.fn === fn && e.capture === capture)) return;
        const entry = { type, fn, capture, once: typeof o === 'object' && !!o.once };
        list.push(entry);
        // The browser's abort algorithm: no JS removeEventListener involved.
        if (typeof o === 'object') o.signal?.addEventListener('abort', () => drop(entry));
      },
      removeEventListener(type: string, fn: Listener, o?: Opts) {
        const capture = capOf(o);
        const at = list.findIndex((e) => e.type === type && e.fn === fn && e.capture === capture);
        if (at >= 0) list.splice(at, 1);
      },
    });
    const dispatch = (e: PEvent) => {
      for (const entry of list.filter((x) => x.type === e._type)) {
        if (!list.includes(entry)) continue;
        if (entry.once) drop(entry);
        if (typeof entry.fn === 'function') entry.fn.call(w, e);
        else entry.fn.handleEvent(e);
      }
    };
    return {
      w,
      PEvent,
      PBeforeUnloadEvent,
      list,
      /** Would Chrome raise "Leave site?" for this leave? */
      leave(): boolean {
        const e = new PBeforeUnloadEvent();
        dispatch(e);
        if (typeof idl === 'function' && (idl as (e: unknown) => unknown).call(w, e) != null)
          nativeCancel(e);
        return e._cancelled || e._rv !== '';
      },
      pageshow(persisted: boolean) {
        const e = new PEvent('pageshow');
        e.persisted = persisted;
        dispatch(e);
      },
      count: (type = 'beforeunload') => list.filter((e) => e.type === type).length,
    };
  }
  const prepare = new Function(`return (${PREPARE_LEAVE_FN})`)() as (
    this: unknown,
    ...args: unknown[]
  ) => Controller | null;
  /** Prepared the way it runs, but ALSO handed the native registrations as
   * `fn, capture` pairs — what `DOMDebugger.getEventListeners` reports, and
   * what the old remove/re-add literal took. The literal ignores arguments;
   * passing them anyway makes these cases pin the BEHAVIOUR, so they fail on
   * that design rather than pass vacuously. */
  const prepareReported = (page: ReturnType<typeof fakePage>) =>
    prepare.call(
      page.w,
      ...page.list.filter((e) => e.type === 'beforeunload').flatMap((e) => [e.fn, e.capture]),
    )!;

  function setup() {
    const page = fakePage();
    const hits: string[] = [];
    page.w.addEventListener('beforeunload', (e) => {
      hits.push('plain');
      (e as { preventDefault: () => void }).preventDefault();
    });
    // A capture-phase handleEvent object that cancels by returnValue alone.
    page.w.addEventListener(
      'beforeunload',
      {
        handleEvent: (e) => {
          hits.push('object');
          (e as { returnValue: unknown }).returnValue = 'unsaved';
        },
      },
      true,
    );
    const idl = () => {
      hits.push('idl');
      return 'unsaved';
    };
    page.w.onbeforeunload = idl;
    const ctl = prepareReported(page);
    return { ...page, hits, idl, ctl };
  }

  it('changes nothing until disarm; then no leave is cancelled — yet every listener still runs', () => {
    const t = setup();
    expect(t.leave()).toBe(true);
    t.hits.length = 0;
    t.ctl.disarm();
    expect(t.leave()).toBe(false);
    // A last-moment draft save in a listener still happens; only the IDL
    // handler (whose return value the browser applies natively) is lifted off.
    expect(t.hits).toEqual(['plain', 'object']);
    expect(t.w.onbeforeunload).toBeNull();
    // The page's listener LIST is never touched.
    expect(t.count()).toBe(2);
  });

  it('only a beforeunload event loses its cancel: any other preventDefault still works', () => {
    const t = setup();
    t.ctl.disarm();
    const click = new t.PEvent('click');
    (click as unknown as { preventDefault: () => void }).preventDefault();
    expect(click._cancelled).toBe(true);
  });

  it('restore gives back the prototypes and the IDL handler; a leave asks again', () => {
    const t = setup();
    const pd = Object.getOwnPropertyDescriptor(t.PEvent.prototype, 'preventDefault');
    const rv = Object.getOwnPropertyDescriptor(t.PBeforeUnloadEvent.prototype, 'returnValue');
    t.ctl.disarm();
    expect(t.ctl.restore()).toBe(true);
    expect(Object.getOwnPropertyDescriptor(t.PEvent.prototype, 'preventDefault')).toEqual(pd);
    expect(Object.getOwnPropertyDescriptor(t.PBeforeUnloadEvent.prototype, 'returnValue')).toEqual(
      rv,
    );
    expect(t.w.onbeforeunload).toBe(t.idl);
    expect(Object.prototype.hasOwnProperty.call(t.w, 'onbeforeunload')).toBe(false);
    expect(t.leave()).toBe(true);
    expect(t.count('pageshow')).toBe(0); // its own hook is gone too
    expect(t.ctl.restore()).toBe(false); // once
  });

  it('a listener the page dropped through an AbortSignal meanwhile stays dropped', () => {
    // The old remove/re-add brought it back — re-added with no signal, so the
    // page could never take it off again.
    const page = fakePage();
    const ac = new AbortController();
    page.w.addEventListener(
      'beforeunload',
      (e) => ((e as { returnValue: unknown }).returnValue = 'x'),
      {
        signal: ac.signal,
      },
    );
    const ctl = prepareReported(page);
    ctl.disarm();
    ac.abort(); // an SPA route change unmounting its editor
    ctl.restore();
    expect(page.count()).toBe(0);
    expect(page.leave()).toBe(false);
  });

  it('a once listener keeps its once-ness across a disarm and restore', () => {
    const page = fakePage();
    let fired = 0;
    page.w.addEventListener('beforeunload', () => fired++, { once: true });
    const ctl = prepareReported(page);
    ctl.disarm();
    ctl.restore();
    page.leave();
    page.leave();
    expect(fired).toBe(1);
  });

  it('a page whose add/removeEventListener multiplex (zone.js) keeps its guard, exactly once', () => {
    // zone.js registers ONE native callback per type and keeps the page's
    // handlers in its own task list. Routed through it, the old remove/re-add
    // lost the guard (the re-add was "existing", so never native) or ran it
    // hundreds of times. Now neither is ever called for beforeunload.
    const page = fakePage();
    const nativeAdd = page.w.addEventListener;
    const nativeRemove = page.w.removeEventListener;
    const tasks = new Map<string, Listener[]>();
    const calls: string[] = [];
    const shared = function (this: unknown, e: unknown) {
      for (const fn of [...(tasks.get((e as { type: string }).type) ?? [])])
        (fn as (e: unknown) => unknown).call(this, e);
    };
    page.w.addEventListener = (type, fn, o) => {
      calls.push('add:' + type);
      const list = tasks.get(type) ?? [];
      if (list.length === 0) nativeAdd(type, shared, o);
      tasks.set(type, [...list, fn]);
    };
    page.w.removeEventListener = (type, fn, o) => {
      calls.push('remove:' + type);
      const list = tasks.get(type) ?? [];
      if (!list.includes(fn)) return nativeRemove(type, fn, o); // zone's fallthrough
      const next = list.filter((x) => x !== fn);
      tasks.set(type, next);
      if (next.length === 0) nativeRemove(type, shared, o);
    };
    let fired = 0;
    page.w.addEventListener('beforeunload', (e) => {
      fired++;
      (e as { preventDefault: () => void }).preventDefault();
    });
    calls.length = 0;
    const ctl = prepareReported(page);
    ctl.disarm();
    expect(page.leave()).toBe(false);
    ctl.restore();
    expect(calls.filter((c) => c.endsWith(':beforeunload'))).toEqual([]);
    expect(page.count()).toBe(1); // the native registration is untouched
    fired = 0;
    expect(page.leave()).toBe(true);
    expect(fired).toBe(1);
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

  it('never takes down a preventDefault or returnValue the page installed itself meanwhile', () => {
    const t = setup();
    t.ctl.disarm();
    const pages = function () {};
    t.PEvent.prototype['preventDefault' as keyof typeof t.PEvent.prototype] = pages as never;
    const rv = { configurable: true, get: () => 'mine', set: () => {} };
    Object.defineProperty(t.PBeforeUnloadEvent.prototype, 'returnValue', rv);
    t.ctl.restore();
    expect(Object.getOwnPropertyDescriptor(t.PEvent.prototype, 'preventDefault')?.value).toBe(
      pages,
    );
    expect(
      Object.getOwnPropertyDescriptor(t.PBeforeUnloadEvent.prototype, 'returnValue')?.get,
    ).toBe(rv.get);
  });

  it('a document restored from the back/forward cache gets its guard back on pageshow', () => {
    const t = setup();
    t.ctl.disarm();
    t.pageshow(false); // an ordinary pageshow is not a return
    expect(t.leave()).toBe(false);
    t.pageshow(true);
    expect(t.leave()).toBe(true);
    expect(t.w.onbeforeunload).toBe(t.idl);
    expect(t.ctl.restore()).toBe(false); // already done — the extension's rearm is a no-op
  });

  it('restore before disarm changes nothing', () => {
    const t = setup();
    expect(t.ctl.restore()).toBe(false);
    t.ctl.disarm(); // a late disarm after a restore must not disarm the guard either
    expect(t.leave()).toBe(true);
    expect(t.w.onbeforeunload).toBe(t.idl);
  });

  it('a page with nothing to shadow gets no controller — no quiet leave', () => {
    const page = fakePage();
    delete page.w.BeforeUnloadEvent;
    expect(prepare.call(page.w)).toBeNull();
    expect(prepare.call({})).toBeNull();
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

  it('one fixed function with no arguments, its lookups in the call group', async () => {
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
    expect(io.sent[1]).toEqual({
      tabId: 7,
      method: 'DOMDebugger.getEventListeners',
      params: { objectId: 'win', objectGroup: CALL_GROUP },
    });
    const calls = io.sent.filter((s) => s.method === 'Runtime.callFunctionOn');
    expect(calls.map((c) => c.params?.functionDeclaration)).toEqual([PREPARE_LEAVE_FN, DISARM_FN]);
    expect(calls[0].params).toEqual({ objectId: 'win', functionDeclaration: PREPARE_LEAVE_FN });
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
