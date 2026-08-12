import { pointOutsideViewport } from '../src/tools/aim.js';
import { describe, expect, it } from 'vitest';

import { CLICK_POINT_BY_VALUE, CLICK_POINT_KEYS, parsePointerTarget } from '../src/tools/mouse.js';

describe('parsePointerTarget (mouse_click / hover)', () => {
  it('selector mode passes the selector through', () => {
    expect(parsePointerTarget({ selector: '@e3' }, 'hover')).toEqual({
      mode: 'selector',
      selector: '@e3',
    });
  });

  it('coord mode parses x/y', () => {
    expect(parsePointerTarget({ x: 10, y: 20 }, 'hover')).toEqual({ mode: 'coord', x: 10, y: 20 });
  });

  it('requires x and y together', () => {
    expect(() => parsePointerTarget({ x: 10 }, 'mouse_click')).toThrowError(
      /mouse_click: x and y must be given together/,
    );
    expect(() => parsePointerTarget({ y: 20 }, 'hover')).toThrowError(
      /hover: x and y must be given together/,
    );
  });

  it('rejects selector and coords together', () => {
    expect(() => parsePointerTarget({ selector: '.x', x: 1, y: 2 }, 'mouse_click')).toThrowError(
      /pass either selector or x\/y, not both/,
    );
  });

  it('requires at least one target', () => {
    expect(() => parsePointerTarget({}, 'hover')).toThrowError(/hover: selector or x\/y required/);
  });

  it('rejects negative or non-finite coords', () => {
    expect(() => parsePointerTarget({ x: -1, y: 2 }, 'hover')).toThrowError(
      /x must be a non-negative number/,
    );
    expect(() => parsePointerTarget({ x: 1, y: NaN }, 'hover')).toThrowError(
      /y must be a non-negative number/,
    );
  });

  it('names the calling tool in every error (shared helper, distinct messages)', () => {
    expect(() => parsePointerTarget({}, 'mouse_click')).toThrowError(/mouse_click:/);
    expect(() => parsePointerTarget({}, 'hover')).toThrowError(/hover:/);
  });

  it('treats an empty selector string as absent', () => {
    expect(() => parsePointerTarget({ selector: '' }, 'hover')).toThrowError(/selector or x\/y/);
  });
});

/**
 * The aim probe's result carries the covering ELEMENT in `hitEl`, so it has to
 * stay a remote object and a second call lifts the plain fields out by value.
 * That projection is a hand-written mirror of `ClickPoint`, and a mirror
 * drifts: `vw`/`vh` were added to the probe for the off-viewport refusal but
 * not to the projection, so they arrived `undefined`, the refusal took its
 * fail-open branch on every single call, and the feature was inert while the
 * whole suite stayed green — no test crossed the serialisation boundary.
 * These do.
 */
describe('CLICK_POINT_BY_VALUE (the probe result projection)', () => {
  const sample = {
    tag: 'BUTTON',
    x: 12,
    y: 4200,
    vw: 1000,
    vh: 800,
    visible: true,
    covered: false,
    hitTarget: null,
    hitTag: null,
    // The one field that must NOT come back: it is an element handle.
    hitEl: { nodeType: 1 },
  };

  const project = () =>
    new Function(`return (${CLICK_POINT_BY_VALUE});`)() as (
      this: unknown,
    ) => Record<string, unknown>;

  it('carries every ClickPoint field except hitEl', () => {
    const out = project().call(sample);
    expect(Object.keys(out).sort()).toEqual(
      Object.keys(sample)
        .filter((k) => k !== 'hitEl')
        .sort(),
    );
  });

  it('carries the viewport the refusal depends on — the field that was dropped', () => {
    const out = project().call(sample);
    expect(out.vw).toBe(1000);
    expect(out.vh).toBe(800);
    // …and the projected object is still recognised as off-viewport, which it
    // was not while vw/vh were missing.
    expect(pointOutsideViewport(out as never)).toBe(true);
  });

  it('never carries the element handle back across the wire', () => {
    expect(project().call(sample)).not.toHaveProperty('hitEl');
  });

  it('is generated from the key list, so a new field cannot be forgotten', () => {
    for (const k of CLICK_POINT_KEYS) expect(CLICK_POINT_BY_VALUE).toContain(`${k}: this.${k}`);
  });
});
