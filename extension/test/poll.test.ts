import { describe, expect, it } from 'vitest';

import {
  advanceSettle,
  INITIAL_SETTLE_STATE,
  parseMaxSteps,
  parseTimeoutMs,
  parseWaitFor,
  quiescenceSignal,
  QUIESCENCE_PROBE,
  SCROLL_STEP_PROBE,
  scrollStalled,
} from '../src/tools/poll.js';

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

describe('quiescenceSignal / QUIESCENCE_PROBE (settle)', () => {
  const fakeDoc = (n: number, html: string) => ({
    getElementsByTagName: () => ({ length: n }),
    body: { innerHTML: html },
  });

  it('returns element count and body HTML length, never the content', () => {
    expect(quiescenceSignal(fakeDoc(42, 'hello'))).toEqual({ n: 42, len: 5 });
  });

  it('tolerates a missing body', () => {
    expect(quiescenceSignal({ getElementsByTagName: () => ({ length: 3 }), body: null })).toEqual({
      n: 3,
      len: 0,
    });
  });

  it('is self-contained: QUIESCENCE_PROBE runs with no closure refs', () => {
    // settle serialises the probe into the page; any import / module-const
    // reference would throw a ReferenceError there. `document` is the only
    // free name and it is a fixed reference, not agent input.
    const run = new Function('document', `return ${QUIESCENCE_PROBE};`) as (d: unknown) => {
      n: number;
      len: number;
    };
    expect(run(fakeDoc(7, 'abcd'))).toEqual({ n: 7, len: 4 });
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
  const sig = (n: number, len: number) => ({ n, len });

  it('declares settled only after equal readings span the stability window', () => {
    let s = advanceSettle(INITIAL_SETTLE_STATE, sig(10, 100), 1000, 500);
    expect(s.settled).toBe(false); // first reading: steadiness not yet confirmable
    s = advanceSettle(s.state, sig(10, 100), 1300, 500);
    expect(s.settled).toBe(false); // window opens here (first confirmed-equal reading)
    expect(s.state.stableSince).toBe(1300);
    s = advanceSettle(s.state, sig(10, 100), 1799, 500);
    expect(s.settled).toBe(false); // 499 ms < 500 ms window
    s = advanceSettle(s.state, sig(10, 100), 1800, 500);
    expect(s.settled).toBe(true); // 500 ms elapsed since the window opened
  });

  it('restarts the window when either signal changes', () => {
    let s = advanceSettle(INITIAL_SETTLE_STATE, sig(1, 1), 0, 500);
    s = advanceSettle(s.state, sig(1, 1), 400, 500); // window open
    s = advanceSettle(s.state, sig(2, 1), 800, 500); // n changed → reset
    expect(s.settled).toBe(false);
    expect(s.state.stableSince).toBeNull();
    // a fresh steady stretch must again span the full window from scratch
    s = advanceSettle(s.state, sig(2, 1), 1000, 500);
    expect(s.settled).toBe(false);
    s = advanceSettle(s.state, sig(2, 1), 1600, 500);
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
    let s = advanceSettle(INITIAL_SETTLE_STATE, sig(5, 5), 0, 200);
    s = advanceSettle(s.state, sig(5, 5), 100, 200); // window open
    expect(s.state.stableSince).not.toBeNull();
    s = advanceSettle(s.state, null, 200, 200); // no reading → reset
    expect(s.state).toEqual(INITIAL_SETTLE_STATE);
  });

  it('settles on the second equal reading when stableMs is 0', () => {
    let s = advanceSettle(INITIAL_SETTLE_STATE, sig(3, 3), 0, 0);
    expect(s.settled).toBe(false); // first reading
    s = advanceSettle(s.state, sig(3, 3), 0, 0);
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
