import { beforeEach, describe, expect, it } from 'vitest';

import {
  advanceSettle,
  classifyWaitError,
  INITIAL_SETTLE_STATE,
  parseMaxSteps,
  parseTimeoutMs,
  parseWaitFor,
  quiescenceSignal,
  QUIESCENCE_PROBE,
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
    expect(s.settled).toBe(false);
    // The window is BACKDATED to the earlier of the two equal readings: they
    // being equal is evidence the DOM held still across the whole interval,
    // not merely at the instant of the second sample.
    expect(s.state.stableSince).toBe(1000);
    s = advanceSettle(s.state, sig(10, 100), 1499, 500);
    expect(s.settled).toBe(false); // 499 ms < 500 ms window
    s = advanceSettle(s.state, sig(10, 100), 1500, 500);
    expect(s.settled).toBe(true); // 500 ms elapsed since the window opened
  });

  it('costs no extra tick on an already-static page (regression: window anchored to `now`)', () => {
    // Anchoring the window to the second sample charged every settle one
    // guaranteed extra POLL_MS: a static page proved a 500 ms window by t=500
    // but was only told so at t=750 — paid again on every reveal scroll step.
    const POLL = 250;
    let s = advanceSettle(INITIAL_SETTLE_STATE, sig(7, 70), 0, 500);
    s = advanceSettle(s.state, sig(7, 70), POLL, 500);
    expect(s.settled).toBe(false);
    s = advanceSettle(s.state, sig(7, 70), POLL * 2, 500);
    expect(s.settled).toBe(true); // t=500, not t=750
  });

  it('still refuses to settle on a single reading, however long the gap', () => {
    // The saving must not weaken the rule that two genuinely equal samples are
    // required — a long first tick is not evidence of anything.
    const s = advanceSettle(INITIAL_SETTLE_STATE, sig(4, 4), 10_000, 500);
    expect(s.settled).toBe(false);
    expect(s.state.stableSince).toBeNull();
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
        if (method === 'Runtime.evaluate') return { result: { value: { n: 1, len: 1 } } };
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
