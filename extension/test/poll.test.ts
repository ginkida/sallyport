import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  advanceSettle,
  classifyWaitError,
  INITIAL_SETTLE_STATE,
  parseMaxSteps,
  parseTimeoutMs,
  parseWaitFor,
  SCROLL_BY_PROBE,
  SCROLL_INTO_VIEW_PROBE,
  SCROLL_STEP_PROBE,
  scrollStalled,
  pollFor,
  settleFor,
} from '../src/tools/poll.js';
import { BridgeError } from '../src/tools/errors.js';
import { setAllowlist } from '../src/storage.js';
import { resetAttachedTabs } from '../src/tools/cdp.js';
import { CREATE_QUIESCENCE_PROBE } from '../src/tools/quiescence.js';

describe('parseTimeoutMs', () => {
  it('defaults when undefined', () => {
    expect(parseTimeoutMs(undefined, 't')).toBe(10_000);
  });

  it('accepts zero and plain numbers', () => {
    expect(parseTimeoutMs(0, 't')).toBe(0);
    expect(parseTimeoutMs(5000, 't')).toBe(5000);
  });

  it('caps at 30 s (stays under the daemon wire timeout)', () => {
    expect(parseTimeoutMs(120_000, 't')).toBe(30_000);
  });

  it('rejects negatives and non-numbers with the tool name in the message', () => {
    expect(() => parseTimeoutMs(-1, 'click')).toThrowError(/click.*timeoutMs/);
    expect(() => parseTimeoutMs('soon', 'click')).toThrowError(/timeoutMs/);
  });
});

describe('parseWaitFor', () => {
  it('returns null when absent', () => {
    expect(parseWaitFor(undefined, 't')).toBeNull();
    expect(parseWaitFor(null, 't')).toBeNull();
  });

  it('parses a full spec', () => {
    expect(
      parseWaitFor({ selector: '.chat', text: 'Sent', timeoutMs: 5000, absent: true }, 't'),
    ).toEqual({
      selector: '.chat',
      text: 'Sent',
      timeoutMs: 5000,
      absent: true,
    });
  });

  it('defaults timeout and absent', () => {
    expect(parseWaitFor({ selector: '#x' }, 't')).toEqual({
      selector: '#x',
      text: null,
      timeoutMs: 10_000,
      absent: false,
    });
  });

  it('treats empty strings as missing', () => {
    expect(parseWaitFor({ selector: '', text: 'ok' }, 't')?.selector).toBeNull();
  });

  it('rejects non-objects loudly (typos must not skip the wait silently)', () => {
    expect(() => parseWaitFor('.selector', 't')).toThrowError(/waitFor must be an object/);
    expect(() => parseWaitFor(['.a'], 't')).toThrowError(/waitFor must be an object/);
  });

  it('rejects a spec with neither selector nor text', () => {
    expect(() => parseWaitFor({ timeoutMs: 100 }, 'fill')).toThrowError(
      /fill.*selector and\/or text/,
    );
  });
});

describe('SCROLL_STEP_PROBE (reveal)', () => {
  it('is self-contained and scrolls the container by ~90% of its viewport', () => {
    // reveal serialises this into the page and invokes it on the container via
    // callFunctionOn; the direction is the only argument and travels as a
    // structured value, never interpolated.
    const fn = new Function(`return (${SCROLL_STEP_PROBE});`)() as (
      this: { scrollTop: number; clientHeight: number; scrollHeight: number },
      dir: number,
    ) => { before: number; after: number; scrollHeight: number };
    const container = { scrollTop: 100, clientHeight: 200, scrollHeight: 1000 };
    const down = fn.call(container, 1);
    expect(down.before).toBe(100);
    expect(down.after).toBe(280); // 100 + 90% of 200
    expect(container.scrollTop).toBe(280);
    const up = fn.call(container, -1);
    expect(up.after).toBe(100); // 280 - 180
  });
});

describe('advanceSettle (settle state machine)', () => {
  it('declares settled only after equal readings span the stability window', () => {
    let s = advanceSettle(INITIAL_SETTLE_STATE, 10, 1000, 500);
    expect(s.settled).toBe(false); // first reading: steadiness not yet confirmable
    s = advanceSettle(s.state, 10, 1300, 500);
    expect(s.settled).toBe(false);
    // The window is BACKDATED to the earlier of the two equal readings: an
    // unchanged mutation counter is evidence no observed changes occurred,
    // not merely at the instant of the second sample.
    expect(s.state.stableSince).toBe(1000);
    s = advanceSettle(s.state, 10, 1499, 500);
    expect(s.settled).toBe(false); // 499 ms < 500 ms window
    s = advanceSettle(s.state, 10, 1500, 500);
    expect(s.settled).toBe(true); // 500 ms elapsed since the window opened
  });

  it('costs no extra tick on an already-static page (regression: window anchored to `now`)', () => {
    // Anchoring the window to the second sample charged every settle one
    // guaranteed extra POLL_MS: a static page proved a 500 ms window by t=500
    // but was only told so at t=750 — paid again on every reveal scroll step.
    const POLL = 250;
    let s = advanceSettle(INITIAL_SETTLE_STATE, 7, 0, 500);
    s = advanceSettle(s.state, 7, POLL, 500);
    expect(s.settled).toBe(false);
    s = advanceSettle(s.state, 7, POLL * 2, 500);
    expect(s.settled).toBe(true); // t=500, not t=750
  });

  it('still refuses to settle on a single reading, however long the gap', () => {
    // The saving must not weaken the rule that two genuinely equal samples are
    // required — a long first tick is not evidence of anything.
    const s = advanceSettle(INITIAL_SETTLE_STATE, 4, 10_000, 500);
    expect(s.settled).toBe(false);
    expect(s.state.stableSince).toBeNull();
  });

  it('restarts the window when the mutation counter changes', () => {
    let s = advanceSettle(INITIAL_SETTLE_STATE, 1, 0, 500);
    s = advanceSettle(s.state, 1, 400, 500); // window open
    s = advanceSettle(s.state, 2, 800, 500); // mutation → reset
    expect(s.settled).toBe(false);
    expect(s.state.stableSince).toBeNull();
    // a fresh steady stretch must again span the full window from scratch
    s = advanceSettle(s.state, 2, 1000, 500);
    expect(s.settled).toBe(false);
    s = advanceSettle(s.state, 2, 1600, 500);
    expect(s.settled).toBe(true);
  });

  it('never settles on a probe that yields no reading (regression: the {n:-1,len:-1} sentinel)', () => {
    // Repeated reading-less ticks must NOT compare equal and satisfy the window;
    // they restart it, so settle falls through to the cap as {settled:false}.
    let s = advanceSettle(INITIAL_SETTLE_STATE, null, 0, 0);
    s = advanceSettle(s.state, null, 250, 0);
    s = advanceSettle(s.state, null, 99_999, 0);
    expect(s.settled).toBe(false);
    expect(s.state).toEqual(INITIAL_SETTLE_STATE);
  });

  it('a reading-less tick resets a window that had already started', () => {
    let s = advanceSettle(INITIAL_SETTLE_STATE, 5, 0, 200);
    s = advanceSettle(s.state, 5, 100, 200); // window open
    expect(s.state.stableSince).not.toBeNull();
    s = advanceSettle(s.state, null, 200, 200); // no reading → reset
    expect(s.state).toEqual(INITIAL_SETTLE_STATE);
  });

  it('settles on the second equal reading when stableMs is 0', () => {
    let s = advanceSettle(INITIAL_SETTLE_STATE, 3, 0, 0);
    expect(s.settled).toBe(false); // first reading
    s = advanceSettle(s.state, 3, 0, 0);
    expect(s.settled).toBe(true);
  });
});

describe('parseMaxSteps (reveal)', () => {
  it('defaults to 20 when undefined', () => {
    expect(parseMaxSteps(undefined)).toBe(20);
  });

  it('clamps above the 40 cap and accepts in-range values', () => {
    expect(parseMaxSteps(999)).toBe(40);
    expect(parseMaxSteps(40)).toBe(40);
    expect(parseMaxSteps(5)).toBe(5);
  });

  it('rejects zero, negatives and non-integers', () => {
    expect(() => parseMaxSteps(0)).toThrowError(/maxSteps must be a positive integer/);
    expect(() => parseMaxSteps(-3)).toThrowError(/maxSteps/);
    expect(() => parseMaxSteps(2.5)).toThrowError(/maxSteps/);
    expect(() => parseMaxSteps('lots')).toThrowError(/maxSteps/);
  });
});

describe('SCROLL_BY_PROBE / SCROLL_INTO_VIEW_PROBE (scroll)', () => {
  it('SCROLL_BY_PROBE scrolls by a structured delta (negatives allowed) and reports position', () => {
    const fn = new Function(`return (${SCROLL_BY_PROBE});`)() as (
      this: { scrollTop: number; scrollLeft: number; scrollHeight: number; clientHeight: number },
      dx: number,
      dy: number,
      to: string | null,
    ) => { x: number; y: number; scrollHeight: number; clientHeight: number };
    const el = { scrollTop: 100, scrollLeft: 0, scrollHeight: 2000, clientHeight: 500 };
    expect(fn.call(el, 0, 300, null).y).toBe(400);
    expect(el.scrollTop).toBe(400);
    expect(fn.call(el, 0, -150, null).y).toBe(250); // negative scrolls up
    expect(fn.call(el, 40, 0, null).x).toBe(40); // horizontal axis too
  });

  it('SCROLL_BY_PROBE jumps to an edge when `to` is set', () => {
    const fn = new Function(`return (${SCROLL_BY_PROBE});`)() as (
      this: { scrollTop: number; scrollLeft: number; scrollHeight: number; clientHeight: number },
      dx: number,
      dy: number,
      to: string | null,
    ) => { x: number; y: number };
    const el = { scrollTop: 100, scrollLeft: 9, scrollHeight: 2000, clientHeight: 500 };
    expect(fn.call(el, 0, 0, 'bottom').y).toBe(2000);
    const top = fn.call(el, 0, 0, 'top');
    expect(top.y).toBe(0);
    expect(top.x).toBe(0);
  });

  it('SCROLL_INTO_VIEW_PROBE calls scrollIntoView and returns the page offset', () => {
    const fn = new Function(`return (${SCROLL_INTO_VIEW_PROBE});`)() as (this: unknown) => {
      x: number;
      y: number;
    };
    let called = false;
    const el = {
      scrollIntoView: () => {
        called = true;
      },
      ownerDocument: { defaultView: { scrollX: 5, scrollY: 800 } },
    };
    expect(fn.call(el)).toEqual({ x: 5, y: 800 });
    expect(called).toBe(true);
  });

  it('SCROLL_INTO_VIEW_PROBE tolerates a missing defaultView', () => {
    const fn = new Function(`return (${SCROLL_INTO_VIEW_PROBE});`)() as (this: unknown) => {
      x: number;
      y: number;
    };
    const el = { scrollIntoView: () => {}, ownerDocument: { defaultView: null } };
    expect(fn.call(el)).toEqual({ x: 0, y: 0 });
  });
});

describe('classifyWaitError (embedded waitFor)', () => {
  it('maps a stale @eN BridgeError to bad_ref', () => {
    expect(classifyWaitError(new BridgeError('bad_ref', 'unknown ref "@e5"'))).toBe('bad_ref');
  });

  it('does not treat other BridgeError codes as bad_ref', () => {
    expect(classifyWaitError(new BridgeError('not_found', 'nope'))).toBe('error');
  });

  it('names a mid-wait drift off the allowlist rather than folding it into error', () => {
    // The wait polls for up to 30 s and re-gates every tick, so the page can
    // leave the allowlist under it — most ordinarily because the click this
    // wait follows went off-site. "The tab is somewhere it should not be" is a
    // different instruction to the agent than "not true yet".
    expect(classifyWaitError(new BridgeError('domain_not_allowed', 'nope'))).toBe(
      'domain_not_allowed',
    );
  });

  it('maps a malformed-CSS query rejection to invalid_selector', () => {
    for (const msg of [
      "'div[' is not a valid selector.",
      'Invalid selector',
      'DOM Error while querying',
      "Failed to execute 'querySelector'",
    ]) {
      expect(classifyWaitError(new Error(msg))).toBe('invalid_selector');
    }
  });

  it('falls back to error for an unrecognised failure', () => {
    expect(classifyWaitError(new Error('socket hung up'))).toBe('error');
  });

  it('tolerates a non-Error throwable', () => {
    expect(classifyWaitError('boom')).toBe('error');
    expect(classifyWaitError(null)).toBe('error');
  });
});

describe('scrollStalled (reveal)', () => {
  it('is stalled when scrollTop did not move', () => {
    expect(scrollStalled({ before: 200, after: 200 }, null)).toBe(true);
  });

  it('is stalled when it bounced back to a position already seen', () => {
    expect(scrollStalled({ before: 200, after: 380 }, 380)).toBe(true);
  });

  it('is not stalled on genuine forward progress', () => {
    expect(scrollStalled({ before: 200, after: 380 }, 200)).toBe(false);
  });

  it('is not stalled on the first step (no prevAfter yet)', () => {
    expect(scrollStalled({ before: 0, after: 180 }, null)).toBe(false);
  });
});

// -------------------------------------------------------------------------
// The waits re-gate the page they keep reading (invariant #3)
// -------------------------------------------------------------------------

const TAB = 42;

/** A chrome just big enough for pollFor/settleFor: the allowlist store, a
 * `tabs.get` whose answer a test can move over successive calls, and a CDP
 * channel whose selector answer never changes — so the wait can only end on the
 * timeout or on the gate, never on the condition coming true. `present` picks
 * which of the two conditions stays unsatisfiable: `false` starves a
 * wait-for-it-to-appear, `true` starves a wait-for-it-to-vanish. */
function installChrome(urls: string[], present = false): { tabGets: () => number } {
  const store = new Map<string, unknown>();
  let tabGets = 0;
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
        const url = urls[Math.min(tabGets++, urls.length - 1)];
        return { id: TAB, url, title: 'shop' };
      },
      onRemoved: { addListener() {} },
    },
    debugger: {
      async attach() {},
      async sendCommand(_t: unknown, method: string) {
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelector') return { nodeId: present ? 5 : 0 };
        if (method === 'DOM.getBoxModel') return { model: { width: 10, height: 10 } };
        if (method === 'Runtime.evaluate') return { result: { objectId: 'observer' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: 0 } };
        return {};
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
  return { tabGets: () => tabGets };
}

describe('pollFor / settleFor re-gate every tick', () => {
  const SHOP = 'https://shop.example/cart';

  beforeEach(async () => {
    installChrome([SHOP]);
    resetAttachedTabs();
    await setAllowlist([{ pattern: 'shop.example', allowEvaluate: false, addedAt: 0 }]);
  });

  it('stops a wait the moment the page leaves the allowlist', async () => {
    // The ordinary way this happens: the click this wait follows went off-site,
    // or the page bounced to an SSO host. Waiting on for 30 s meant probing a
    // page nobody approved on the strength of a check made before the click.
    installChrome([SHOP, SHOP, 'https://tracker.example/pixel']);
    await setAllowlist([{ pattern: 'shop.example', allowEvaluate: false, addedAt: 0 }]);

    await expect(
      pollFor(TAB, { selector: '#done', text: null, timeoutMs: 5000, absent: false }),
    ).rejects.toMatchObject({ code: 'domain_not_allowed' });
  });

  it('still times out normally while the page stays put', async () => {
    const out = await pollFor(TAB, {
      selector: '#done',
      text: null,
      timeoutMs: 400,
      absent: false,
    });
    expect(out).toMatchObject({ found: false, reason: 'timeout' });
  });

  it('applies to the absent-condition too — a drift is not proof of absence', async () => {
    // Waiting for something to VANISH must not be satisfied by the page having
    // navigated somewhere we may not read.
    // The spinner stays visible, so only the drift can end this wait.
    installChrome([SHOP, SHOP, 'https://tracker.example/pixel'], true);
    await setAllowlist([{ pattern: 'shop.example', allowEvaluate: false, addedAt: 0 }]);

    await expect(
      pollFor(TAB, { selector: '#spinner', text: null, timeoutMs: 5000, absent: true }),
    ).rejects.toMatchObject({ code: 'domain_not_allowed' });
  });

  it('settle stops on a drift as well', async () => {
    installChrome([SHOP, SHOP, 'https://tracker.example/pixel']);
    await setAllowlist([{ pattern: 'shop.example', allowEvaluate: false, addedAt: 0 }]);

    await expect(settleFor(TAB, { stableMs: 5000, timeoutMs: 5000 })).rejects.toMatchObject({
      code: 'domain_not_allowed',
    });
  });

  it('a vanished tab is named, not left to a CDP error', async () => {
    (globalThis as unknown as { chrome: { tabs: { get: () => Promise<never> } } }).chrome.tabs.get =
      async () => {
        throw new Error('No tab with id: 42');
      };
    await expect(
      pollFor(TAB, { selector: '#done', text: null, timeoutMs: 5000, absent: false }),
    ).rejects.toMatchObject({ code: 'tab_gone' });
  });
});

describe('settle observer lifecycle', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    installChrome(['https://shop.example/cart']);
    await setAllowlist([{ pattern: 'shop.example', allowEvaluate: false, addedAt: 0 }]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function channel(values: unknown[]) {
    let index = 0;
    return vi
      .spyOn(chrome.debugger, 'sendCommand')
      .mockImplementation(async (_target, method, params) => {
        if (method === 'Runtime.evaluate') return { result: { objectId: 'observer' } };
        if (
          method === 'Runtime.callFunctionOn' &&
          (params as { functionDeclaration: string }).functionDeclaration.includes('sample')
        ) {
          const value = values[Math.min(index++, values.length - 1)];
          if (value instanceof Error) throw value;
          return { result: { value } };
        }
        return {};
      });
  }

  function expectCleanup(send: ReturnType<typeof channel>) {
    expect(send).toHaveBeenCalledWith({ tabId: TAB }, 'Runtime.callFunctionOn', {
      objectId: 'observer',
      functionDeclaration: 'function() { this.stop(); }',
      returnByValue: true,
    });
    expect(send).toHaveBeenLastCalledWith({ tabId: TAB }, 'Runtime.releaseObjectGroup', {
      objectGroup: 'sallyport-settle',
    });
  }

  it('waits for a full quiet window after the last observed mutation and cleans up', async () => {
    const send = channel([0, 1, 2, 2, 2]);
    const pending = settleFor(TAB, { stableMs: 500, timeoutMs: 2000 });
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ settled: true, elapsedMs: 1000 });
    expectCleanup(send);
  });

  it.each([[0, 1, 2, 3], [undefined], ['0'], [-1], [NaN], [{}]])(
    'never settles on changing or invalid samples: %j',
    async (...values) => {
      const send = channel(values);
      const pending = settleFor(TAB, { stableMs: 500, timeoutMs: 750 });
      await vi.runAllTimersAsync();
      expect(await pending).toEqual({ settled: false, elapsedMs: 750 });
      expectCleanup(send);
    },
  );

  it('creates the observer by reference in the settle object group', async () => {
    const send = channel([0]);
    const pending = settleFor(TAB, { stableMs: 0, timeoutMs: 500 });
    await vi.runAllTimersAsync();
    await pending;
    // No returnByValue: Chrome would answer a by-value copy with no objectId,
    // and settle would silently never settle again.
    expect(send).toHaveBeenCalledWith({ tabId: TAB }, 'Runtime.evaluate', {
      expression: CREATE_QUIESCENCE_PROBE,
      objectGroup: 'sallyport-settle',
    });
  });

  it.each([
    'Cannot find context with specified id',
    'Could not find object with given id',
    'Execution context was destroyed.',
  ])('survives a navigation mid-wait (%s) by observing the new document', async (message) => {
    // click → settle on a submit button: the observer's document is replaced
    // under it. That is a new page to wait on, not a failed settle.
    const send = channel([0, new Error(message), 5, 5, 5]);
    const pending = settleFor(TAB, { stableMs: 500, timeoutMs: 3000 });
    await vi.runAllTimersAsync();
    const out = await pending;
    expect(out.settled).toBe(true);
    // The lost tick restarted the window: settled on the NEW document's readings.
    expect(out.elapsedMs).toBe(1000);
    const creates = send.mock.calls.filter(([, method]) => method === 'Runtime.evaluate');
    expect(creates).toHaveLength(2);
    expectCleanup(send);
  });

  it('keeps retrying creation while a navigation is mid-commit', async () => {
    let creates = 0;
    const send = channel([3]);
    const sample = send.getMockImplementation()!;
    send.mockImplementation(async (...args) => {
      if (args[1] === 'Runtime.evaluate' && creates++ === 0) {
        throw new Error('Cannot find default execution context');
      }
      return sample(...args);
    });
    const pending = settleFor(TAB, { stableMs: 250, timeoutMs: 3000 });
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ settled: true, elapsedMs: 500 });
    expect(creates).toBe(2);
  });

  it('never samples the exception a throwing page returns from creation', async () => {
    // A thrown value comes back WITH an objectId (the exception's) — sampling it
    // would be meaningless, so no handle is kept and every tick stays unread.
    const send = channel([0]);
    send.mockImplementation(async (_target, method) => {
      if (method === 'Runtime.evaluate') {
        return { result: { objectId: 'the-error', subtype: 'error' }, exceptionDetails: {} };
      }
      return {};
    });
    const pending = settleFor(TAB, { stableMs: 0, timeoutMs: 500 });
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ settled: false, elapsedMs: 500 });
    expect(send).not.toHaveBeenCalledWith(
      { tabId: TAB },
      'Runtime.callFunctionOn',
      expect.anything(),
    );
  });

  it('treats a sample that threw in the page as no reading', async () => {
    const send = channel([0]);
    send.mockImplementation(async (_target, method) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'observer' } };
      if (method === 'Runtime.callFunctionOn') {
        // V8 hands a thrown primitive back as a by-value result.
        return { result: { type: 'number', value: 7 }, exceptionDetails: {} };
      }
      return {};
    });
    const pending = settleFor(TAB, { stableMs: 0, timeoutMs: 500 });
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ settled: false, elapsedMs: 500 });
  });

  it('replaces an observer that has expired', async () => {
    const send = channel([null, 4, 4]);
    const pending = settleFor(TAB, { stableMs: 250, timeoutMs: 3000 });
    await vi.runAllTimersAsync();
    expect((await pending).settled).toBe(true);
    const creates = send.mock.calls.filter(([, method]) => method === 'Runtime.evaluate');
    expect(creates).toHaveLength(2);
  });

  it('re-gates a final tick that lost its observer, so a closed tab is tab_gone', async () => {
    // "Inspected target navigated or closed" is also what a CLOSED tab says.
    // Ticks run at 0/250/500/750 ms; 750 is the last, with no next iteration
    // whose gate would notice — the tab closes between its gate and its sample.
    let closed = false;
    const send = channel([0, 0, 0, 'close']);
    const sample = send.getMockImplementation()!;
    send.mockImplementation(async (...args) => {
      const out = await sample(...args);
      if ((out as { result?: { value?: unknown } }).result?.value === 'close') {
        closed = true;
        throw new Error('Inspected target navigated or closed');
      }
      return out;
    });
    const tabsGet = chrome.tabs.get;
    vi.spyOn(chrome.tabs, 'get').mockImplementation(async (id: number) => {
      if (closed) throw new Error(`No tab with id: ${id}.`);
      return tabsGet(id);
    });
    const pending = settleFor(TAB, { stableMs: 5000, timeoutMs: 750 });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'tab_gone' });
    await vi.runAllTimersAsync();
    await rejected;
    expect(closed).toBe(true);
    expect(send).toHaveBeenLastCalledWith({ tabId: TAB }, 'Runtime.releaseObjectGroup', {
      objectGroup: 'sallyport-settle',
    });
  });

  it('cleans up after a protocol error without hiding the error', async () => {
    // A detached debugger is not a navigation: it must still fail the wait.
    const send = channel([new Error('Debugger is not attached to the tab with id: 7.')]);
    await expect(settleFor(TAB, { stableMs: 500, timeoutMs: 1000 })).rejects.toThrow(
      'Debugger is not attached',
    );
    expectCleanup(send);
  });

  it('reports unsettled if observer creation yields no handle', async () => {
    const send = channel([0]);
    send.mockImplementation(async () => ({ result: {} }));
    const pending = settleFor(TAB, { stableMs: 0, timeoutMs: 500 });
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ settled: false, elapsedMs: 500 });
    expect(send).not.toHaveBeenCalledWith(
      { tabId: TAB },
      'Runtime.callFunctionOn',
      expect.anything(),
    );
    expect(send).toHaveBeenLastCalledWith({ tabId: TAB }, 'Runtime.releaseObjectGroup', {
      objectGroup: 'sallyport-settle',
    });
  });

  it('preserves the outcome when the object group was already destroyed', async () => {
    const send = channel([0]);
    const implementation = send.getMockImplementation()!;
    send.mockImplementation(async (...args) => {
      if (args[1] === 'Runtime.releaseObjectGroup') throw new Error('tab closed');
      return implementation(...args);
    });
    const pending = settleFor(TAB, { stableMs: 500, timeoutMs: 1000 });
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ settled: true, elapsedMs: 500 });
  });

  it('cleans up when permission is revoked during the wait', async () => {
    const send = channel([0]);
    const pending = settleFor(TAB, { stableMs: 500, timeoutMs: 1000 });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'domain_not_allowed' });
    await vi.advanceTimersByTimeAsync(0);
    await setAllowlist([]);
    await vi.runAllTimersAsync();
    await rejected;
    expectCleanup(send);
  });

  it('releases the group even if stopping the observer fails', async () => {
    const send = channel([0]);
    send.mockImplementation(async (_target, method) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'observer' } };
      if (method === 'Runtime.callFunctionOn') throw new Error('detached');
      return {};
    });
    await expect(settleFor(TAB, { stableMs: 500, timeoutMs: 1000 })).rejects.toThrow('detached');
    expectCleanup(send);
  });
});
