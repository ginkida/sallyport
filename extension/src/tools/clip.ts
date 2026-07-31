/** Pure clip-rectangle math for `screenshot`'s maxWidth/region options.
 *
 * Lives here, free of any `chrome.*` import, so vitest can pin the
 * clamping/scaling rules directly — `screenshot.ts` itself pulls in
 * `cdp.ts`, which registers chrome listeners at import time.
 *
 * Two unit systems meet in this file, and conflating them is what made
 * `maxWidth` a lie on every HiDPI display:
 *  - the agent speaks CSS px (`getBoundingClientRect` coordinates), and so does
 *    `Page.getLayoutMetrics.cssVisualViewport`;
 *  - `Page.captureScreenshot`'s `clip` is in DIP — CSS px multiplied by the
 *    BROWSER ZOOM (Chrome remembers a per-site ctrl+/- zoom, so this is not a
 *    hypothetical) — and the image it returns is
 *    `round(trunc(clip.width) × clip.scale × deviceScaleFactor)` PIXELS, with
 *    the device scale factor multiplying on top of the scale rather than
 *    replacing it.
 * So `maxWidth` is honoured in the unit the caller cares about — pixels of the
 * returned image — and the rect is converted CSS → DIP before it goes out.
 */

/** Current viewport in CSS px, from `Page.getLayoutMetrics`.
 * `pageX`/`pageY` are the scroll offset (clip coords are page-absolute). */
export type Viewport = { pageX: number; pageY: number; width: number; height: number };

/** Viewport-relative crop rectangle in CSS px — same coordinate space as
 * `getBoundingClientRect`, so coords probed via `mouse_click`/`evaluate`
 * can be fed straight back in. */
export type Region = { x: number; y: number; width: number; height: number };

/** `Page.captureScreenshot`'s clip parameter, in DIP. */
export type Clip = { x: number; y: number; width: number; height: number; scale: number };

/** How this tab maps CSS px onto the pixels Chrome puts in the image.
 *
 *  - `zoom` — CSS → DIP, i.e. the browser's ctrl+/- zoom for this site.
 *  - `devicePixelRatio` — CSS → image pixels at `scale: 1`. That is the
 *    display's device scale factor, or the EMULATED one while `set_viewport`
 *    is active, and it already includes `zoom`.
 */
export type PixelScale = { zoom: number; devicePixelRatio: number };

/** A tab with no zoom on an ordinary display: CSS px, DIP and image pixels all
 * coincide. Also the fallback when the readings can't be trusted — it is the
 * behaviour this code had before it knew about either factor. */
export const DEFAULT_PIXEL_SCALE: PixelScale = { zoom: 1, devicePixelRatio: 1 };

// Nothing real is outside this. A reading beyond it means the source lied (a
// page can redefine `devicePixelRatio`) or we misread a metrics field, and a
// bogus factor would silently mis-scale or mis-crop the capture.
const MIN_FACTOR = 0.1;
const MAX_FACTOR = 8;

function sane(value: unknown, fallback: number): number {
  const v = Number(value);
  if (!Number.isFinite(v) || v < MIN_FACTOR || v > MAX_FACTOR) return fallback;
  return v;
}

/** Validate the two factors, falling back independently. Pure so the
 * fail-safe-to-1 behaviour is pinned rather than assumed.
 *
 * A ratio SMALLER than the zoom is not clamped away, tempting as that is: on a
 * real display the ratio does contain the zoom, but `set_viewport` can emulate
 * a device scale factor below 1, and clamping there would overstate the
 * capture's natural width and shrink an image that was already inside the
 * budget. An unreadable ratio still falls back to the zoom, which is the part
 * we do know. */
export function pixelScale(zoom: unknown, devicePixelRatio: unknown): PixelScale {
  const z = sane(zoom, DEFAULT_PIXEL_SCALE.zoom);
  return { zoom: z, devicePixelRatio: sane(devicePixelRatio, z) };
}

/** Compute the capture clip. Returns null when the region falls entirely
 * outside the viewport (caller turns that into `bad_args`). The region is
 * intersected with the viewport — capturing off-screen page areas would
 * silently produce black/blank pixels, so we don't allow it.
 *
 * `maxWidth` bounds the width of the RETURNED IMAGE in pixels. It used to be
 * applied as `maxWidth / cssWidth`, which ignored the device scale factor
 * Chrome multiplies in afterwards: on a Retina display `maxWidth: 800` came
 * back 1600 px wide, and under a `set_viewport` emulation at dpr 3, 2400 px —
 * exactly the payload the option exists to cut. */
export function computeClip(
  viewport: Viewport,
  region: Region | null,
  maxWidth: number | null,
  scaleInfo: PixelScale = DEFAULT_PIXEL_SCALE,
): Clip | null {
  let relX = 0;
  let relY = 0;
  let width = viewport.width;
  let height = viewport.height;
  if (region) {
    relX = Math.max(0, region.x);
    relY = Math.max(0, region.y);
    // A negative origin eats into the requested size (the off-screen part
    // simply isn't captured), then the far edge is clamped to the viewport.
    width = Math.min(region.width + Math.min(0, region.x), viewport.width - relX);
    height = Math.min(region.height + Math.min(0, region.y), viewport.height - relY);
    if (width <= 0 || height <= 0) return null;
  }

  // CSS → DIP, floored to whole DIP: Chrome TRUNCATES clip.width/height when it
  // computes the image size but ROUNDS them when it resizes the view, so a
  // fractional clip can disagree with itself by a pixel and land on the
  // crop-and-TILE path — which fills the shortfall by wrapping page content
  // rather than padding. Flooring also guarantees we never ask for a rectangle
  // wider than the surface we are capturing.
  const { zoom, devicePixelRatio } = scaleInfo;
  const x = Math.floor((viewport.pageX + relX) * zoom);
  const y = Math.floor((viewport.pageY + relY) * zoom);
  const dipWidth = Math.max(1, Math.floor(width * zoom));
  const dipHeight = Math.max(1, Math.floor(height * zoom));

  // What this clip returns at scale 1, in image pixels:
  // dipWidth × (devicePixelRatio / zoom) — the DIP rect times the device scale
  // factor, with the zoom divided back out because it is already in dipWidth.
  const naturalWidth = (dipWidth * devicePixelRatio) / zoom;
  const scale = maxWidth !== null && maxWidth < naturalWidth ? maxWidth / naturalWidth : 1;
  return { x, y, width: dipWidth, height: dipHeight, scale };
}
