import { isAgentWindow } from './agent-window.js';
import { attach, cdp } from './cdp.js';
import { computeClip, type Region } from './clip.js';
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

  if (region || maxWidth !== null) {
    const metrics = await cdp<{
      cssVisualViewport?: {
        pageX: number;
        pageY: number;
        clientWidth: number;
        clientHeight: number;
      };
      cssLayoutViewport?: {
        pageX: number;
        pageY: number;
        clientWidth: number;
        clientHeight: number;
      };
    }>(tab.id!, 'Page.getLayoutMetrics');
    const vv = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
    if (!vv) throw new BridgeError('bad_args', 'screenshot: could not read viewport metrics');
    const clip = computeClip(
      { pageX: vv.pageX, pageY: vv.pageY, width: vv.clientWidth, height: vv.clientHeight },
      region,
      maxWidth,
    );
    if (!clip) {
      throw new BridgeError('bad_args', 'screenshot: region is entirely outside the viewport');
    }
    params.clip = clip;
  }

  const out = await captureWithDeadline(tab.id!, params);
  return {
    tabId: tab.id,
    url: tab.url,
    data: { format, data: out.data, dataLength: out.data.length },
  };
};
