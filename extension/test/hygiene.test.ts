/**
 * The idle hygiene flush (cdp.ts): what a CDP session leaves enabled — an
 * AXContext, the DOM agent, per-call object groups, the console group — is
 * released once a tab has been idle for HYGIENE_IDLE_MS, never inside a call.
 *
 * Chrome-mocked with fake timers. Every test loads a FRESH cdp.ts/tab-chain.ts
 * pair (vi.resetModules) so the per-tab timers and flags of one test cannot
 * leak into the next.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Source = { tabId?: number; sessionId?: string };
type Listener = (...args: unknown[]) => void;
type Call = { tabId?: number; sessionId?: string; method: string; params?: unknown };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const IDLE = 10_000;

let calls: Call[];
let respond: (method: string, params: unknown, source: Source) => unknown;
let removedListeners: Listener[];
let detachListeners: Listener[];
let getTargets: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  calls = [];
  respond = () => ({});
  removedListeners = [];
  detachListeners = [];
  getTargets = vi.fn().mockResolvedValue([]);
  vi.stubGlobal('chrome', {
    debugger: {
      sendCommand: (source: Source, method: string, params?: unknown) => {
        calls.push({ tabId: source.tabId, sessionId: source.sessionId, method, params });
        return respond(method, params, source);
      },
      detach: vi.fn().mockResolvedValue(undefined),
      getTargets,
      onDetach: { addListener: (l: Listener) => detachListeners.push(l) },
      onEvent: { addListener: () => undefined },
    },
    tabs: { onRemoved: { addListener: (l: Listener) => removedListeners.push(l) } },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function load() {
  const cdp = await import('../src/tools/cdp.js');
  const chain = await import('../src/tools/tab-chain.js');
  return { ...cdp, onTab: chain.onTab };
}

/** Calls the flush made (the ones after `mark`), as `method` or
 * `method(objectGroup)` for the group releases. */
function flushed(mark = 0, tabId = 1): string[] {
  return calls
    .slice(mark)
    .filter((c) => c.tabId === tabId && c.sessionId === undefined)
    .map((c) => {
      const group = (c.params as { objectGroup?: string } | undefined)?.objectGroup;
      return group ? `${c.method}(${group})` : c.method;
    });
}

/** The invariant the whole AX release rests on: a disable is ALWAYS the very
 * next command after an enable on the same session, never alone. */
function expectNoBareAxDisable(): void {
  calls.forEach((c, i) => {
    if (c.method !== 'Accessibility.disable') return;
    const prev = calls[i - 1];
    expect(prev?.method).toBe('Accessibility.enable');
    expect(prev?.tabId).toBe(c.tabId);
    expect(prev?.sessionId).toBe(c.sessionId);
  });
}

describe('idle hygiene flush', () => {
  it('releases only the call group after a call that touched neither DOM nor AX', async () => {
    const { cdp, CALL_GROUP, HYGIENE_IDLE_MS } = await load();
    expect(HYGIENE_IDLE_MS).toBe(IDLE);
    expect(CALL_GROUP).toBe('sallyport-call');
    await cdp(1, 'Page.getFrameTree');
    const mark = calls.length;

    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(flushed(mark)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(flushed(mark)).toEqual(['Runtime.releaseObjectGroup(sallyport-call)']);
    expectNoBareAxDisable();
  });

  it('disables DOM only when DOM was used, and pairs Accessibility only when AX was used', async () => {
    const { cdp } = await load();
    await cdp(1, 'DOM.getDocument', { depth: 0 });
    let mark = calls.length;
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(flushed(mark)).toEqual(['Runtime.releaseObjectGroup(sallyport-call)', 'DOM.disable']);

    await cdp(1, 'Accessibility.queryAXTree', { objectId: 'o' });
    mark = calls.length;
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(flushed(mark)).toEqual([
      'Runtime.releaseObjectGroup(sallyport-call)',
      'Accessibility.enable',
      'Accessibility.disable',
    ]);

    await cdp(1, 'DOM.describeNode', { backendNodeId: 3 });
    await cdp(1, 'Accessibility.getFullAXTree');
    mark = calls.length;
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(flushed(mark)).toEqual([
      'Runtime.releaseObjectGroup(sallyport-call)',
      'DOM.disable',
      'Accessibility.enable',
      'Accessibility.disable',
    ]);
    expectNoBareAxDisable();
  });

  it('clears the flags: the next idle period does not repeat DOM/AX work nobody did', async () => {
    const { cdp } = await load();
    await cdp(1, 'Accessibility.getFullAXTree');
    await cdp(1, 'DOM.getDocument');
    await vi.advanceTimersByTimeAsync(IDLE);
    await cdp(1, 'Page.getFrameTree');
    const mark = calls.length;
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(flushed(mark)).toEqual(['Runtime.releaseObjectGroup(sallyport-call)']);
  });

  it('sends Accessibility.disable without waiting for the enable to answer', async () => {
    const { cdp, onTab } = await load();
    respond = (method) =>
      method === 'Accessibility.enable' ? new Promise(() => undefined) : Promise.resolve({});
    await cdp(1, 'Accessibility.getFullAXTree');
    const mark = calls.length;
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(flushed(mark)).toEqual([
      'Runtime.releaseObjectGroup(sallyport-call)',
      'Accessibility.enable',
      'Accessibility.disable',
    ]);
    expectNoBareAxDisable();

    // The enable never answers; the chain is still free once the bound passes.
    const ran = vi.fn();
    void onTab(1, async () => ran());
    await vi.advanceTimersByTimeAsync(1_999);
    expect(ran).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ran).toHaveBeenCalledOnce();
  });

  it('never flushes while a command for the tab is in flight', async () => {
    const { cdp } = await load();
    const slow = deferred<object>();
    respond = (method) => (method === 'Runtime.callFunctionOn' ? slow.promise : {});
    await cdp(1, 'DOM.resolveNode', { backendNodeId: 1 });
    const pending = cdp(1, 'Runtime.callFunctionOn', { objectId: 'x' });
    const mark = calls.length;

    await vi.advanceTimersByTimeAsync(IDLE * 6);
    expect(flushed(mark)).toEqual([]);

    slow.resolve({});
    await pending;
    // Idle is counted from the ANSWER, not from when it was sent.
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(flushed(mark)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(flushed(mark)).toEqual(['Runtime.releaseObjectGroup(sallyport-call)', 'DOM.disable']);
  });

  it('activity inside the window pushes the flush back, with one timer per tab', async () => {
    const { cdp } = await load();
    await cdp(1, 'DOM.getDocument');
    for (let i = 0; i < 5; i++) await cdp(1, 'DOM.describeNode');
    expect(vi.getTimerCount()).toBe(1);
    const mark = calls.length;

    await vi.advanceTimersByTimeAsync(6_000);
    await cdp(1, 'DOM.querySelector');
    const mark2 = calls.length;
    await vi.advanceTimersByTimeAsync(4_000); // 10 s after the FIRST call
    expect(flushed(mark2)).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(6_000); // 10 s after the last
    expect(flushed(mark).filter((m) => m.startsWith('Runtime.releaseObjectGroup'))).toHaveLength(1);
    expect(flushed(mark2)).toEqual(['Runtime.releaseObjectGroup(sallyport-call)', 'DOM.disable']);
  });

  it('keeps tabs apart: activity on one tab does not hold back another', async () => {
    const { cdp } = await load();
    await cdp(1, 'DOM.getDocument');
    await vi.advanceTimersByTimeAsync(5_000);
    await cdp(2, 'DOM.getDocument');
    const mark = calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(flushed(mark, 1)).toEqual(['Runtime.releaseObjectGroup(sallyport-call)', 'DOM.disable']);
    expect(flushed(mark, 2)).toEqual([]);
  });

  it('runs through the tab chain: a call queued on the tab finishes first', async () => {
    const { cdp, onTab } = await load();
    await cdp(1, 'DOM.getDocument');
    const gate = deferred<void>();
    const order: string[] = [];
    // A call on the chain that does no CDP for longer than the idle window
    // (a page-load wait, say) — it must not have the flush land inside it.
    void onTab(1, async () => {
      await gate.promise;
      order.push('call done');
    });
    const mark = calls.length;
    await vi.advanceTimersByTimeAsync(IDLE * 3);
    expect(flushed(mark)).toEqual([]);

    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['call done']);
    expect(flushed(mark)).toEqual(['Runtime.releaseObjectGroup(sallyport-call)', 'DOM.disable']);
  });

  it('re-checks idleness inside the chain: a queued call that used CDP postpones the flush', async () => {
    const { cdp, onTab } = await load();
    await cdp(1, 'Accessibility.getFullAXTree');
    const gate = deferred<void>();
    void onTab(1, async () => {
      await gate.promise;
      await cdp(1, 'Accessibility.queryAXTree');
    });
    const mark = calls.length;
    await vi.advanceTimersByTimeAsync(IDLE);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    // The flush that was queued behind the call found the tab busy again.
    expect(flushed(mark)).toEqual(['Accessibility.queryAXTree']);
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(flushed(mark)).toEqual([
      'Accessibility.queryAXTree',
      'Runtime.releaseObjectGroup(sallyport-call)',
      'Accessibility.enable',
      'Accessibility.disable',
    ]);
    expectNoBareAxDisable();
  });

  it('a flush whose commands fail or throw never throws and leaves the chain usable', async () => {
    const { cdp, onTab } = await load();
    await cdp(1, 'DOM.getDocument');
    await cdp(1, 'Accessibility.getFullAXTree');
    respond = (method) => {
      if (method === 'DOM.disable') throw new Error('sync throw from the API');
      return Promise.reject(new Error('Debugger is not attached to the tab'));
    };
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const mark = calls.length;
      await vi.advanceTimersByTimeAsync(IDLE);
      // Every step was still attempted — one failing does not skip the rest,
      // and the AX pair stays whole.
      expect(flushed(mark)).toEqual([
        'Runtime.releaseObjectGroup(sallyport-call)',
        'DOM.disable',
        'Accessibility.enable',
        'Accessibility.disable',
      ]);
      const ran = vi.fn();
      await onTab(1, async () => ran());
      expect(ran).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a wedged renderer holds the chain for at most the flush bound', async () => {
    const { cdp, onTab, HYGIENE_FLUSH_DEADLINE_MS } = await load();
    await cdp(1, 'DOM.getDocument');
    respond = () => new Promise(() => undefined);
    await vi.advanceTimersByTimeAsync(IDLE);
    const ran = vi.fn();
    void onTab(1, async () => ran());
    await vi.advanceTimersByTimeAsync(HYGIENE_FLUSH_DEADLINE_MS - 1);
    expect(ran).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ran).toHaveBeenCalledOnce();
  });

  it("the flush's own commands are not activity: it does not re-arm itself", async () => {
    const { cdp } = await load();
    await cdp(1, 'DOM.getDocument');
    await vi.advanceTimersByTimeAsync(IDLE);
    const mark = calls.length;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(IDLE * 10);
    expect(calls.slice(mark)).toEqual([]);
  });

  it('releases the console group only while console capture is active on the tab', async () => {
    const { cdp } = await load();
    const capture = await import('../src/tools/console-capture.js');
    await cdp(1, 'Page.getFrameTree');
    await cdp(2, 'Page.getFrameTree');
    await capture.ensureConsoleCapture(2);
    const mark = calls.length;
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(flushed(mark, 1)).toEqual(['Runtime.releaseObjectGroup(sallyport-call)']);
    expect(flushed(mark, 2)).toEqual([
      'Runtime.releaseObjectGroup(sallyport-call)',
      'Runtime.releaseObjectGroup(console)',
    ]);
    // Never the browser-wide wipe, which takes the human's DevTools console too.
    expect(calls.map((c) => c.method)).not.toContain('Runtime.discardConsoleEntries');
  });

  it('a closed tab drops its timer', async () => {
    const { cdp } = await load();
    await cdp(1, 'DOM.getDocument');
    expect(vi.getTimerCount()).toBe(1);
    for (const l of removedListeners) l(1);
    expect(vi.getTimerCount()).toBe(0);
    const mark = calls.length;
    await vi.advanceTimersByTimeAsync(IDLE * 2);
    expect(calls.slice(mark)).toEqual([]);
  });

  it('a debugger detach (event or explicit) drops the timer', async () => {
    const { cdp, detach } = await load();
    await cdp(1, 'DOM.getDocument');
    for (const l of detachListeners) l({ tabId: 1 }, 'canceled_by_user');
    expect(vi.getTimerCount()).toBe(0);

    await cdp(2, 'Accessibility.getFullAXTree');
    await detach(2);
    const mark = calls.length;
    await vi.advanceTimersByTimeAsync(IDLE * 2);
    expect(calls.slice(mark)).toEqual([]);
  });

  it('a command answered after its tab was dropped does not resurrect the timer', async () => {
    const { cdp } = await load();
    const slow = deferred<object>();
    respond = () => slow.promise;
    const pending = cdp(1, 'DOM.getDocument');
    for (const l of removedListeners) l(1);
    slow.resolve({});
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('child-session commands are activity but set no root flags', async () => {
    const { cdpSession } = await load();
    await cdpSession(1, 'child', 'Accessibility.getFullAXTree');
    await cdpSession(1, 'child', 'DOM.describeNode');
    const mark = calls.length;
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(flushed(mark)).toEqual(['Runtime.releaseObjectGroup(sallyport-call)']);
  });
});

describe('startup sweep', () => {
  it('fully flushes every tab still attached, at once, and skips the rest', async () => {
    const { sweepStrandedHygiene } = await load();
    getTargets.mockResolvedValue([
      { attached: true, tabId: 5, type: 'page' },
      { attached: false, tabId: 6, type: 'page' },
      { attached: true, type: 'worker' },
    ]);
    await sweepStrandedHygiene();
    await vi.advanceTimersByTimeAsync(0);
    expect(flushed(0, 5)).toEqual([
      'Runtime.releaseObjectGroup(sallyport-call)',
      'DOM.disable',
      'Accessibility.enable',
      'Accessibility.disable',
      'Runtime.releaseObjectGroup(console)',
    ]);
    expect(calls.filter((c) => c.tabId !== 5)).toEqual([]);
    expectNoBareAxDisable();
  });

  it('a tab already driven again waits for its idle window, then gets the full flush', async () => {
    const { cdp, sweepStrandedHygiene } = await load();
    getTargets.mockResolvedValue([{ attached: true, tabId: 5, type: 'page' }]);
    await cdp(5, 'Page.getFrameTree');
    const mark = calls.length;
    await sweepStrandedHygiene();
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(flushed(mark, 5)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(flushed(mark, 5)).toEqual([
      'Runtime.releaseObjectGroup(sallyport-call)',
      'DOM.disable',
      'Accessibility.enable',
      'Accessibility.disable',
      'Runtime.releaseObjectGroup(console)',
    ]);
  });

  it('never throws when the debugger API refuses', async () => {
    const { sweepStrandedHygiene } = await load();
    getTargets.mockRejectedValue(new Error('no'));
    await expect(sweepStrandedHygiene()).resolves.toBeUndefined();
    getTargets.mockImplementation(() => {
      throw new Error('sync');
    });
    await expect(sweepStrandedHygiene()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('releaseChildAx', () => {
  it('sends the pair back to back on the child session and never throws', async () => {
    const { releaseChildAx } = await load();
    respond = (method) =>
      method === 'Accessibility.enable'
        ? new Promise(() => undefined)
        : Promise.reject(new Error());
    const done = releaseChildAx(1, 'child');
    expect(calls).toEqual([
      { tabId: 1, sessionId: 'child', method: 'Accessibility.enable', params: undefined },
      { tabId: 1, sessionId: 'child', method: 'Accessibility.disable', params: undefined },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(done).resolves.toBeUndefined();
  });
});
