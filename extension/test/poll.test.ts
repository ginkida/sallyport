import { describe, expect, it } from 'vitest';

import {
  parseTimeoutMs,
  parseWaitFor,
  quiescenceSignal,
  QUIESCENCE_PROBE,
  SCROLL_STEP_PROBE,
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
