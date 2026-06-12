/**
 * Clip math behind `screenshot`'s maxWidth/region options. `computeClip` is
 * the pure decision (screenshot.ts itself is chrome-bound); these tests pin
 * the clamping and scaling rules: regions are viewport-relative
 * (getBoundingClientRect coordinates), intersected with the viewport, and
 * converted to page-absolute clip coords; maxWidth only ever downscales.
 */

import { describe, expect, it } from 'vitest';
import { computeClip, type Viewport } from '../src/tools/clip.js';

const vp: Viewport = { pageX: 0, pageY: 100, width: 1280, height: 720 };

describe('computeClip', () => {
  it('captures the full viewport when no region is given', () => {
    expect(computeClip(vp, null, null)).toEqual({
      x: 0,
      y: 100,
      width: 1280,
      height: 720,
      scale: 1,
    });
  });

  it('downscales to maxWidth, preserving aspect via a single scale factor', () => {
    const clip = computeClip(vp, null, 640);
    expect(clip).toEqual({ x: 0, y: 100, width: 1280, height: 720, scale: 0.5 });
  });

  it('never upscales: maxWidth wider than the capture is a no-op', () => {
    expect(computeClip(vp, null, 4000)?.scale).toBe(1);
  });

  it('offsets a region by the scroll position (clip coords are page-absolute)', () => {
    const clip = computeClip(vp, { x: 10, y: 20, width: 100, height: 50 }, null);
    expect(clip).toEqual({ x: 10, y: 120, width: 100, height: 50, scale: 1 });
  });

  it('clamps a region that overflows the viewport edge', () => {
    const clip = computeClip(vp, { x: 1200, y: 700, width: 500, height: 500 }, null);
    expect(clip).toEqual({ x: 1200, y: 800, width: 80, height: 20, scale: 1 });
  });

  it('clamps a negative origin, shrinking the captured size accordingly', () => {
    const clip = computeClip(vp, { x: -50, y: -10, width: 100, height: 100 }, null);
    expect(clip).toEqual({ x: 0, y: 100, width: 50, height: 90, scale: 1 });
  });

  it('returns null for a region entirely outside the viewport', () => {
    expect(computeClip(vp, { x: 2000, y: 0, width: 100, height: 100 }, null)).toBeNull();
    expect(computeClip(vp, { x: -300, y: 0, width: 100, height: 100 }, null)).toBeNull();
    expect(computeClip(vp, { x: 0, y: 900, width: 100, height: 100 }, null)).toBeNull();
  });

  it('scales relative to the region width, not the viewport width', () => {
    const clip = computeClip(vp, { x: 0, y: 0, width: 400, height: 300 }, 200);
    expect(clip?.scale).toBe(0.5);
    expect(clip?.width).toBe(400); // clip stays in CSS px; scale does the shrinking
  });
});
