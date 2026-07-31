/** `set_viewport` — per-tab viewport / device emulation.
 *
 * The gap it closes: an agent could drive a page but never change the size it
 * is being viewed at, so "does this render on a phone" was unanswerable — the
 * one question a development agent asks most. Resizing the real window is the
 * wrong instrument for it: it is one shared window per session (so it would
 * disturb every other tab that session owns), it cannot produce a device pixel
 * ratio of 3 or the mobile `<meta viewport>` handling that makes a narrow
 * window an actual phone, and in broker mode the agent window is deliberately
 * unfocused — moving it is exactly the focus-theft the design avoids.
 *
 * So this is DevTools' device mode, per tab, over structured CDP:
 *  - `Emulation.setDeviceMetricsOverride` — width/height/deviceScaleFactor and
 *    the `mobile` flag (which is what turns on viewport-meta handling, mobile
 *    scrollbars and the small-screen UA-CSS);
 *  - `Emulation.setTouchEmulationEnabled` — `'ontouchstart' in window`,
 *    `navigator.maxTouchPoints`, and the `(pointer: coarse)` / `(hover: none)`
 *    media queries a responsive layout branches on;
 *  - `Emulation.setUserAgentOverride` (opt-out) — so a server that branches on
 *    the UA serves its mobile bundle instead of the desktop one the agent would
 *    otherwise measure and report as a layout bug.
 *
 * Security shape:
 *  - allowlist-gated (#3) via `ensureAllowed`, like every page-touching tool;
 *  - owner-gated in broker mode for free (#13): it is not in the daemon's
 *    `UNGATED_TOOLS`/`CREATE_CAPABLE`, so a tabId-less call is `tab_required`;
 *  - NO page JavaScript is needed to apply it — every command is structured
 *    CDP, so it needs no `allowEvaluate` (#4). The one read-back probe is a
 *    FIXED literal (`VIEWPORT_PROBE`) with zero agent interpolation, the same
 *    trust shape as `get_state`'s ELEMENT_STATE_FN;
 *  - it INVALIDATES the tab's `@eN` refs (#7) exactly as `navigate`/`reload` do:
 *    crossing a responsive breakpoint remounts DOM (a mobile nav replacing the
 *    desktop one), so refs minted at 1280 px are meaningless at 393 px.
 *
 * Ruled-out routes, recorded so they are not rediscovered as "the fix":
 *  - `Emulation.setEmitTouchEventsForMouse` is NOT used and must not be. It
 *    installs a TouchEmulator in kEmulatingTouchFromMouse mode, and
 *    `RenderWidgetHostImpl::ForwardMouseEventWithLatencyInfo` then swallows
 *    every injected mouse event (`if (touch_emulator->HandleMouseEvent(...))
 *    return;`) — which would silently break `mouse_click` and `hover`, the two
 *    tools whose failures are hardest to diagnose. `setTouchEmulationEnabled`
 *    is Blink-side feature detection only and leaves the input path alone.
 *  - `scale`, `viewport{x,y,scale}` and `positionX/positionY` are never sent.
 *    They shift or scale the input coordinate space away from CSS px, which
 *    would desync `Input.dispatchMouseEvent` coordinates from the rects
 *    `aim.ts`/`state.ts` measure — a silent mis-aim, not an error.
 *
 * Lifetime: the override belongs to the debugger session, and Chrome re-applies
 * it across navigations and reloads of the same tab (the emulation handler is
 * browser-side and survives the renderer swap), so "set the viewport, then
 * navigate" works. It ends at `reset:true`, when the tab closes, or when the
 * bridge detaches — `cdp.ts:detach` clears it EXPLICITLY, because a bare detach
 * provably does not restore the tab's real size on its own.
 */

import { attach, cdp, recordEmulatedDsf, releaseViewport } from './cdp.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { clearRefsForTab } from './refs.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

// Bounds. Chrome itself only refuses > 10 000 000, which is no protection at
// all: the emulated viewport multiplied by the device scale factor is exactly
// the pixel size of a later `screenshot`, and an oversize frame does not fail
// the call — it trips the daemon's 16 MiB cap and 1009-closes the SHARED
// extension leg, dropping every broker session's bridge. So the ceiling here is
// "no larger than a big real monitor at a real DPR": 4096 CSS px per side and
// 4096² device px in total (1280×800 @3 and 1920×1080 @2 both fit; 4096² @2
// does not).
const MIN_DIMENSION = 50;
const MAX_DIMENSION = 4096;
const MAX_DEVICE_SCALE_FACTOR = 3;
const MAX_DEVICE_PIXELS = 4096 * 4096;

// Reported as `navigator.maxTouchPoints` when touch emulation is on. Real
// phones report 5; `> 0` is the common feature test, and `> 1` is used by a
// minority of libraries to tell a touchscreen laptop from a phone.
const TOUCH_POINTS = 5;

export type UaForm = 'phone' | 'tablet';

export type ViewportPreset = {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  touch: boolean;
  ua: UaForm | null;
};

/** Named starting points, sized from Chrome DevTools' own device list
 * (`EmulatedDevices.ts`) but named by BREAKPOINT rather than by handset: a
 * preset called `iphone-15` would age badly and imply a fidelity CDP emulation
 * does not have. `mobile-small` is iPhone SE, `mobile` iPhone 15 Pro,
 * `mobile-large` Pixel 7, `tablet` iPad Air, `desktop` DevTools' "Laptop with
 * MDPI screen".
 *
 * Every mobile preset carries a Chrome-on-Android UA (see `deriveUserAgent`) —
 * never a Safari/WebKit one, even for the iPhone-sized entries. Claiming a
 * different ENGINE would make a server ship code this browser does not run, and
 * the resulting breakage would look like a bug in the page under test. */
export const VIEWPORT_PRESETS: Readonly<Record<string, ViewportPreset>> = Object.freeze({
  'mobile-small': {
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    ua: 'phone',
  },
  mobile: { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true, ua: 'phone' },
  'mobile-large': {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    touch: true,
    ua: 'phone',
  },
  tablet: {
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    ua: 'tablet',
  },
  desktop: {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
    touch: false,
    ua: null,
  },
  'desktop-wide': {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
    touch: false,
    ua: null,
  },
});

export const PRESET_NAMES: string[] = Object.keys(VIEWPORT_PRESETS);

export type Orientation = 'portrait' | 'landscape';

export type SetViewportSpec = {
  mode: 'set';
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  touch: boolean;
  orientation: Orientation;
  userAgent: UaForm | null;
};

export type ViewportSpec = { mode: 'read' } | { mode: 'reset' } | SetViewportSpec;

// Every argument that describes a viewport to SET. Used both to decide "this
// call is a read" and to reject `reset` mixed with a size (which of the two the
// agent meant is unknowable, and guessing either way is a silent wrong answer).
const SIZE_ARGS = [
  'preset',
  'width',
  'height',
  'deviceScaleFactor',
  'mobile',
  'touch',
  'orientation',
  'mobileUserAgent',
];

function given(args: Record<string, unknown>, key: string): boolean {
  return args[key] !== undefined && args[key] !== null;
}

function parseBool(raw: unknown, name: string): boolean {
  if (typeof raw !== 'boolean') {
    throw new BridgeError('bad_args', `set_viewport: ${name} must be true or false`);
  }
  return raw;
}

/** One viewport dimension in CSS px. Integer-only: a fractional layout viewport
 * is not a thing a device has, and rounding silently would make the read-back
 * disagree with the request. */
export function parseDimension(raw: unknown, name: string): number {
  const v = Number(raw);
  if (!Number.isInteger(v)) {
    throw new BridgeError('bad_args', `set_viewport: ${name} must be a whole number of CSS px`);
  }
  if (v < MIN_DIMENSION || v > MAX_DIMENSION) {
    throw new BridgeError(
      'bad_args',
      `set_viewport: ${name} must be between ${MIN_DIMENSION} and ${MAX_DIMENSION} CSS px (got ${v})`,
    );
  }
  return v;
}

/** Device pixel ratio. Fractional is legitimate (Pixel 7 is 2.625, Windows
 * scaling gives 1.5), so this only rejects non-finite, non-positive and
 * out-of-range values. */
export function parseScaleFactor(raw: unknown): number {
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    throw new BridgeError('bad_args', 'set_viewport: deviceScaleFactor must be a positive number');
  }
  if (v > MAX_DEVICE_SCALE_FACTOR) {
    throw new BridgeError(
      'bad_args',
      `set_viewport: deviceScaleFactor must be <= ${MAX_DEVICE_SCALE_FACTOR} — it multiplies the ` +
        'pixel size of every later screenshot, which the bridge frame cap has to carry',
    );
  }
  return v;
}

function parsePreset(raw: unknown): ViewportPreset | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !Object.prototype.hasOwnProperty.call(VIEWPORT_PRESETS, raw)) {
    throw new BridgeError(
      'bad_args',
      `set_viewport: unknown preset ${JSON.stringify(raw)} — one of ${PRESET_NAMES.join(', ')}`,
    );
  }
  return VIEWPORT_PRESETS[raw];
}

function parseOrientation(raw: unknown, width: number, height: number): Orientation {
  if (raw === undefined || raw === null) return width > height ? 'landscape' : 'portrait';
  if (raw !== 'portrait' && raw !== 'landscape') {
    throw new BridgeError(
      'bad_args',
      "set_viewport: orientation must be 'portrait' or 'landscape'",
    );
  }
  return raw;
}

/** Decide what the call is asking for, validating as we go.
 *
 * Three shapes: no arguments at all is a READ (report what the page currently
 * sees — cheap, and the only way to find out whether an override survived),
 * `reset:true` alone is the undo, anything else is a SET. Pure, so the whole
 * arg contract is unit-testable without chrome. */
export function parseViewportSpec(args: Record<string, unknown>): ViewportSpec {
  const sized = SIZE_ARGS.filter((k) => given(args, k));

  if (given(args, 'reset') && parseBool(args.reset, 'reset')) {
    if (sized.length) {
      throw new BridgeError(
        'bad_args',
        `set_viewport: reset takes no other settings (got ${sized.join(', ')}) — call it alone to ` +
          'drop the override, or pass a size to replace it',
      );
    }
    return { mode: 'reset' };
  }

  if (sized.length === 0) return { mode: 'read' };

  const preset = parsePreset(args.preset);
  const hasWidth = given(args, 'width');
  const hasHeight = given(args, 'height');
  if (!preset && !(hasWidth && hasHeight)) {
    throw new BridgeError(
      'bad_args',
      `set_viewport: give preset (${PRESET_NAMES.join(', ')}) or BOTH width and height`,
    );
  }

  let width = hasWidth ? parseDimension(args.width, 'width') : preset!.width;
  let height = hasHeight ? parseDimension(args.height, 'height') : preset!.height;
  const deviceScaleFactor = given(args, 'deviceScaleFactor')
    ? parseScaleFactor(args.deviceScaleFactor)
    : (preset?.deviceScaleFactor ?? 1);
  const mobile = given(args, 'mobile')
    ? parseBool(args.mobile, 'mobile')
    : (preset?.mobile ?? false);
  const touch = given(args, 'touch') ? parseBool(args.touch, 'touch') : (preset?.touch ?? false);

  // Orientation ORIENTS the dimensions rather than adding a third source of
  // truth: landscape means the wide side is the width, whichever way they
  // arrived. That makes `preset:'mobile', orientation:'landscape'` do the
  // obvious thing without the agent restating 852×393.
  const orientation = parseOrientation(args.orientation, width, height);
  if (orientation === 'landscape' && height > width) [width, height] = [height, width];
  if (orientation === 'portrait' && width > height) [width, height] = [height, width];

  const devicePixels =
    Math.round(width * deviceScaleFactor) * Math.round(height * deviceScaleFactor);
  if (devicePixels > MAX_DEVICE_PIXELS) {
    throw new BridgeError(
      'bad_args',
      `set_viewport: ${width}×${height} at deviceScaleFactor ${deviceScaleFactor} is ` +
        `${devicePixels} device px, over the ${MAX_DEVICE_PIXELS} budget a screenshot of it ` +
        'would have to carry — lower deviceScaleFactor or the size',
    );
  }

  // The UA follows the phone/tablet-ness of what was asked for, because that is
  // what makes a UA-sniffing server send its mobile bundle — measuring the
  // desktop bundle at 393 px and calling it a layout bug is the failure this
  // avoids. Explicit `mobileUserAgent` wins either way.
  const wantUa = given(args, 'mobileUserAgent')
    ? parseBool(args.mobileUserAgent, 'mobileUserAgent')
    : preset
      ? preset.ua !== null
      : mobile;

  return {
    mode: 'set',
    width,
    height,
    deviceScaleFactor,
    mobile,
    touch,
    orientation,
    userAgent: wantUa ? (preset?.ua ?? 'phone') : null,
  };
}

/** Build the `Emulation.setDeviceMetricsOverride` parameters. Deliberately the
 * minimum set that is coherent with how every other tool measures the page (see
 * the ruled-out routes above): sizes, DPR, the mobile flag, and — only when
 * emulating a mobile device — the screen orientation, which is what
 * `screen.orientation` and orientation media queries read. `screenWidth` /
 * `screenHeight` are sent so `screen.width` agrees with the viewport instead of
 * reporting the human's real monitor; they shift no coordinate space (only
 * `positionX`/`positionY`, which are never sent, would). Pure. */
export function deviceMetricsParams(spec: SetViewportSpec): Record<string, unknown> {
  const params: Record<string, unknown> = {
    width: spec.width,
    height: spec.height,
    deviceScaleFactor: spec.deviceScaleFactor,
    mobile: spec.mobile,
    screenWidth: spec.width,
    screenHeight: spec.height,
  };
  if (spec.mobile) {
    params.screenOrientation =
      spec.orientation === 'landscape'
        ? { type: 'landscapePrimary', angle: 90 }
        : { type: 'portraitPrimary', angle: 0 };
  }
  return params;
}

const UA_DEVICE: Readonly<Record<UaForm, { model: string; mobileToken: string }>> = Object.freeze({
  phone: { model: 'Pixel 7', mobileToken: ' Mobile' },
  tablet: { model: 'Pixel Tablet', mobileToken: '' },
});

/** The Chrome major version out of a UA string, or null if it isn't a Chrome
 * UA (a fork, or a stubbed test environment). Pure. */
export function chromeMajorVersion(realUa: string): string | null {
  const m = /Chrome\/(\d+)/.exec(realUa || '');
  return m ? m[1] : null;
}

/** Derive the mobile UA from the REAL one rather than shipping a frozen string:
 * the version then tracks the browser actually running, and the claim stays
 * true where it matters — this really is that Chrome, just presenting as the
 * Android build. Returns null when the real UA isn't recognisably Chrome, in
 * which case no UA override is applied at all (a stale hardcoded version is a
 * worse lie than none). Pure. */
export function deriveUserAgent(realUa: string, form: UaForm): string | null {
  const major = chromeMajorVersion(realUa);
  if (!major) return null;
  const device = UA_DEVICE[form];
  return (
    `Mozilla/5.0 (Linux; Android 14; ${device.model}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${major}.0.0.0${device.mobileToken} Safari/537.36`
  );
}

export type UaBrand = { brand: string; version: string };

/** The UA client-hints half of the override (`Sec-CH-UA-*`).
 *
 * It is not optional decoration: Chrome only sends client hints derived from an
 * override when `userAgentMetadata` is supplied — overriding the UA string
 * alone makes it send NO `Sec-CH-UA` headers at all, so a modern server reading
 * `Sec-CH-UA-Mobile` still sees "not mobile" while the UA string says phone.
 * That combination is both less useful and more conspicuous than not spoofing.
 * `brands` is passed through from the real browser when available so the GREASE
 * brand and version stay self-consistent. Pure. */
export function deriveUserAgentMetadata(
  realUa: string,
  form: UaForm,
  brands: UaBrand[] | null,
): Record<string, unknown> | null {
  const major = chromeMajorVersion(realUa);
  if (!major) return null;
  const device = UA_DEVICE[form];
  const list: UaBrand[] =
    brands && brands.length
      ? brands
      : [
          { brand: 'Chromium', version: major },
          { brand: 'Google Chrome', version: major },
        ];
  return {
    brands: list,
    fullVersionList: list.map((b) => ({ brand: b.brand, version: `${b.version}.0.0.0` })),
    platform: 'Android',
    platformVersion: '14.0.0',
    architecture: '',
    model: device.model,
    mobile: form === 'phone',
  };
}

export type UserAgentAction =
  { kind: 'set'; userAgent: string; metadata: Record<string, unknown> | null } | { kind: 'clear' };

/** What a SET should do about the tab's user agent — and it is always a
 * complete statement, never "leave whatever was there".
 *
 * The asymmetric version of this was a one-way latch: emulate a phone, then ask
 * for `desktop` (or `mobileUserAgent:false`), and the tab kept presenting as an
 * Android phone while reporting a 1280px non-mobile viewport. A UA-sniffing
 * server would keep serving its mobile bundle, the agent would measure that at
 * desktop width and report a layout bug that does not exist — the exact
 * wrong-verdict the UA override exists to prevent, inverted. `clear` is also
 * what an unrecognisable real UA yields: applying nothing is right, but leaving
 * an EARLIER call's phone UA in place is not. Pure. */
export function userAgentAction(
  form: UaForm | null,
  realUa: string,
  brands: UaBrand[] | null,
): UserAgentAction {
  if (!form) return { kind: 'clear' };
  const userAgent = deriveUserAgent(realUa, form);
  if (!userAgent) return { kind: 'clear' };
  return { kind: 'set', userAgent, metadata: deriveUserAgentMetadata(realUa, form, brands) };
}

/** The browser's own UA, read from the service worker — same browser, same
 * version, and no page JavaScript involved. */
function realUserAgent(): string {
  return (typeof navigator !== 'undefined' && navigator.userAgent) || '';
}

/** The real brand list, when this Chrome exposes `navigator.userAgentData`.
 * Shape-checked rather than trusted: it is read from a browser API, but a
 * malformed entry would travel straight into a CDP parameter. */
function realBrands(): UaBrand[] | null {
  const data = (navigator as unknown as { userAgentData?: { brands?: unknown } }).userAgentData;
  const raw = data?.brands;
  if (!Array.isArray(raw)) return null;
  const out: UaBrand[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { brand, version } = item as { brand?: unknown; version?: unknown };
    if (typeof brand === 'string' && typeof version === 'string') out.push({ brand, version });
  }
  return out.length ? out : null;
}

// FIXED literal, zero interpolation — the read-back the tool reports instead of
// echoing its own request. Everything here is what the PAGE sees, which is the
// only honest answer: on a mobile-emulated page `innerWidth` legitimately
// differs from the emulated width when the document's `<meta name=viewport>`
// defines its own layout width.
export const VIEWPORT_PROBE = `(function() {
  var s = window.screen || {};
  var o = s.orientation || {};
  var n = navigator || {};
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    deviceScaleFactor: window.devicePixelRatio,
    screenWidth: s.width || 0,
    screenHeight: s.height || 0,
    orientation: typeof o.type === 'string' ? o.type : '',
    touch: ('ontouchstart' in window) || (n.maxTouchPoints || 0) > 0,
    maxTouchPoints: n.maxTouchPoints || 0,
    userAgent: String(n.userAgent || '').slice(0, 512)
  };
})()`;

export type ViewportReading = {
  width: number;
  height: number;
  deviceScaleFactor: number;
  screenWidth: number;
  screenHeight: number;
  orientation: string;
  touch: boolean;
  maxTouchPoints: number;
  userAgent: string;
};

/** Read what the page currently sees. Returns null (never throws) when the
 * probe can't run — a page mid-navigation has no execution context, and that is
 * a "couldn't verify", not a failed emulation. */
async function readViewport(tabId: number): Promise<ViewportReading | null> {
  try {
    const out = await cdp<{ result: { value?: ViewportReading } }>(tabId, 'Runtime.evaluate', {
      expression: VIEWPORT_PROBE,
      returnByValue: true,
    });
    return out.result.value ?? null;
  } catch {
    return null;
  }
}

function errText(e: unknown): string {
  return ((e as Error)?.message || String(e)).slice(0, 200);
}

/** Explain a layout viewport that came back different from the emulated one —
 * WITHOUT inventing the cause.
 *
 * The mismatch has two opposite meanings and the extension cannot tell them
 * apart from here: a page with `<meta name=viewport>` legitimately choosing its
 * own layout width (nothing to see), or a page with NO such tag falling back to
 * Chrome's ~980 px legacy width on a mobile device — which is not an artefact
 * at all, it IS the "this page is not mobile-ready" finding the agent was sent
 * to look for. An earlier version of this note asserted the first cause
 * unconditionally, i.e. it explained away the very bug the tool exists to
 * surface. Pure, so the wording is pinned by a test. */
export function describeLayoutMismatch(
  spec: SetViewportSpec,
  page: ViewportReading | null,
): string | undefined {
  if (!page || page.width === spec.width) return undefined;
  const observed = `the page's layout viewport is ${page.width}×${page.height} CSS px, not the ${spec.width} asked for`;
  const applied = 'The device metrics were applied as requested.';
  if (!spec.mobile) {
    return `${observed} — the document decides its own layout width. ${applied}`;
  }
  return (
    `${observed} — a page with <meta name=viewport> picks its own layout width, and a page ` +
    `WITHOUT one falls back to ~980 px on a mobile device, which is itself a responsive bug ` +
    `worth reporting. Check for the tag before concluding either way. ${applied}`
  );
}

async function applyEmulation(tabId: number, spec: SetViewportSpec): Promise<void> {
  try {
    // Awaiting this is a real barrier, not a formality: the command answers
    // FallThrough, i.e. Chrome replies only once the renderer has applied the
    // new metrics — so the read-back below sees the reflowed page.
    await cdp(tabId, 'Emulation.setDeviceMetricsOverride', deviceMetricsParams(spec));
  } catch (e) {
    throw new BridgeError(
      'viewport_failed',
      `set_viewport: the browser refused the device metrics: ${errText(e)}`,
    );
  }
  // Only after the await resolves — the command answers FallThrough, so
  // resolution means the renderer really is at this ratio. `screenshot` reads
  // it to bound `maxWidth`: the emulated ratio sizes the capture, but Chrome's
  // layout metrics keep reporting the real display one, so this record is the
  // only browser-owned way to know it.
  recordEmulatedDsf(tabId, spec.deviceScaleFactor);

  // Touch and UA are best-effort on purpose: they are refinements of an
  // emulation that already took effect, and the read-back reports what the page
  // actually ended up with, so a swallowed failure is visible rather than
  // claimed as success.
  try {
    await cdp(tabId, 'Emulation.setTouchEmulationEnabled', {
      enabled: spec.touch,
      ...(spec.touch ? { maxTouchPoints: TOUCH_POINTS } : {}),
    });
  } catch {
    // older Chrome / command unavailable — proceed without
  }

  const action = userAgentAction(spec.userAgent, realUserAgent(), realBrands());
  if (action.kind === 'set') {
    try {
      await cdp(tabId, 'Emulation.setUserAgentOverride', {
        userAgent: action.userAgent,
        ...(action.metadata ? { userAgentMetadata: action.metadata } : {}),
      });
    } catch {
      // Metadata is the fussier half (Chrome validates its shape); fall back
      // to the UA string alone rather than losing the override entirely.
      try {
        await cdp(tabId, 'Emulation.setUserAgentOverride', { userAgent: action.userAgent });
      } catch {
        // leave the real UA in place
      }
    }
  } else {
    // Empty string is the documented "no override" sentinel, and it travels
    // ALONE — Chrome refuses an empty userAgent sent with userAgentMetadata.
    try {
      await cdp(tabId, 'Emulation.setUserAgentOverride', { userAgent: '' });
    } catch {
      // never overridden / command unavailable — nothing to restore
    }
  }
}

export const setViewport: Tool = async (args) => {
  const spec = parseViewportSpec(args);
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  const tabId = tab.id!;

  if (spec.mode === 'read') {
    const page = await readViewport(tabId);
    if (!page) {
      throw new BridgeError(
        'viewport_failed',
        'set_viewport: could not read the viewport — the page has no execution context ' +
          '(mid-navigation, or an error page). Retry after the load settles.',
      );
    }
    return { tabId, url: tab.url, data: { ok: true, mode: 'read', page } };
  }

  if (spec.mode === 'reset') {
    await releaseViewport(tabId);
    clearRefsForTab(tabId);
    const page = await readViewport(tabId);
    return { tabId, url: tab.url, data: { ok: true, mode: 'reset', page } };
  }

  await applyEmulation(tabId, spec);
  // Same reasoning as navigate/reload: the layout the refs were minted against
  // is gone. A breakpoint change remounts DOM, so a stale @eN would resolve to
  // a node the new layout no longer shows.
  clearRefsForTab(tabId);
  const page = await readViewport(tabId);

  const requested = {
    width: spec.width,
    height: spec.height,
    deviceScaleFactor: spec.deviceScaleFactor,
    mobile: spec.mobile,
    touch: spec.touch,
    orientation: spec.orientation,
    userAgent: spec.userAgent,
  };
  const note = describeLayoutMismatch(spec, page);

  return {
    tabId,
    url: tab.url,
    data: { ok: true, mode: 'set', requested, page, ...(note ? { note } : {}) },
  };
};
