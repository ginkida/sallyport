/**
 * Clip math behind `screenshot`'s maxWidth/region options. `computeClip` is
 * the pure decision (screenshot.ts itself is chrome-bound); these tests pin
 * the clamping and scaling rules: regions are viewport-relative
 * (getBoundingClientRect coordinates), intersected with the viewport, and
 * converted to page-absolute clip coords in DIP; maxWidth only ever downscales
 * and is measured in pixels of the RETURNED IMAGE, which is what makes it
 * device-scale-factor-aware.
 */

import { describe, expect, it } from 'vitest';
import { computeClip, pixelScale, type PixelScale, type Viewport } from '../src/tools/clip.js';

const vp: Viewport = { pageX: 0, pageY: 100, width: 1280, height: 720 };
const retina: PixelScale = { zoom: 1, devicePixelRatio: 2 };

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
    expect(clip?.width).toBe(400); // clip stays in DIP; scale does the shrinking
  });
});

describe('computeClip — maxWidth is measured in image pixels', () => {
  // Chrome returns round(trunc(clip.width) × clip.scale × deviceScaleFactor)
  // pixels: the DSF multiplies ON TOP of the scale. Applying maxWidth against
  // the CSS width (as this did before) delivered maxWidth × DSF pixels — twice
  // the requested size on every Retina display, three times under a
  // set_viewport emulation at dpr 3, which is exactly the payload the option
  // exists to cut.
  const imageWidth = (clip: { width: number; scale: number }, scaleInfo: PixelScale) =>
    Math.round(Math.trunc(clip.width) * clip.scale * (scaleInfo.devicePixelRatio / scaleInfo.zoom));

  it('delivers maxWidth PIXELS on a 2x display, not maxWidth CSS px', () => {
    const clip = computeClip(vp, null, 640, retina)!;
    expect(clip.width).toBe(1280); // the DIP rect is unchanged…
    expect(clip.scale).toBe(0.25); // …the scale absorbs the device ratio
    expect(imageWidth(clip, retina)).toBe(640);
  });

  it('delivers maxWidth pixels under an emulated dpr 3 too', () => {
    const emulated: PixelScale = { zoom: 1, devicePixelRatio: 3 };
    const clip = computeClip(vp, null, 600, emulated)!;
    expect(imageWidth(clip, emulated)).toBe(600);
  });

  it('does not upscale a viewport that is already under maxWidth in pixels', () => {
    // 1280 CSS px at dpr 2 is a 2560 px image: 3000 is not a downscale.
    expect(computeClip(vp, null, 3000, retina)?.scale).toBe(1);
    // …but 2000 is.
    expect(computeClip(vp, null, 2000, retina)?.scale).toBe(2000 / 2560);
  });

  it('is unchanged on an ordinary 1x display', () => {
    // Spelled out rather than compared against the defaulted call, which would
    // be a tautology: this is the compatibility claim the CHANGELOG makes.
    expect(computeClip(vp, null, 640, { zoom: 1, devicePixelRatio: 1 })).toEqual({
      x: 0,
      y: 100,
      width: 1280,
      height: 720,
      scale: 0.5,
    });
  });

  it('does not shrink a capture that an emulated sub-1 ratio already made small', () => {
    // set_viewport allows a deviceScaleFactor below 1, and below the zoom.
    // Treating the zoom as a floor there would overstate the natural width and
    // downscale an image that was already inside the budget.
    const tiny: PixelScale = { zoom: 1.5, devicePixelRatio: 0.75 };
    const clip = computeClip(vp, null, 1000, tiny)!;
    expect(clip.scale).toBe(1);
    const image = Math.round(
      Math.trunc(clip.width) * clip.scale * (tiny.devicePixelRatio / tiny.zoom),
    );
    expect(image).toBeLessThanOrEqual(1000);
  });
});

describe('computeClip — CSS px are converted to DIP', () => {
  // clip.x/y/width/height are DIP = CSS px × browser zoom. Chrome remembers a
  // per-site ctrl+/- zoom, so a zoomed tab used to be cropped to a 1/zoom
  // sub-rectangle of the region the agent asked for.
  const zoomed: PixelScale = { zoom: 1.5, devicePixelRatio: 1.5 };

  it('scales the rect and the scroll offset into DIP', () => {
    const clip = computeClip(vp, { x: 10, y: 20, width: 100, height: 50 }, null, zoomed)!;
    expect(clip).toEqual({ x: 15, y: 180, width: 150, height: 75, scale: 1 });
  });

  it('still ends up at maxWidth pixels when zoom and dpr both apply', () => {
    const both: PixelScale = { zoom: 1.5, devicePixelRatio: 3 }; // 1.5 zoom on a 2x display
    const clip = computeClip(vp, null, 480, both)!;
    const image = Math.round(
      Math.trunc(clip.width) * clip.scale * (both.devicePixelRatio / both.zoom),
    );
    expect(image).toBe(480);
  });

  it('floors to whole DIP and never asks for a zero-sized clip', () => {
    const clip = computeClip(vp, { x: 0, y: 0, width: 0.4, height: 0.4 }, null)!;
    expect(clip.width).toBe(1);
    expect(clip.height).toBe(1);
  });

  it('floors a fractional DIP rect rather than rounding past the surface', () => {
    // Chrome truncates the clip for the image size but rounds it for the view
    // resize; a clip that lands between whole DIP can therefore disagree with
    // itself and hit the crop-and-TILE path, which wraps page content.
    const fractional: Viewport = { pageX: 0, pageY: 100.6, width: 1279.5, height: 720 };
    const clip = computeClip(fractional, null, null, { zoom: 1.25, devicePixelRatio: 2.5 })!;
    expect(clip.x).toBe(0);
    expect(clip.y).toBe(125); // floor(100.6 × 1.25) = floor(125.75)
    expect(clip.width).toBe(1599); // floor(1279.5 × 1.25) = floor(1599.375)
    expect(clip.height).toBe(900);
    expect(Number.isInteger(clip.width)).toBe(true);
  });
});

describe('pixelScale', () => {
  it('passes plausible readings through', () => {
    expect(pixelScale(1, 2)).toEqual({ zoom: 1, devicePixelRatio: 2 });
    expect(pixelScale(1.5, 3)).toEqual({ zoom: 1.5, devicePixelRatio: 3 });
  });

  it('falls back to 1 for missing or absurd readings (a page can lie)', () => {
    expect(pixelScale(undefined, undefined)).toEqual({ zoom: 1, devicePixelRatio: 1 });
    expect(pixelScale(null, 0)).toEqual({ zoom: 1, devicePixelRatio: 1 });
    expect(pixelScale(1, Number.POSITIVE_INFINITY)).toEqual({ zoom: 1, devicePixelRatio: 1 });
    expect(pixelScale(1, 1000)).toEqual({ zoom: 1, devicePixelRatio: 1 });
    expect(pixelScale(1, -2)).toEqual({ zoom: 1, devicePixelRatio: 1 });
    expect(pixelScale('two', 'three')).toEqual({ zoom: 1, devicePixelRatio: 1 });
  });

  it('keeps a ratio below the zoom — set_viewport can emulate a sub-1 dpr', () => {
    expect(pixelScale(1.5, 0.75)).toEqual({ zoom: 1.5, devicePixelRatio: 0.75 });
  });

  it('defaults a missing ratio to the zoom, which is the part we do know', () => {
    expect(pixelScale(1.25, undefined)).toEqual({ zoom: 1.25, devicePixelRatio: 1.25 });
  });
});
