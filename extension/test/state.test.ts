import { describe, expect, it } from 'vitest';

import {
  ELEMENT_STATE_FN,
  parseStateMaxChars,
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
