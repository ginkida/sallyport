import { describe, expect, it } from 'vitest';

import {
  chromeMajorVersion,
  describeLayoutMismatch,
  deriveUserAgent,
  deriveUserAgentMetadata,
  deviceMetricsParams,
  parseDimension,
  parseScaleFactor,
  parseViewportSpec,
  userAgentAction,
  VIEWPORT_PRESETS,
  VIEWPORT_PROBE,
  type SetViewportSpec,
  type ViewportReading,
} from '../src/tools/viewport.js';

const set = (args: Record<string, unknown>): SetViewportSpec => {
  const spec = parseViewportSpec(args);
  if (spec.mode !== 'set') throw new Error(`expected a set spec, got ${spec.mode}`);
  return spec;
};

describe('parseDimension / parseScaleFactor (set_viewport)', () => {
  it('takes whole CSS px inside the bounds', () => {
    expect(parseDimension(393, 'width')).toBe(393);
    expect(parseDimension(50, 'width')).toBe(50);
    expect(parseDimension(4096, 'height')).toBe(4096);
  });

  it('rejects fractional, non-finite and out-of-range dimensions', () => {
    expect(() => parseDimension(390.5, 'width')).toThrowError(/whole number/);
    expect(() => parseDimension(NaN, 'width')).toThrowError(/whole number/);
    expect(() => parseDimension('wide', 'width')).toThrowError(/whole number/);
    expect(() => parseDimension(49, 'width')).toThrowError(/between 50 and 4096/);
    expect(() => parseDimension(4097, 'height')).toThrowError(/between 50 and 4096/);
  });

  it('allows a fractional device pixel ratio but caps it', () => {
    expect(parseScaleFactor(2.625)).toBe(2.625);
    expect(parseScaleFactor(1)).toBe(1);
    expect(() => parseScaleFactor(0)).toThrowError(/positive number/);
    expect(() => parseScaleFactor(-1)).toThrowError(/positive number/);
    expect(() => parseScaleFactor(Infinity)).toThrowError(/positive number/);
    expect(() => parseScaleFactor(4)).toThrowError(/<= 3/);
  });
});

describe('parseViewportSpec — modes', () => {
  it('reads with no arguments at all', () => {
    expect(parseViewportSpec({})).toEqual({ mode: 'read' });
    // tabId is routing, not a viewport setting — it must not turn a read into a set.
    expect(parseViewportSpec({ tabId: 7 })).toEqual({ mode: 'read' });
  });

  it('resets only when reset is passed alone', () => {
    expect(parseViewportSpec({ reset: true })).toEqual({ mode: 'reset' });
    expect(() => parseViewportSpec({ reset: true, preset: 'mobile' })).toThrowError(
      /reset takes no other settings/,
    );
    expect(() => parseViewportSpec({ reset: true, width: 400, height: 800 })).toThrowError(
      /reset takes no other settings/,
    );
  });

  it('treats reset:false as absent, not as a reset', () => {
    expect(parseViewportSpec({ reset: false })).toEqual({ mode: 'read' });
    expect(set({ reset: false, preset: 'mobile' }).width).toBe(393);
  });

  it('rejects a non-boolean reset', () => {
    expect(() => parseViewportSpec({ reset: 'yes' })).toThrowError(/reset must be true or false/);
  });
});

describe('parseViewportSpec — presets', () => {
  it('expands a preset into the full spec', () => {
    expect(set({ preset: 'mobile' })).toEqual({
      mode: 'set',
      width: 393,
      height: 852,
      deviceScaleFactor: 3,
      mobile: true,
      touch: true,
      orientation: 'portrait',
      userAgent: 'phone',
    });
  });

  it('gives the tablet preset a tablet UA and desktop none', () => {
    expect(set({ preset: 'tablet' }).userAgent).toBe('tablet');
    expect(set({ preset: 'desktop' })).toEqual({
      mode: 'set',
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
      touch: false,
      orientation: 'landscape',
      userAgent: null,
    });
  });

  it('lets explicit fields override the preset', () => {
    const spec = set({ preset: 'mobile', width: 360, height: 640, deviceScaleFactor: 1 });
    expect(spec.width).toBe(360);
    expect(spec.height).toBe(640);
    expect(spec.deviceScaleFactor).toBe(1);
    // Not overridden: still a mobile device.
    expect(spec.mobile).toBe(true);
    expect(spec.touch).toBe(true);
  });

  it('rejects an unknown preset by name and lists the real ones', () => {
    expect(() => parseViewportSpec({ preset: 'iphone-99' })).toThrowError(
      /unknown preset "iphone-99"/,
    );
    expect(() => parseViewportSpec({ preset: 'iphone-99' })).toThrowError(/mobile-small/);
    // A prototype key must not resolve as a preset.
    expect(() => parseViewportSpec({ preset: 'constructor' })).toThrowError(/unknown preset/);
  });

  it('keeps every preset inside the tool s own bounds', () => {
    for (const [name, preset] of Object.entries(VIEWPORT_PRESETS)) {
      expect(() => parseDimension(preset.width, `${name}.width`)).not.toThrow();
      expect(() => parseDimension(preset.height, `${name}.height`)).not.toThrow();
      expect(() => parseScaleFactor(preset.deviceScaleFactor)).not.toThrow();
      expect(() => parseViewportSpec({ preset: name })).not.toThrow();
    }
  });
});

describe('parseViewportSpec — explicit sizes', () => {
  it('requires both width and height without a preset', () => {
    expect(() => parseViewportSpec({ width: 400 })).toThrowError(/BOTH width and height/);
    expect(() => parseViewportSpec({ height: 800 })).toThrowError(/BOTH width and height/);
    expect(set({ width: 400, height: 800 }).width).toBe(400);
  });

  it('defaults a bare size to a non-mobile, non-touch, dpr-1 desktop-ish viewport', () => {
    expect(set({ width: 400, height: 800 })).toEqual({
      mode: 'set',
      width: 400,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
      touch: false,
      orientation: 'portrait',
      userAgent: null,
    });
  });

  it('turns the UA on with mobile:true and off on request', () => {
    expect(set({ width: 400, height: 800, mobile: true }).userAgent).toBe('phone');
    expect(set({ width: 400, height: 800, mobile: true, mobileUserAgent: false }).userAgent).toBe(
      null,
    );
    expect(set({ preset: 'mobile', mobileUserAgent: false }).userAgent).toBe(null);
    expect(set({ preset: 'desktop', mobileUserAgent: true }).userAgent).toBe('phone');
  });

  it('rejects non-boolean flags', () => {
    expect(() => parseViewportSpec({ width: 400, height: 800, mobile: 'yes' })).toThrowError(
      /mobile must be true or false/,
    );
    expect(() => parseViewportSpec({ width: 400, height: 800, touch: 1 })).toThrowError(
      /touch must be true or false/,
    );
  });

  it('rejects a device-pixel budget no screenshot could carry', () => {
    // 4096x4096 at dpr 1 is exactly the budget; the same at dpr 2 is 4x over.
    expect(() => parseViewportSpec({ width: 4096, height: 4096 })).not.toThrow();
    expect(() =>
      parseViewportSpec({ width: 4096, height: 4096, deviceScaleFactor: 2 }),
    ).toThrowError(/over the .* budget/);
  });
});

describe('parseViewportSpec — orientation', () => {
  it('derives orientation from the dimensions when not given', () => {
    expect(set({ width: 400, height: 800 }).orientation).toBe('portrait');
    expect(set({ width: 800, height: 400 }).orientation).toBe('landscape');
  });

  it('orients the size rather than adding a second source of truth', () => {
    const landscape = set({ preset: 'mobile', orientation: 'landscape' });
    expect([landscape.width, landscape.height]).toEqual([852, 393]);
    const portrait = set({ preset: 'desktop', orientation: 'portrait' });
    expect([portrait.width, portrait.height]).toEqual([800, 1280]);
  });

  it('leaves an already-correct orientation alone', () => {
    const spec = set({ width: 900, height: 400, orientation: 'landscape' });
    expect([spec.width, spec.height]).toEqual([900, 400]);
  });

  it('rejects an unknown orientation', () => {
    expect(() =>
      parseViewportSpec({ width: 400, height: 800, orientation: 'sideways' }),
    ).toThrowError(/orientation must be 'portrait' or 'landscape'/);
  });
});

describe('deviceMetricsParams', () => {
  it('sends only the coordinate-space-safe parameters', () => {
    const params = deviceMetricsParams(set({ preset: 'mobile' }));
    expect(params).toEqual({
      width: 393,
      height: 852,
      deviceScaleFactor: 3,
      mobile: true,
      screenWidth: 393,
      screenHeight: 852,
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
    // scale / viewport / positionX / positionY would move the input coordinate
    // space away from CSS px and silently mis-aim mouse_click.
    for (const forbidden of ['scale', 'viewport', 'positionX', 'positionY']) {
      expect(params).not.toHaveProperty(forbidden);
    }
  });

  it('reports landscape to screen.orientation', () => {
    const params = deviceMetricsParams(set({ preset: 'mobile', orientation: 'landscape' }));
    expect(params.screenOrientation).toEqual({ type: 'landscapePrimary', angle: 90 });
    expect(params.width).toBe(852);
  });

  it('omits screenOrientation for a non-mobile viewport', () => {
    expect(deviceMetricsParams(set({ preset: 'desktop' }))).not.toHaveProperty('screenOrientation');
  });
});

describe('user-agent derivation', () => {
  const REAL =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/151.0.0.0 Safari/537.36';

  it('extracts the running Chrome major version', () => {
    expect(chromeMajorVersion(REAL)).toBe('151');
    expect(chromeMajorVersion('Mozilla/5.0 (X11; Linux) Firefox/128.0')).toBe(null);
    expect(chromeMajorVersion('')).toBe(null);
  });

  it('claims the same Chrome on Android, never another engine', () => {
    const phone = deriveUserAgent(REAL, 'phone')!;
    expect(phone).toContain('Chrome/151.0.0.0');
    expect(phone).toContain('Android');
    expect(phone).toContain('Mobile Safari/537.36');
    expect(phone).not.toContain('iPhone');
    expect(phone).not.toContain('Version/');
  });

  it('drops the Mobile token for a tablet', () => {
    const tablet = deriveUserAgent(REAL, 'tablet')!;
    expect(tablet).toContain('Pixel Tablet');
    expect(tablet).not.toContain('Mobile');
  });

  it('derives nothing when the real UA is not Chrome (no stale hardcoded version)', () => {
    expect(deriveUserAgent('Mozilla/5.0 (X11; Linux) Firefox/128.0', 'phone')).toBe(null);
    expect(deriveUserAgentMetadata('Mozilla/5.0 Firefox/128.0', 'phone', null)).toBe(null);
  });

  it('builds client-hint metadata that agrees with the UA string', () => {
    const meta = deriveUserAgentMetadata(REAL, 'phone', null)!;
    expect(meta.platform).toBe('Android');
    expect(meta.mobile).toBe(true);
    expect(meta.model).toBe('Pixel 7');
    expect(meta.brands).toEqual([
      { brand: 'Chromium', version: '151' },
      { brand: 'Google Chrome', version: '151' },
    ]);
    // A tablet is Android but not "mobile" to client hints.
    expect(deriveUserAgentMetadata(REAL, 'tablet', null)!.mobile).toBe(false);
  });

  it('passes the real brand list through when the browser exposes one', () => {
    const brands = [
      { brand: 'Not(A:Brand', version: '99' },
      { brand: 'Google Chrome', version: '151' },
    ];
    const meta = deriveUserAgentMetadata(REAL, 'phone', brands)!;
    expect(meta.brands).toEqual(brands);
    expect(meta.fullVersionList).toEqual([
      { brand: 'Not(A:Brand', version: '99.0.0.0' },
      { brand: 'Google Chrome', version: '151.0.0.0' },
    ]);
  });
});

describe('userAgentAction', () => {
  const REAL =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/151.0.0.0 Safari/537.36';

  it('sets the derived UA and its client hints together', () => {
    const action = userAgentAction('phone', REAL, null);
    expect(action.kind).toBe('set');
    if (action.kind !== 'set') return;
    expect(action.userAgent).toContain('Android');
    expect(action.metadata).not.toBe(null);
  });

  it('CLEARS rather than leaving an earlier call s UA in place', () => {
    // The one-way-latch bug: without this, `preset:'mobile'` then
    // `preset:'desktop'` left the tab reporting a desktop viewport while still
    // identifying as an Android phone, so a UA-sniffing server kept serving the
    // mobile bundle and the agent measured the wrong page.
    expect(userAgentAction(null, REAL, null)).toEqual({ kind: 'clear' });
  });

  it('clears when the real UA is not recognisably Chrome (no half-applied lie)', () => {
    expect(userAgentAction('phone', 'Mozilla/5.0 (X11; Linux) Firefox/128.0', null)).toEqual({
      kind: 'clear',
    });
  });

  it('is a complete statement for every spec the parser can produce', () => {
    for (const name of Object.keys(VIEWPORT_PRESETS)) {
      const spec = set({ preset: name });
      const action = userAgentAction(spec.userAgent, REAL, null);
      expect(['set', 'clear']).toContain(action.kind);
      expect(action.kind === 'set').toBe(spec.userAgent !== null);
    }
  });
});

describe('describeLayoutMismatch', () => {
  const reading = (width: number): ViewportReading => ({
    width,
    height: 852,
    deviceScaleFactor: 3,
    screenWidth: 393,
    screenHeight: 852,
    orientation: 'portrait-primary',
    touch: true,
    maxTouchPoints: 5,
    userAgent: 'ua',
  });

  it('says nothing when the page laid out at the emulated width', () => {
    expect(describeLayoutMismatch(set({ preset: 'mobile' }), reading(393))).toBeUndefined();
    expect(describeLayoutMismatch(set({ preset: 'mobile' }), null)).toBeUndefined();
  });

  it('does NOT explain away a missing meta viewport — that is the bug being hunted', () => {
    const note = describeLayoutMismatch(set({ preset: 'mobile' }), reading(980))!;
    expect(note).toContain('980');
    expect(note).toContain('WITHOUT one');
    expect(note).toContain('responsive bug');
    // It must not assert the page HAS a meta viewport; that was the earlier
    // wording, and it told the agent a non-mobile-ready page was fine.
    expect(note).not.toMatch(/its <meta name=viewport> defines/);
  });

  it('stays short for a non-mobile viewport, where no 980 fallback applies', () => {
    const note = describeLayoutMismatch(set({ width: 1280, height: 800 }), {
      ...reading(1265),
      height: 800,
    })!;
    expect(note).toContain('1265');
    expect(note).not.toContain('980');
    expect(note).toContain('applied as requested');
  });
});

describe('VIEWPORT_PROBE', () => {
  it('is a self-contained literal with no interpolation', () => {
    expect(VIEWPORT_PROBE).not.toContain('${');
    expect(VIEWPORT_PROBE.startsWith('(function()')).toBe(true);
    expect(VIEWPORT_PROBE.trimEnd().endsWith('})()')).toBe(true);
  });

  it('reads only viewport/device facts — never a field value', () => {
    expect(VIEWPORT_PROBE).not.toContain('.value');
    expect(VIEWPORT_PROBE).toContain('window.innerWidth');
    expect(VIEWPORT_PROBE).toContain('devicePixelRatio');
    expect(VIEWPORT_PROBE).toContain('maxTouchPoints');
  });
});
