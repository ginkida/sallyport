import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  advanceSettle,
  classifyWaitError,
  INITIAL_SETTLE_STATE,
  parseMaxSteps,
  parseTimeoutMs,
  parseWaitFor,
  SCROLL_BY_PROBE,
  SCROLL_GEOMETRY_PROBE,
  SCROLL_INTO_VIEW_PROBE,
  SCROLL_STEP_PROBE,
  atScrollEdge,
  anyMatchVisible,
  budgetWaitSpec,
  minSettleTimeoutMs,
  VISIBLE_TEXT_FN,
  runEmbeddedWait,
  SELECTOR_VISIBILITY_FN,
  scrollStalled,
  pollFor,
  settleFor,
} from '../src/tools/poll.js';
import { BridgeError } from '../src/tools/errors.js';
import { setAllowlist } from '../src/storage.js';
import { resetAttachedTabs } from '../src/tools/cdp.js';
import { CREATE_QUIESCENCE_PROBE, OBSERVE_ELEMENT_FN } from '../src/tools/quiescence.js';
import { CALL_BUDGET_MS, OBSERVE_RESERVE_MS } from '../src/tools/budget.js';

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

describe('atScrollEdge (reveal)', () => {
  it('knows when a downward step reached the bottom, with a pixel of slack', () => {
    expect(atScrollEdge({ after: 500, clientHeight: 500, scrollHeight: 1000 }, 1)).toBe(true);
    expect(atScrollEdge({ after: 499.5, clientHeight: 500, scrollHeight: 1000 }, 1)).toBe(true);
    expect(atScrollEdge({ after: 400, clientHeight: 500, scrollHeight: 1000 }, 1)).toBe(false);
  });

  it('knows when an upward step reached the top', () => {
    expect(atScrollEdge({ after: 0, clientHeight: 500, scrollHeight: 1000 }, -1)).toBe(true);
    expect(atScrollEdge({ after: 10, clientHeight: 500, scrollHeight: 1000 }, -1)).toBe(false);
  });

  it('treats unreadable geometry as an edge — the stricter wait', () => {
    expect(atScrollEdge({ after: 10 }, 1)).toBe(true);
    expect(atScrollEdge({ after: 10, clientHeight: '500', scrollHeight: 1000 }, 1)).toBe(true);
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
    ) => { before: number; after: number; scrollHeight: number; clientHeight: number };
    const container = { scrollTop: 100, clientHeight: 200, scrollHeight: 1000 };
    const down = fn.call(container, 1);
    expect(down.before).toBe(100);
    expect(down.after).toBe(280); // 100 + 90% of 200
    expect(down).toMatchObject({ scrollHeight: 1000, clientHeight: 200 });
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
      async sendCommand(_t: unknown, method: string, params?: { functionDeclaration?: string }) {
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.getBoxModel') return { model: { width: 10, height: 10 } };
        if (method === 'Runtime.evaluate') return { result: { objectId: 'observer' } };
        if (
          method === 'Runtime.callFunctionOn' &&
          params?.functionDeclaration === SELECTOR_VISIBILITY_FN
        ) {
          return { result: { value: { visible: present, total: present ? 1 : 0 } } };
        }
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

  it('scopes the observer to a root element when one is given', async () => {
    const send = channel([0]);
    send.mockImplementation(async (_target, method, params) => {
      const p = params as { functionDeclaration?: string };
      if (
        method === 'Runtime.callFunctionOn' &&
        p.functionDeclaration?.includes('MutationObserver')
      )
        return { result: { objectId: 'observer' } };
      if (method === 'Runtime.callFunctionOn' && p.functionDeclaration?.includes('sample'))
        return { result: { value: 0 } };
      return {};
    });
    const pending = settleFor(TAB, { stableMs: 250, timeoutMs: 1000, root: 'list' });
    await vi.runAllTimersAsync();
    expect((await pending).settled).toBe(true);
    expect(send).toHaveBeenCalledWith({ tabId: TAB }, 'Runtime.callFunctionOn', {
      objectId: 'list',
      functionDeclaration: OBSERVE_ELEMENT_FN,
      objectGroup: 'sallyport-settle',
    });
    expect(send).not.toHaveBeenCalledWith({ tabId: TAB }, 'Runtime.evaluate', expect.anything());
    expectCleanup(send);
  });

  it('falls back to the whole document once a scoped root is lost with its page', async () => {
    // The element died with its document; nothing here can re-resolve it, and
    // a wait that went blind would be worse than a stricter one.
    let samples = 0;
    const send = channel([0]);
    send.mockImplementation(async (_target, method, params) => {
      const p = params as { functionDeclaration?: string };
      if (method === 'Runtime.evaluate') return { result: { objectId: 'observer' } };
      if (
        method === 'Runtime.callFunctionOn' &&
        p.functionDeclaration?.includes('MutationObserver')
      )
        return { result: { objectId: 'scoped' } };
      if (method === 'Runtime.callFunctionOn' && p.functionDeclaration?.includes('sample')) {
        if (samples++ === 1) throw new Error('Cannot find context with specified id');
        return { result: { value: 0 } };
      }
      return {};
    });
    const pending = settleFor(TAB, { stableMs: 250, timeoutMs: 3000, root: 'list' });
    await vi.runAllTimersAsync();
    expect((await pending).settled).toBe(true);
    const creates = send.mock.calls.filter(
      ([, method, params]) =>
        method === 'Runtime.evaluate' ||
        String((params as { functionDeclaration?: string }).functionDeclaration).includes(
          'MutationObserver',
        ),
    );
    expect(creates.map(([, method]) => method)).toEqual([
      'Runtime.callFunctionOn',
      'Runtime.evaluate',
    ]);
  });

  it.each([
    ['throws in the page', 'exception'],
    ['has lost its context', 'lost'],
  ])('falls back to the whole document when a scoped creation %s', async (_label, how) => {
    // The root handle is the one thing settleFor cannot re-resolve: retrying it
    // every tick would read nothing and burn the whole budget.
    const send = channel([0]);
    send.mockImplementation(async (_target, method, params) => {
      const p = params as { functionDeclaration?: string };
      if (method === 'Runtime.evaluate') return { result: { objectId: 'observer' } };
      if (
        method === 'Runtime.callFunctionOn' &&
        p.functionDeclaration?.includes('MutationObserver')
      ) {
        if (how === 'lost') throw new Error('Could not find object with given id');
        return { result: { objectId: 'the-error' }, exceptionDetails: {} };
      }
      if (method === 'Runtime.callFunctionOn' && p.functionDeclaration?.includes('sample'))
        return { result: { value: 0 } };
      return {};
    });
    const pending = settleFor(TAB, { stableMs: 250, timeoutMs: 3000, root: 'list' });
    await vi.runAllTimersAsync();
    expect((await pending).settled).toBe(true);
    const creates = send.mock.calls.filter(
      ([, method, params]) =>
        method === 'Runtime.evaluate' ||
        String((params as { functionDeclaration?: string }).functionDeclaration).includes(
          'MutationObserver',
        ),
    );
    expect(creates.map(([, method]) => method)).toEqual([
      'Runtime.callFunctionOn',
      'Runtime.evaluate',
    ]);
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

describe('anyMatchVisible / SELECTOR_VISIBILITY_FN (wait_for over EVERY match)', () => {
  const el = (w: number, h: number) => ({
    getBoundingClientRect: () => ({ width: w, height: h }) as DOMRect,
  });
  const doc = (els: ReturnType<typeof el>[]) => ({ querySelectorAll: () => els });

  it('is visible when ANY match is laid out, not just the first', () => {
    expect(anyMatchVisible(doc([el(0, 0), el(10, 10)]), '.x')).toEqual({ visible: true, total: 2 });
  });

  it('is hidden only when no match has area — and says how many it checked', () => {
    expect(anyMatchVisible(doc([el(0, 0), el(10, 0)]), '.x')).toEqual({ visible: false, total: 2 });
    expect(anyMatchVisible(doc([]), '.x')).toEqual({ visible: false, total: 0 });
  });

  it('scans past any fixed cap', () => {
    const many = Array.from({ length: 5000 }, () => el(0, 0));
    many.push(el(5, 5));
    expect(anyMatchVisible(doc(many), '.row')).toEqual({ visible: true, total: 5001 });
  });

  it('reports a malformed selector instead of throwing in the page', () => {
    const bad = {
      querySelectorAll: () => {
        // What Chrome throws: a DOMException NAMED SyntaxError.
        throw Object.assign(new Error("'div[' is not a valid selector"), { name: 'SyntaxError' });
      },
    };
    expect(anyMatchVisible(bad, 'div[')).toEqual({ invalid: true });
  });

  it('does not blame the selector for a page that broke querySelectorAll', () => {
    const broken = {
      querySelectorAll: () => {
        throw new TypeError('polyfill exploded');
      },
    };
    expect(() => anyMatchVisible(broken, '.ok')).toThrow('polyfill exploded');
  });

  it('is self-contained and takes the selector as an ARGUMENT, never interpolated', () => {
    const fn = new Function(`return (${SELECTOR_VISIBILITY_FN});`)() as (
      this: unknown,
      selector: string,
    ) => unknown;
    const seen: string[] = [];
    const target = {
      querySelectorAll: (s: string) => {
        seen.push(s);
        return [el(3, 3)];
      },
    };
    expect(fn.call(target, '"); alert(1); ("')).toEqual({ visible: true, total: 1 });
    expect(seen).toEqual(['"); alert(1); ("']);
    expect(SELECTOR_VISIBILITY_FN).not.toContain('alert');
  });
});

describe('pollFor — a CSS selector with several matches', () => {
  const SHOP = 'https://shop.example/cart';

  /** Answers the page probe with each of `readings` in turn (last one repeats). */
  function probe(readings: unknown[]) {
    let i = 0;
    return vi
      .spyOn(chrome.debugger, 'sendCommand')
      .mockImplementation(async (_target, method, params) => {
        const p = params as { functionDeclaration?: string };
        if (method === 'Runtime.evaluate') return { result: { objectId: 'doc' } };
        if (
          method === 'Runtime.callFunctionOn' &&
          p.functionDeclaration === SELECTOR_VISIBILITY_FN
        ) {
          const r = readings[Math.min(i++, readings.length - 1)];
          if (r instanceof Error) throw r;
          if (r === 'throws') return { result: { type: 'object' }, exceptionDetails: {} };
          return { result: { value: r } };
        }
        return {};
      });
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    installChrome([SHOP]);
    await setAllowlist([{ pattern: 'shop.example', allowEvaluate: false, addedAt: 0 }]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const wait = (absent: boolean) =>
    pollFor(TAB, { selector: '.spinner', text: null, timeoutMs: 500, absent });

  it('does not call a selector gone while any match is still visible', async () => {
    // One spinner per widget hidden by a class as each finishes: the first
    // going display:none used to answer "gone" with the rest still spinning.
    probe([{ visible: true, total: 3 }]);
    const pending = wait(true);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ found: false, reason: 'timeout' });
  });

  it('reports gone once no match is visible, and releases its handles', async () => {
    const send = probe([
      { visible: true, total: 3 },
      { visible: false, total: 3 },
    ]);
    const pending = wait(true);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ found: true });
    expect(send).toHaveBeenCalledWith({ tabId: TAB }, 'Runtime.callFunctionOn', {
      objectId: 'doc',
      functionDeclaration: SELECTOR_VISIBILITY_FN,
      arguments: [{ value: '.spinner' }],
      returnByValue: true,
    });
    expect(send).toHaveBeenLastCalledWith({ tabId: TAB }, 'Runtime.releaseObjectGroup', {
      objectGroup: 'sallyport-wait',
    });
  });

  it('finds a visible match behind a hidden first copy', async () => {
    probe([{ visible: true, total: 2 }]);
    const pending = wait(false);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ found: true });
  });

  it.each([['throws'], [null], [{ total: 2 }], ['nonsense']])(
    'never reads an unusable probe answer (%j) as proof of absence',
    async (reading) => {
      probe([reading]);
      const pending = wait(true);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ found: false, reason: 'timeout' });
    },
  );

  it('rides out a navigation that takes the document away mid-tick', async () => {
    probe([new Error('Cannot find context with specified id'), { visible: false, total: 0 }]);
    const pending = wait(true);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ found: true });
  });

  it('refuses a malformed selector at once, as bad_args', async () => {
    probe([{ invalid: true }]);
    await expect(wait(false)).rejects.toMatchObject({ code: 'bad_args' });
  });

  it('names a malformed selector invalid_selector in an embedded wait', async () => {
    probe([{ invalid: true }]);
    const out = await runEmbeddedWait(TAB, {
      selector: 'div[',
      text: null,
      timeoutMs: 500,
      absent: false,
    });
    expect(out).toMatchObject({ found: false, reason: 'invalid_selector' });
  });
});

describe('budgetWaitSpec (an embedded wait spends what the call has LEFT)', () => {
  const spec = { selector: '#x', text: null, timeoutMs: 30_000, absent: false };

  it('leaves the wait alone without a call start, or with time to spare', () => {
    expect(budgetWaitSpec(spec, undefined, 1e9)).toEqual({ spec, limited: false });
    expect(budgetWaitSpec(spec, 1000, 1000 + 5_000)).toEqual({ spec, limited: false });
  });

  it('clamps to the remainder after a slow action', () => {
    const out = budgetWaitSpec(spec, 0, 30_000); // a 30 s page load
    expect(out.limited).toBe(true);
    expect(out.spec.timeoutMs).toBe(CALL_BUDGET_MS - 30_000);
    expect(spec.timeoutMs).toBe(30_000); // the caller's spec is not mutated
  });

  it('never goes negative once the budget is spent', () => {
    expect(budgetWaitSpec(spec, 0, CALL_BUDGET_MS + 5_000).spec.timeoutMs).toBe(0);
  });

  it('ends earlier when an observation follows, so the snapshot has room', () => {
    const out = budgetWaitSpec(spec, 0, 30_000, true);
    expect(out.spec.timeoutMs).toBe(CALL_BUDGET_MS - OBSERVE_RESERVE_MS - 30_000);
  });

  it('keeps the whole call under the daemon 60 s timeout, with room left', () => {
    expect(CALL_BUDGET_MS).toBeLessThanOrEqual(50_000);
  });
});

describe('scroll probes under scroll-behavior: smooth', () => {
  /** An element whose scrollTop SETTER only starts an animation (the value
   * does not move until later), as Chrome does under `scroll-behavior: smooth`;
   * only scrollTo with behavior 'instant' lands at once. */
  function smoothElement(scrollHeight = 5000, clientHeight = 500) {
    let top = 0;
    let left = 0;
    return {
      get scrollTop() {
        return top;
      },
      set scrollTop(_v: number) {
        /* animating — not there yet */
      },
      get scrollLeft() {
        return left;
      },
      set scrollLeft(_v: number) {
        /* animating */
      },
      scrollHeight,
      clientHeight,
      scrollTo(o: { top?: number; left?: number; behavior?: string }) {
        if (o.behavior !== 'instant') return;
        if (o.top !== undefined) top = Math.min(o.top, scrollHeight - clientHeight);
        if (o.left !== undefined) left = o.left;
      },
    };
  }

  it("reveal's step lands at once, so it is not misread as a stall", () => {
    const fn = new Function(`return (${SCROLL_STEP_PROBE});`)() as (
      this: unknown,
      dir: number,
    ) => { before: number; after: number };
    const out = fn.call(smoothElement(), 1);
    expect(out.before).toBe(0);
    expect(out.after).toBe(450);
    expect(scrollStalled(out, null)).toBe(false);
  });

  it('scroll reports where it actually landed, by delta and to an edge', () => {
    const fn = new Function(`return (${SCROLL_BY_PROBE});`)() as (
      this: unknown,
      dx: number,
      dy: number,
      to: string | null,
    ) => { y: number; scrollHeight: number; clientHeight: number };
    const el = smoothElement();
    expect(fn.call(el, 0, 800, null).y).toBe(800);
    const bottom = fn.call(el, 0, 0, 'bottom');
    expect(bottom.y + bottom.clientHeight).toBe(bottom.scrollHeight);
    expect(fn.call(el, 0, 0, 'top').y).toBe(0);
  });

  it.each([
    [
      'throws',
      () => {
        throw new TypeError('bad options');
      },
    ],
    [
      'is a legacy (x, y) polyfill',
      function (this: { scrollTop: number }, x: unknown, y: unknown) {
        this.scrollTop = y as number; // an options object: scrollTop = undefined → 0
        void x;
      },
    ],
  ])('falls back to the native setter when a page scrollTo %s', (_label, scrollTo) => {
    const el = { scrollTop: 100, scrollLeft: 0, clientHeight: 500, scrollHeight: 5000, scrollTo };
    const step = new Function(`return (${SCROLL_STEP_PROBE});`)() as (
      this: unknown,
      dir: number,
    ) => { after: number };
    expect(step.call(el, 1).after).toBe(550);
    const by = new Function(`return (${SCROLL_BY_PROBE});`)() as (
      this: unknown,
      dx: number,
      dy: number,
      to: string | null,
    ) => { y: number };
    expect(by.call(el, 0, 200, null).y).toBe(750);
  });

  it('the geometry re-read is self-contained and moves nothing', () => {
    const fn = new Function(`return (${SCROLL_GEOMETRY_PROBE});`)() as (this: unknown) => unknown;
    const el = { scrollLeft: 3, scrollTop: 40, scrollHeight: 900, clientHeight: 300 };
    expect(fn.call(el)).toEqual({ x: 3, y: 40, scrollHeight: 900, clientHeight: 300 });
    expect(el.scrollTop).toBe(40);
  });
});

describe('scroll — atBottom after an embedded wait', () => {
  const SHOP = 'https://shop.example/cart';

  beforeEach(async () => {
    installChrome([SHOP]);
    await setAllowlist([{ pattern: 'shop.example', allowEvaluate: false, addedAt: 0 }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('re-reads the geometry, so a feed that grew during the wait is not "at the bottom"', async () => {
    const { scroll } = await import('../src/tools/scroll.js');
    vi.spyOn(chrome.debugger, 'sendCommand').mockImplementation(async (_t, method, params) => {
      const p = params as { functionDeclaration?: string };
      if (method === 'Runtime.evaluate') return { result: { objectId: 'root' } };
      if (p?.functionDeclaration === SCROLL_BY_PROBE) {
        // Landed at the end of the feed as it was.
        return { result: { value: { x: 0, y: 1000, scrollHeight: 1500, clientHeight: 500 } } };
      }
      if (p?.functionDeclaration === SELECTOR_VISIBILITY_FN) {
        return { result: { value: { visible: true, total: 61 } } }; // the next batch arrived
      }
      if (p?.functionDeclaration === SCROLL_GEOMETRY_PROBE) {
        return { result: { value: { x: 0, y: 1000, scrollHeight: 3000, clientHeight: 500 } } };
      }
      return {};
    });
    const res = await scroll({
      to: 'bottom',
      waitFor: { selector: '.row', timeoutMs: 1000 },
      tabId: TAB,
    });
    const data = res.data as { atBottom: boolean; scrollHeight: number; wait: { found: boolean } };
    expect(data.wait.found).toBe(true);
    expect(data.scrollHeight).toBe(3000);
    expect(data.atBottom).toBe(false);
  });

  it('does not re-read a page that left the allowlist during the wait (#3)', async () => {
    // A same-document route change onto a path the allowlist does not cover,
    // landing just as the wait finishes: the re-read must not follow it.
    const { scroll } = await import('../src/tools/scroll.js');
    let moved = false;
    const tabsGet = chrome.tabs.get;
    vi.spyOn(chrome.tabs, 'get').mockImplementation(async (id: number) =>
      moved ? ({ id, url: 'https://elsewhere.example/admin' } as chrome.tabs.Tab) : tabsGet(id),
    );
    const send = vi
      .spyOn(chrome.debugger, 'sendCommand')
      .mockImplementation(async (_t, method, params) => {
        const p = params as { functionDeclaration?: string };
        if (method === 'Runtime.evaluate') return { result: { objectId: 'root' } };
        if (p?.functionDeclaration === SCROLL_BY_PROBE) {
          return { result: { value: { x: 0, y: 1000, scrollHeight: 1500, clientHeight: 500 } } };
        }
        if (p?.functionDeclaration === SELECTOR_VISIBILITY_FN) {
          moved = true;
          return { result: { value: { visible: true, total: 1 } } };
        }
        return { result: { value: { x: 0, y: 0, scrollHeight: 9999, clientHeight: 1 } } };
      });
    const res = await scroll({
      to: 'bottom',
      waitFor: { selector: '.row', timeoutMs: 1000 },
      tabId: TAB,
    });
    expect((res.data as { wait: { found: boolean } }).wait.found).toBe(true);
    const geometryReads = send.mock.calls.filter(
      ([, , params]) =>
        (params as { functionDeclaration?: string })?.functionDeclaration === SCROLL_GEOMETRY_PROBE,
    );
    expect(geometryReads).toHaveLength(0);
    expect((res.data as { scrollHeight: number }).scrollHeight).toBe(1500);
  });

  it('refuses to report geometry the page never gave back', async () => {
    const { scroll } = await import('../src/tools/scroll.js');
    vi.spyOn(chrome.debugger, 'sendCommand').mockImplementation(async (_t, method) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'root' } };
      return { result: { type: 'object' }, exceptionDetails: {} }; // the probe threw
    });
    await expect(scroll({ to: 'bottom', tabId: TAB })).rejects.toMatchObject({ code: 'error' });
  });

  it('keeps the first reading if the container went away during the wait', async () => {
    const { scroll } = await import('../src/tools/scroll.js');
    vi.spyOn(chrome.debugger, 'sendCommand').mockImplementation(async (_t, method, params) => {
      const p = params as { functionDeclaration?: string };
      if (method === 'Runtime.evaluate') return { result: { objectId: 'root' } };
      if (p?.functionDeclaration === SCROLL_BY_PROBE) {
        return { result: { value: { x: 0, y: 1000, scrollHeight: 1500, clientHeight: 500 } } };
      }
      if (p?.functionDeclaration === SELECTOR_VISIBILITY_FN) {
        return { result: { value: { visible: true, total: 1 } } };
      }
      if (p?.functionDeclaration === SCROLL_GEOMETRY_PROBE) {
        throw new Error('Could not find object with given id');
      }
      return {};
    });
    const res = await scroll({
      to: 'bottom',
      waitFor: { selector: '.row', timeoutMs: 1000 },
      tabId: TAB,
    });
    expect((res.data as { atBottom: boolean }).atBottom).toBe(true);
  });
});

describe('VISIBLE_TEXT_FN (text waits read RENDERED text only)', () => {
  it('does not fall back to textContent, so script state is not "on the page"', () => {
    // A SPA before hydration: nothing rendered, the words only in inline JSON.
    const fn = new Function(`return (${VISIBLE_TEXT_FN});`)() as (this: unknown) => string;
    expect(fn.call({ innerText: '', textContent: '{"title":"Dashboard"}' })).toBe('');
    expect(fn.call({ innerText: 'Dashboard' })).toBe('Dashboard');
  });
});

describe('VISIBLE_TEXT_FN — a body that is not rendered', () => {
  const fn = () => new Function(`return (${VISIBLE_TEXT_FN});`)() as (this: unknown) => string;
  const view = (display: string) => ({ defaultView: { getComputedStyle: () => ({ display }) } });

  it('reads nothing from a display:none body, whose innerText IS its textContent', () => {
    const body = {
      getClientRects: () => [],
      ownerDocument: view('none'),
      innerText: '{"title":"Dashboard"}', // what Chrome returns for an unrendered element
    };
    expect(fn().call(body)).toBe('');
  });

  it('still reads a display:contents body, whose children render', () => {
    const body = { getClientRects: () => [], ownerDocument: view('contents'), innerText: 'Hi' };
    expect(fn().call(body)).toBe('Hi');
  });
});

describe('minSettleTimeoutMs', () => {
  it('fits two samples spanning the window on the poll grid, plus a tick', () => {
    expect(minSettleTimeoutMs(0)).toBe(500);
    expect(minSettleTimeoutMs(500)).toBe(750);
    expect(minSettleTimeoutMs(9_800)).toBe(10_050);
    expect(minSettleTimeoutMs(10_000)).toBe(10_250);
  });
});

describe('pollFor — ticks that tell the truth', () => {
  const SHOP = 'https://shop.example/cart';

  beforeEach(async () => {
    vi.useFakeTimers();
    installChrome([SHOP]);
    await setAllowlist([{ pattern: 'shop.example', allowEvaluate: false, addedAt: 0 }]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A text probe answering each of `texts` in turn; an Error rejects. */
  function textProbe(texts: unknown[]) {
    let i = 0;
    return vi
      .spyOn(chrome.debugger, 'sendCommand')
      .mockImplementation(async (_t, method, params) => {
        const p = params as { functionDeclaration?: string };
        if (method === 'Runtime.evaluate') return { result: { objectId: 'body' } };
        if (p?.functionDeclaration === VISIBLE_TEXT_FN) {
          const r = texts[Math.min(i++, texts.length - 1)];
          if (r instanceof Error) throw r;
          return { result: { value: r } };
        }
        return {};
      });
  }

  it('rides out a navigation that takes the body mid-tick, then finds the text', async () => {
    textProbe([new Error('Cannot find context with specified id'), 'Welcome back']);
    const pending = pollFor(TAB, {
      selector: null,
      text: 'Welcome',
      timeoutMs: 1000,
      absent: false,
    });
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ found: true });
  });

  it('never reads a lost tick as the text being gone', async () => {
    textProbe([new Error('Execution context was destroyed.'), 'Loading…', 'Done']);
    const pending = pollFor(TAB, {
      selector: null,
      text: 'Loading',
      timeoutMs: 2000,
      absent: true,
    });
    await vi.runAllTimersAsync();
    const out = await pending;
    expect(out).toMatchObject({ found: true });
    expect(out.elapsedMs).toBeGreaterThanOrEqual(500); // not on the lost tick at 0
  });

  it('fails a present-wait at once when its @eN is destroyed mid-wait', async () => {
    const { newRef } = await import('../src/tools/refs.js');
    const ref = '@' + newRef(TAB, 77, 'button', 'Save');
    let boxes = 0;
    vi.spyOn(chrome.debugger, 'sendCommand').mockImplementation(async (_t, method) => {
      if (method === 'DOM.describeNode') return { node: {} }; // alive before the loop
      if (method === 'DOM.getBoxModel') {
        if (boxes++ === 0) throw new Error('Could not compute box model.'); // hidden
        throw new Error('No node found for given backend id'); // then destroyed
      }
      return {};
    });
    const pending = pollFor(TAB, { selector: ref, text: null, timeoutMs: 10_000, absent: false });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'bad_ref' });
    await vi.runAllTimersAsync();
    await rejected;
    expect(boxes).toBe(2); // two ticks, not the whole 10 s
  });

  it('counts a destroyed @eN as gone under absent', async () => {
    const { newRef } = await import('../src/tools/refs.js');
    const ref = '@' + newRef(TAB, 78, 'dialog', 'Saving');
    vi.spyOn(chrome.debugger, 'sendCommand').mockImplementation(async (_t, method) => {
      if (method === 'DOM.getBoxModel') throw new Error('No node found for given backend id');
      return {};
    });
    const pending = pollFor(TAB, { selector: ref, text: null, timeoutMs: 1000, absent: true });
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ found: true });
  });

  it('reports how long a folded wait ran before it failed', async () => {
    let gets = 0;
    const tabsGet = chrome.tabs.get;
    vi.spyOn(chrome.tabs, 'get').mockImplementation(async (id: number) =>
      ++gets > 3 ? ({ id, url: 'https://sso.example/login' } as chrome.tabs.Tab) : tabsGet(id),
    );
    textProbe(['not yet']);
    const pending = runEmbeddedWait(TAB, {
      selector: null,
      text: 'Done',
      timeoutMs: 5000,
      absent: false,
    });
    await vi.runAllTimersAsync();
    const out = await pending;
    expect(out.reason).toBe('domain_not_allowed');
    expect(out.elapsedMs).toBeGreaterThanOrEqual(500);
  });

  it('reports the url its LAST tick read', async () => {
    let gets = 0;
    vi.spyOn(chrome.tabs, 'get').mockImplementation(
      async (id: number) =>
        ({ id, url: ++gets > 1 ? 'https://shop.example/item/42' : SHOP }) as chrome.tabs.Tab,
    );
    textProbe(['list', 'item 42']);
    const seen: { url?: string } = {};
    const pending = pollFor(
      TAB,
      { selector: null, text: 'item', timeoutMs: 1000, absent: false },
      seen,
    );
    await vi.runAllTimersAsync();
    await pending;
    expect(seen.url).toBe('https://shop.example/item/42');
  });
});

describe('settle — a window that cannot fit its timeout', () => {
  const SHOP = 'https://shop.example/cart';

  beforeEach(async () => {
    vi.useFakeTimers();
    installChrome([SHOP]);
    await setAllowlist([{ pattern: 'shop.example', allowEvaluate: false, addedAt: 0 }]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('refuses an explicit timeoutMs too short for stableMs, instead of calling the page busy', async () => {
    const { settle } = await import('../src/tools/settle.js');
    await expect(settle({ stableMs: 2000, timeoutMs: 1500, tabId: TAB })).rejects.toMatchObject({
      code: 'bad_args',
      message: expect.stringContaining('timeoutMs >= 2250'),
    });
  });

  it('settles a static page when real per-tick latency eats the last grid slot', async () => {
    // 40 ms to create the observer, 6 ms per sample: with a window that closes
    // a few ms after the last POLL_MS tick, the loop used to exit first and
    // call a static page "never quiesced".
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    vi.spyOn(chrome.debugger, 'sendCommand').mockImplementation(async (_t, method, params) => {
      const p = params as { functionDeclaration?: string };
      if (method === 'Runtime.evaluate') {
        await delay(40);
        return { result: { objectId: 'observer' } };
      }
      if (p?.functionDeclaration?.includes('sample')) {
        await delay(6);
        return { result: { value: 0 } };
      }
      return {};
    });
    const pending = settleFor(TAB, { stableMs: 10_000, timeoutMs: minSettleTimeoutMs(10_000) });
    await vi.runAllTimersAsync();
    expect((await pending).settled).toBe(true);
  });

  it('stretches a DEFAULTED timeout to fit, so a static page settles', async () => {
    // stableMs 10000 against the 10000 default could never succeed.
    const { settle } = await import('../src/tools/settle.js');
    const pending = settle({ stableMs: 10_000, tabId: TAB });
    await vi.runAllTimersAsync();
    const res = await pending;
    expect((res.data as { settled: boolean }).settled).toBe(true);
  });
});
