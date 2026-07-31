import { isAgentWindow } from './agent-window.js';
import { attach, cdp, getEmulatedDsf } from './cdp.js';
import { computeClip, pixelScale, type PixelScale, type Region } from './clip.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { assertBringToFrontAllowed } from './ownership.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

function parseRegion(raw: unknown): Region | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BridgeError('bad_args', 'screenshot: region must be {x, y, width, height}');
  }
  const r = raw as Record<string, unknown>;
  const nums: number[] = [];
  for (const k of ['x', 'y', 'width', 'height']) {
    const v = Number(r[k]);
    if (!Number.isFinite(v)) {
      throw new BridgeError('bad_args', `screenshot: region.${k} must be a finite number`);
    }
    nums.push(v);
  }
  const [x, y, width, height] = nums;
  if (width <= 0 || height <= 0) {
    throw new BridgeError('bad_args', 'screenshot: region width/height must be positive');
  }
  return { x, y, width, height };
}

function parseMaxWidth(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 16) {
    throw new BridgeError('bad_args', 'screenshot: maxWidth must be an integer >= 16');
  }
  return v;
}

// How long we let Page.captureScreenshot wait for a frame before giving up.
// chrome.debugger.sendCommand has no timeout of its own, so a capture that
// stalls waiting for a frame that never comes would leave the promise pending
// forever, burn the daemon's whole 60 s request window, and — because the
// browser holds a `stay_awake` capturer handle for the duration — keep the
// human's display from sleeping while it hangs. Well under the request window,
// generous enough for a heavy page to raster.
const CAPTURE_DEADLINE_MS = 8000;

// Deliberately NOT used, recorded so they are not rediscovered as "the fix":
//  - `fromSurface:false` is the one captureScreenshot path that skips the
//    compositor wait, but Chrome refuses it for any non-trusted DevTools
//    client, which every extension is ("Only screenshots from surface are
//    allowed"). It also grabs the native window, so it would capture whatever
//    is on top rather than our tab.
//  - `captureBeyondViewport:true` is pure geometry: it re-enters the same code
//    path with a full-page clip and ends at the identical frame wait.
//  - `Page.setWebLifecycleState('active')` unfreezes; it does not un-hide.
// What DOES make a background tab raster is a capturer handle, which
// `Emulation.setFocusEmulationEnabled` (keep-awake, on by default) already
// takes, and which Chrome ≥131 takes for the duration of the capture itself.

/** Cap on the base64 image the extension will put on the wire: 12 MiB of
 * base64 ≈ 9 MiB of binary, comfortably under the daemon's 16 MiB frame cap
 * even with envelope and MAC overhead — the same ceiling `print_to_pdf` uses,
 * for the same reason. An oversize frame does not fail one call: the daemon
 * answers it with a 1009 close, which in broker mode drops the SHARED
 * extension leg for every attached session.
 *
 * A desktop viewport at DPR 1 never came close, which is why this guard did not
 * exist before. `set_viewport` makes it reachable — the emulated viewport times
 * the device scale factor IS the captured pixel size — so the tool caps its own
 * dimensions too, and this is the backstop for the real-monitor cases (a HiDPI
 * display already captures at 2× the CSS size). */
export const MAX_SCREENSHOT_BASE64_CHARS = 12 * 1024 * 1024;

export function checkScreenshotSize(base64: string): void {
  if (base64.length > MAX_SCREENSHOT_BASE64_CHARS) {
    throw new BridgeError(
      'screenshot_too_large',
      `screenshot: the capture is ${base64.length} base64 chars, over the ` +
        `${MAX_SCREENSHOT_BASE64_CHARS} limit the bridge frame cap can carry — pass maxWidth or ` +
        'region to shrink it, use format=jpeg, or lower deviceScaleFactor with set_viewport.',
    );
  }
}

/** Race a capture against a deadline so a stalled compositor fails legibly
 * instead of hanging until the daemon's request timeout. */
async function captureWithDeadline(
  tabId: number,
  params: Record<string, unknown>,
): Promise<{ data: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new BridgeError(
            'tab_not_visible',
            'screenshot: the tab did not produce a frame in time — it is hidden and Chrome ' +
              'could not raster it (a fully occluded window, a minimised window, or the ' +
              'display asleep). snapshot/read_text need no frame at all, and print_to_pdf ' +
              'renders a hidden tab fine.',
          ),
        ),
      CAPTURE_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([
      cdp<{ data: string }>(tabId, 'Page.captureScreenshot', params),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Give the tab the best chance of rastering WITHOUT disturbing the human.
 *
 * `bringToFront` is a real focus grab (`Activate()` + `Focus()` on the window)
 * and stays opt-in, refused outright in broker mode. But making a tab the
 * ACTIVE tab of a window Chrome is not focusing costs the human nothing —
 * `chrome.tabs.update({active:true})` is documented as not affecting window
 * focus — and it is what an agent's second, third, Nth tab needs: only the
 * first tab of the agent window is ever the selected one, so every later tab
 * is hidden purely as an artefact of how we opened it.
 *
 * Strictly scoped to OUR windows: activating a tab inside one of the human's
 * windows would yank away whatever they were reading. */
async function activateWithinAgentWindow(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.active || tab.id === undefined) return;
  if (!(await isAgentWindow(tab.windowId))) return;
  try {
    await chrome.tabs.update(tab.id, { active: true });
  } catch {
    // tab vanished / API unavailable — the capture below decides
  }
}

type ViewportMetrics = {
  pageX: number;
  pageY: number;
  clientWidth: number;
  clientHeight: number;
  zoom?: number;
};

type LayoutMetrics = {
  cssVisualViewport?: ViewportMetrics;
  cssLayoutViewport?: ViewportMetrics;
  // Deprecated twin of cssVisualViewport, kept populated by Chrome: its
  // clientWidth/clientHeight are PHYSICAL px, which is what makes the ratio
  // below a device-scale-factor reading.
  visualViewport?: { clientWidth: number; clientHeight: number; zoom?: number };
};

// FIXED literal, no interpolation — the same trust shape as the aim/state
// probes (invariant #4), and the smallest possible one.
const DPR_PROBE = 'window.devicePixelRatio';

/** Learn how many image pixels this tab puts out per CSS px, and how much of
 * that is browser zoom.
 *
 * Both numbers bound the size of what goes into the model's context, so the
 * authority for them is BROWSER-owned, never the page:
 *  - `zoom` comes from the layout metrics (exactly the CSS→DIP factor, and it
 *    stays pure browser zoom even under device emulation);
 *  - the ratio comes from the emulation WE applied (`getEmulatedDsf`, times the
 *    zoom, since the caller divides that back out), or else from the metrics
 *    ratio `physical/css`, which is the real display's device scale factor.
 *
 * The page is consulted only as a LOWER-BOUND refinement, and only because the
 * browser-owned pair has one honest blind spot: an MV3 worker restart drops the
 * emulation record while the CDP emulation itself survives, and layout metrics
 * deliberately keep reporting the REAL device scale factor while an emulation
 * is active (Chrome hands the compositor the real one to keep rasterisation
 * sharp). `window.devicePixelRatio` sees the emulated value, so it can raise
 * the floor — but it can never lower it. A page that shadows the property could
 * otherwise under-report and make `maxWidth` deliver an image several times
 * wider than asked for; over-reporting only shrinks that page's own capture. */
async function readPixelScale(tabId: number, metrics: LayoutMetrics): Promise<PixelScale> {
  const zoom = metrics.cssVisualViewport?.zoom ?? metrics.visualViewport?.zoom;
  const css = metrics.cssVisualViewport?.clientWidth;
  const physical = metrics.visualViewport?.clientWidth;
  const fromMetrics = css && physical ? physical / css : undefined;
  const emulated = getEmulatedDsf(tabId);
  // In the unit computeClip consumes: image px per CSS px, zoom included.
  const browserOwned = emulated !== undefined ? emulated * (zoom ?? 1) : fromMetrics;

  let fromPage = 0;
  try {
    const out = await cdp<{ result: { value?: unknown } }>(tabId, 'Runtime.evaluate', {
      expression: DPR_PROBE,
      returnByValue: true,
    });
    const v = Number(out.result.value);
    if (Number.isFinite(v) && v > 0) fromPage = v;
  } catch {
    // no execution context (mid-navigation) — the browser-owned value stands
  }
  return pixelScale(zoom, Math.max(browserOwned ?? 0, fromPage) || undefined);
}

export const screenshot: Tool = async (args) => {
  const region = parseRegion(args.region);
  const maxWidth = parseMaxWidth(args.maxWidth);
  const bringToFront = args.bringToFront === true;
  // Broker mode forbids foregrounding the agent tab (focus-theft mitigation).
  assertBringToFrontAllowed(bringToFront);
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  if (bringToFront) {
    // Explicit opt-in, standalone only: this really does foreground the tab
    // and its window.
    await cdp(tab.id!, 'Page.bringToFront');
  } else {
    await activateWithinAgentWindow(tab);
  }
  const format = args.format === 'jpeg' ? 'jpeg' : 'png';
  const params: Record<string, unknown> = { format };
  if (format === 'jpeg') params.quality = typeof args.quality === 'number' ? args.quality : 80;

  // A clip DOES make Chrome resize the widget browser-side
  // (page_handler.cc SetSize + restore), but it applies a compensating device
  // emulation at the same time, so the page does NOT observe a reflow or a
  // `resize` event. Checked against Chrome 150 — an earlier version of this
  // comment claimed the opposite and was wrong. Don't warn agents off `region`
  // or `maxWidth` on that basis.
  if (region || maxWidth !== null) {
    const metrics = await cdp<LayoutMetrics>(tab.id!, 'Page.getLayoutMetrics');
    const vv = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
    if (!vv) throw new BridgeError('bad_args', 'screenshot: could not read viewport metrics');
    const clip = computeClip(
      { pageX: vv.pageX, pageY: vv.pageY, width: vv.clientWidth, height: vv.clientHeight },
      region,
      maxWidth,
      await readPixelScale(tab.id!, metrics),
    );
    if (!clip) {
      throw new BridgeError('bad_args', 'screenshot: region is entirely outside the viewport');
    }
    params.clip = clip;
  }

  const out = await captureWithDeadline(tab.id!, params);
  checkScreenshotSize(out.data);
  return {
    tabId: tab.id,
    url: tab.url,
    data: { format, data: out.data, dataLength: out.data.length },
  };
};
