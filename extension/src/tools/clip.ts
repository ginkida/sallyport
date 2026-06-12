/** Pure clip-rectangle math for `screenshot`'s maxWidth/region options.
 *
 * Lives here, free of any `chrome.*` import, so vitest can pin the
 * clamping/scaling rules directly — `screenshot.ts` itself pulls in
 * `cdp.ts`, which registers chrome listeners at import time.
 */

/** Current viewport in CSS px, from `Page.getLayoutMetrics`.
 * `pageX`/`pageY` are the scroll offset (clip coords are page-absolute). */
export type Viewport = { pageX: number; pageY: number; width: number; height: number };

/** Viewport-relative crop rectangle in CSS px — same coordinate space as
 * `getBoundingClientRect`, so coords probed via `mouse_click`/`evaluate`
 * can be fed straight back in. */
export type Region = { x: number; y: number; width: number; height: number };

/** `Page.captureScreenshot`'s clip parameter. */
export type Clip = { x: number; y: number; width: number; height: number; scale: number };

/** Compute the capture clip. Returns null when the region falls entirely
 * outside the viewport (caller turns that into `bad_args`). The region is
 * intersected with the viewport — capturing off-screen page areas would
 * silently produce black/blank pixels, so we don't allow it. */
export function computeClip(
  viewport: Viewport,
  region: Region | null,
  maxWidth: number | null,
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
  const scale = maxWidth !== null && maxWidth < width ? maxWidth / width : 1;
  return { x: viewport.pageX + relX, y: viewport.pageY + relY, width, height, scale };
}
