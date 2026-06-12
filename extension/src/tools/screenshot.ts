import { attach, cdp } from './cdp.js';
import { computeClip, type Region } from './clip.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
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

// Fixed probe (no agent input — same trust shape as the other fixed
// literals, no per-domain evaluate flag needed). Chrome freezes the
// renderer of hidden tabs (background tab, or fully occluded window on
// macOS), so Page.captureScreenshot waits for a frame that never comes and
// the daemon times the call out at 60 s. Probe first and fail fast.
const VISIBILITY_PROBE = 'document.visibilityState';

async function readVisibility(tabId: number): Promise<string | null> {
  try {
    const r = await cdp<{ result: { value?: unknown } }>(tabId, 'Runtime.evaluate', {
      expression: VISIBILITY_PROBE,
      returnByValue: true,
      timeout: 2000,
    });
    return typeof r.result.value === 'string' ? r.result.value : null;
  } catch {
    return null; // can't probe — let the capture itself decide
  }
}

/** Fail fast with `tab_not_visible` instead of hanging when the tab cannot
 * produce a frame. `bringToFront` activates the tab first (explicit opt-in —
 * it visibly steals the user's tab/window focus) and waits briefly for the
 * renderer to learn it is visible. */
async function ensureVisible(tabId: number, bringToFront: boolean): Promise<void> {
  if (bringToFront) {
    await cdp(tabId, 'Page.bringToFront');
    // Activation reaches the renderer asynchronously — poll up to ~2 s.
    for (let i = 0; i < 20 && (await readVisibility(tabId)) === 'hidden'; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if ((await readVisibility(tabId)) === 'hidden') {
    throw new BridgeError(
      'tab_not_visible',
      'screenshot: tab is hidden (background tab or occluded window) — Chrome will not render ' +
        'a frame for it. Activate the tab manually or pass bringToFront=true.',
    );
  }
}

export const screenshot: Tool = async (args) => {
  const region = parseRegion(args.region);
  const maxWidth = parseMaxWidth(args.maxWidth);
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  await ensureVisible(tab.id!, args.bringToFront === true);
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

  const out = await cdp<{ data: string }>(tab.id!, 'Page.captureScreenshot', params);
  return {
    tabId: tab.id,
    url: tab.url,
    data: { format, data: out.data, dataLength: out.data.length },
  };
};
