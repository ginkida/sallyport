import { describe, expect, it } from 'vitest';

import { parseScrollDelta, parseScrollSpec } from '../src/tools/scroll.js';

describe('parseScrollDelta (scroll)', () => {
  it('accepts positives, zero and negatives (up/left)', () => {
    expect(parseScrollDelta(300, 'dy')).toBe(300);
    expect(parseScrollDelta(0, 'dx')).toBe(0);
    expect(parseScrollDelta(-150, 'dy')).toBe(-150);
  });

  it('rejects NaN, ±Infinity and non-numbers', () => {
    expect(() => parseScrollDelta(NaN, 'dy')).toThrowError(/dy must be a finite number/);
    expect(() => parseScrollDelta(Infinity, 'dx')).toThrowError(/finite/);
    expect(() => parseScrollDelta(-Infinity, 'dy')).toThrowError(/finite/);
    expect(() => parseScrollDelta('lots', 'dy')).toThrowError(/finite/);
  });

  it('rejects absurd magnitudes (either sign)', () => {
    expect(() => parseScrollDelta(5_000_000, 'dy')).toThrowError(/too large/);
    expect(() => parseScrollDelta(-5_000_000, 'dy')).toThrowError(/too large/);
  });
});

describe('parseScrollSpec (scroll)', () => {
  it('into-view mode needs a selector', () => {
    expect(parseScrollSpec({ selector: '@e5' })).toEqual({ kind: 'into_view', selector: '@e5' });
    expect(() => parseScrollSpec({})).toThrowError(/give selector.*or dx\/dy\/to/);
  });

  it('treats an empty selector as absent', () => {
    expect(() => parseScrollSpec({ selector: '' })).toThrowError(/give selector/);
  });

  it('by mode scrolls the page when no selector is given', () => {
    expect(parseScrollSpec({ dy: 500 })).toEqual({
      kind: 'by',
      selector: null,
      dx: 0,
      dy: 500,
      to: null,
    });
    expect(parseScrollSpec({ dx: -20, dy: 30 })).toEqual({
      kind: 'by',
      selector: null,
      dx: -20,
      dy: 30,
      to: null,
    });
  });

  it('by mode scrolls a named container', () => {
    expect(parseScrollSpec({ selector: '.feed', dy: 800 })).toEqual({
      kind: 'by',
      selector: '.feed',
      dx: 0,
      dy: 800,
      to: null,
    });
  });

  it('to mode validates the edge keyword against a fixed allowlist', () => {
    expect(parseScrollSpec({ to: 'bottom' })).toEqual({
      kind: 'by',
      selector: null,
      dx: 0,
      dy: 0,
      to: 'bottom',
    });
    expect(parseScrollSpec({ to: 'top' }).to).toBe('top');
    expect(() => parseScrollSpec({ to: 'sideways' })).toThrowError(/to must be 'top' or 'bottom'/);
  });

  it('rejects combining to with dx/dy (ambiguous)', () => {
    expect(() => parseScrollSpec({ to: 'top', dy: 100 })).toThrowError(/either to or dx\/dy/);
  });

  it('rejects a non-finite delta through the spec path', () => {
    expect(() => parseScrollSpec({ dy: NaN })).toThrowError(/finite/);
  });
});
