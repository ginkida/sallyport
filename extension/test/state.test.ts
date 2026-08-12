import { describe, expect, it } from 'vitest';

import {
  ELEMENT_STATE_FN,
  parseStateMaxChars,
  parseStateSelectors,
  shapeElementState,
  type RawElementState,
} from '../src/tools/state.js';

describe('parseStateMaxChars (get_state)', () => {
  it('defaults to 2000 when absent', () => {
    expect(parseStateMaxChars(undefined)).toBe(2000);
    expect(parseStateMaxChars(null)).toBe(2000);
  });

  it('accepts in-range integers and caps at 20000', () => {
    expect(parseStateMaxChars(1)).toBe(1);
    expect(parseStateMaxChars(5000)).toBe(5000);
    expect(parseStateMaxChars(999_999)).toBe(20_000);
  });

  it('rejects zero, negatives and non-integers', () => {
    expect(() => parseStateMaxChars(0)).toThrowError(/maxChars must be an integer/);
    expect(() => parseStateMaxChars(-1)).toThrowError(/maxChars/);
    expect(() => parseStateMaxChars(2.5)).toThrowError(/maxChars/);
    expect(() => parseStateMaxChars('lots')).toThrowError(/maxChars/);
  });
});

describe('shapeElementState (get_state)', () => {
  const raw = (over: Partial<RawElementState> = {}): RawElementState => ({
    tag: 'BUTTON',
    textLen: 5,
    text: 'hello',
    x: 10.4,
    y: 20.6,
    width: 100.2,
    height: 30.8,
    inViewport: true,
    ...over,
  });

  it('reports a visible element with a rounded viewport-relative box', () => {
    expect(shapeElementState(raw())).toEqual({
      exists: true,
      visible: true,
      tag: 'button',
      text: 'hello',
      box: { x: 10, y: 21, width: 100, height: 31 },
      inViewport: true,
    });
  });

  it('omits box/inViewport for a zero-size (hidden) element but still exists', () => {
    expect(shapeElementState(raw({ width: 0, height: 0, inViewport: false }))).toEqual({
      exists: true,
      visible: false,
      tag: 'button',
      text: 'hello',
    });
  });

  it('treats a zero-width-but-tall element as not visible', () => {
    const out = shapeElementState(raw({ width: 0, height: 30 }));
    expect(out.visible).toBe(false);
    expect(out.box).toBeUndefined();
  });

  it('marks truncation when the live text is longer than the slice', () => {
    const out = shapeElementState(raw({ text: 'hel', textLen: 4000 }));
    expect(out.truncated).toBe(true);
    expect(out.textLen).toBe(4000);
  });

  it('does not mark truncation when the full text fit', () => {
    const out = shapeElementState(raw({ text: 'hello', textLen: 5 }));
    expect(out.truncated).toBeUndefined();
    expect(out.textLen).toBeUndefined();
  });

  it('lower-cases the tag for CSS-consistent output', () => {
    expect(shapeElementState(raw({ tag: 'TEXTAREA' })).tag).toBe('textarea');
  });
});

describe('ELEMENT_STATE_FN (serialised in-page probe)', () => {
  // get_state serialises this into the page and invokes it on the resolved
  // element via callFunctionOn; `cap` is the only argument and travels as a
  // structured value, never interpolated. Any closure/import reference would
  // throw a ReferenceError in the page — assert it runs self-contained.
  const run = new Function(`return (${ELEMENT_STATE_FN});`)() as (
    this: unknown,
    cap: number,
  ) => RawElementState;

  const fakeEl = (over: Record<string, unknown> = {}) => ({
    tagName: 'BUTTON',
    innerText: '  Click me  ',
    textContent: 'fallback',
    ownerDocument: { defaultView: { innerWidth: 1000, innerHeight: 800 } },
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 100,
      height: 30,
      right: 110,
      bottom: 50,
    }),
    ...over,
  });

  it('reads trimmed innerText and reports geometry', () => {
    const out = run.call(fakeEl(), 2000);
    expect(out.tag).toBe('BUTTON');
    expect(out.text).toBe('Click me');
    expect(out.textLen).toBe(8);
    expect(out).toMatchObject({ x: 10, y: 20, width: 100, height: 30, inViewport: true });
  });

  it('slices text to the structured cap and preserves the true length', () => {
    const out = run.call(fakeEl({ innerText: 'abcdefghij' }), 4);
    expect(out.text).toBe('abcd');
    expect(out.textLen).toBe(10);
  });

  it('NEVER reads the field .value (no password-readback channel)', () => {
    // A real <input type=password> exposes its secret only via .value; the
    // probe must ignore it and read text content (empty for inputs) instead.
    const out = run.call(fakeEl({ innerText: '', textContent: '', value: 'hunter2' }), 2000);
    expect(out.text).toBe('');
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it('falls back to textContent when innerText is absent', () => {
    const out = run.call(fakeEl({ innerText: undefined }), 2000);
    expect(out.text).toBe('fallback');
  });

  it('reports inViewport=false for an element scrolled out of view', () => {
    const out = run.call(
      fakeEl({
        getBoundingClientRect: () => ({
          left: 10,
          top: 900,
          width: 100,
          height: 30,
          right: 110,
          bottom: 930,
        }),
      }),
      2000,
    );
    expect(out.inViewport).toBe(false);
  });
});

/**
 * Batched get_state. A post-action check is usually several assertions at once,
 * and one selector per call meant one model turn per assertion — the most
 * expensive axis there is. The scalar form must keep its exact old answer
 * shape, so the parser reports which form was used, not just the list.
 */
describe('parseStateSelectors (get_state)', () => {
  it('accepts a single selector and marks it NOT a batch', () => {
    expect(parseStateSelectors('#save')).toEqual({ selectors: ['#save'], batch: false });
    expect(parseStateSelectors('@e7')).toEqual({ selectors: ['@e7'], batch: false });
  });

  it('accepts an array and marks it a batch — even a one-element one', () => {
    expect(parseStateSelectors(['#a', '@e2'])).toEqual({
      selectors: ['#a', '@e2'],
      batch: true,
    });
    // A one-element ARRAY still answers in the array shape: the caller wrote a
    // batch, so it can index the result without special-casing.
    expect(parseStateSelectors(['#a'])).toEqual({ selectors: ['#a'], batch: true });
  });

  it('caps the batch at 10 and says how many it got', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `#e${i}`);
    expect(parseStateSelectors(ten).selectors).toHaveLength(10);
    expect(() => parseStateSelectors([...ten, '#overflow'])).toThrowError(/at most 10.*got 11/);
  });

  it('rejects an empty selector, an empty array and a non-string entry', () => {
    expect(() => parseStateSelectors('')).toThrowError(/selector required/);
    expect(() => parseStateSelectors([])).toThrowError(/must not be empty/);
    expect(() => parseStateSelectors(['#a', ''])).toThrowError(/selector\[1\]/);
    expect(() => parseStateSelectors(['#a', 42])).toThrowError(/selector\[1\]/);
  });

  it('rejects a non-string, non-array selector instead of coercing it', () => {
    expect(() => parseStateSelectors(undefined)).toThrowError(/selector required/);
    expect(() => parseStateSelectors(42)).toThrowError(/selector required/);
    expect(() => parseStateSelectors({ selector: '#a' })).toThrowError(/selector required/);
  });
});

/**
 * Batched get_state over a chrome-mocked CDP channel.
 *
 * The bug this pins: each probe used to fetch its OWN document root. Chromium's
 * `InspectorDOMAgent::getDocument` calls `DiscardFrontendBindings()`, throwing
 * away every nodeId handed out so far — so a second CSS selector invalidated
 * the first one's root, and the resulting "Could not find node with given id"
 * was reported through a blanket catch as `bad_args: invalid selector`
 * (retryable=no) on a selector that was perfectly valid.
 */
describe('get_state batching over CDP', () => {
  const TAB = 11;
  type Cmd = { method: string; params?: Record<string, unknown> };

  function installChrome(opts: { querySelectorThrows?: string } = {}): Cmd[] {
    const sent: Cmd[] = [];
    const store = new Map<string, unknown>();
    let nextRoot = 1;
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
          return { id: TAB, url: 'https://app.example.com/', title: 'app' };
        },
        onRemoved: { addListener() {} },
      },
      debugger: {
        async attach() {},
        async sendCommand(_t: { tabId: number }, method: string, params?: Record<string, unknown>) {
          sent.push({ method, params });
          if (method === 'DOM.getDocument') return { root: { nodeId: nextRoot++ } };
          if (method === 'DOM.querySelector') {
            if (opts.querySelectorThrows) throw new Error(opts.querySelectorThrows);
            return { nodeId: 42 };
          }
          if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
          if (method === 'Runtime.callFunctionOn') {
            return {
              result: {
                value: {
                  tag: 'DIV',
                  textLen: 2,
                  text: 'ok',
                  x: 1,
                  y: 2,
                  width: 10,
                  height: 4,
                  inViewport: true,
                },
              },
            };
          }
          return {};
        },
        onEvent: { addListener() {} },
        onDetach: { addListener() {} },
      },
    };
    return sent;
  }

  async function allowApp(): Promise<void> {
    const { setAllowlist } = await import('../src/storage.js');
    await setAllowlist([{ pattern: 'app.example.com', allowEvaluate: false, addedAt: 0 }]);
  }

  it('fetches the document root exactly ONCE for a whole CSS batch', async () => {
    const sent = installChrome();
    await allowApp();
    const { getState } = await import('../src/tools/state.js');
    const out = (await getState(
      { selector: ['#dialog', '#row-42', 'button[type=submit]'], tabId: TAB },
      undefined,
    )) as { data: { elements: Array<{ selector: string; exists: boolean }> } };

    expect(sent.filter((c) => c.method === 'DOM.getDocument')).toHaveLength(1);
    expect(sent.filter((c) => c.method === 'DOM.querySelector')).toHaveLength(3);
    // Every query uses the one live root, so none of them can be invalidated.
    for (const q of sent.filter((c) => c.method === 'DOM.querySelector')) {
      expect(q.params?.nodeId).toBe(1);
    }
    expect(out.data.elements.map((e) => e.selector)).toEqual([
      '#dialog',
      '#row-42',
      'button[type=submit]',
    ]);
    expect(out.data.elements.every((e) => e.exists)).toBe(true);
  });

  it('fetches no document at all for an all-@eN batch', async () => {
    const sent = installChrome();
    await allowApp();
    const { newRef, clearRefsForTab } = await import('../src/tools/refs.js');
    clearRefsForTab(TAB);
    const a = '@' + newRef(TAB, 501, 'button', 'Save');
    const b = '@' + newRef(TAB, 502, 'listitem', 'Row');
    const { getState } = await import('../src/tools/state.js');
    await getState({ selector: [a, b], tabId: TAB }, undefined);
    expect(sent.filter((c) => c.method === 'DOM.getDocument')).toHaveLength(0);
  });

  it('calls a malformed selector bad_args, but does NOT relabel a transient failure as one', async () => {
    installChrome({ querySelectorThrows: 'DOM Error while querying: invalid selector' });
    await allowApp();
    const { getState } = await import('../src/tools/state.js');
    await expect(
      getState({ selector: ':has-text("x")', tabId: TAB }, undefined),
    ).rejects.toMatchObject({ code: 'bad_args' });

    installChrome({ querySelectorThrows: 'Could not find node with given id' });
    await allowApp();
    // The old blanket catch called this a permanent agent mistake. It isn't —
    // and telling the agent retryable=no about a valid selector is the failure
    // mode that made the batch look broken.
    await expect(
      getState({ selector: '#dialog', tabId: TAB }, undefined),
    ).rejects.not.toMatchObject({ code: 'bad_args' });
  });
});
