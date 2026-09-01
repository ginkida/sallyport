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

// ---------------------------------------------------------------------------
// The off-viewport refusal (chrome-mocked)
// ---------------------------------------------------------------------------

const TAB = 7;

type Cmd = { method: string; fn?: string };

/** A CDP channel for the aim path. `point` is what the aim probe reports back
 * — remembering that the probe has ALREADY scrolled the element into view
 * before measuring (aim.ts:findClickPoint), which is exactly what makes the
 * refusal below meaningful. */
function installChrome(point: Record<string, unknown>): Cmd[] {
  const sent: Cmd[] = [];
  const store = new Map<string, unknown>();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        async get(keys: string | string[]) {
          const out: Record<string, unknown> = {};
          for (const k of Array.isArray(keys) ? keys : [keys])
            if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        async set(obj: Record<string, unknown>) {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
        async remove() {},
      },
      session: {
        async get() {
          return {};
        },
        async set() {},
      },
    },
    tabs: {
      async get() {
        return { id: TAB, url: 'https://shop.example/list', title: 'list' };
      },
      onRemoved: { addListener() {} },
    },
    debugger: {
      async attach() {},
      async sendCommand(_t: unknown, method: string, params?: Record<string, unknown>) {
        const fn = String(params?.functionDeclaration ?? '');
        sent.push({ method, fn: fn.slice(0, 60) });
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelector') return { nodeId: 2 };
        if (method === 'DOM.resolveNode') return { object: { objectId: 'el' } };
        if (method === 'Runtime.callFunctionOn') {
          // The BY_VALUE projection is the only call that returns the measured
          // point; the aim probe itself hands back a handle.
          if (fn.includes('x: this.x')) return { result: { value: point } };
          return { result: { objectId: 'point' } };
        }
        return {};
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
  return sent;
}

const offCanvas = {
  x: 200,
  y: 1400,
  vw: 1280,
  vh: 800,
  visible: true,
  tag: 'button',
  covered: false,
};
const inView = { x: 200, y: 400, vw: 1280, vh: 800, visible: true, tag: 'button', covered: false };

async function load() {
  const { mouseClick, hover } = await import('../src/tools/mouse.js');
  const { setAllowlist } = await import('../src/storage.js');
  const { resetAttachedTabs } = await import('../src/tools/cdp.js');
  resetAttachedTabs();
  await setAllowlist([{ pattern: 'shop.example', allowEvaluate: false, addedAt: 0 }]);
  return { mouseClick, hover };
}

describe('an element that is off-viewport AFTER the aim probe scrolled to it', () => {
  it('refuses without dispatching, and does not tell the agent to scroll again', async () => {
    // findClickPoint scrolls the element into view before measuring, so this
    // refusal only fires where scrolling did NOT help — and the old message
    // ("scroll it into view and retry") sent the agent round a loop that could
    // not terminate.
    const sent = installChrome(offCanvas);
    const { mouseClick } = await load();

    await expect(mouseClick({ tabId: TAB, selector: '#buy' }, undefined)).rejects.toMatchObject({
      code: 'not_visible',
    });
    await expect(mouseClick({ tabId: TAB, selector: '#buy' }, undefined)).rejects.toThrow(
      /Scrolling again will not change this/,
    );
    // No event is dispatched — the browser would have discarded it anyway.
    expect(sent.some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(false);
  });

  it('names what would actually help', async () => {
    installChrome(offCanvas);
    const { mouseClick } = await load();
    await expect(mouseClick({ tabId: TAB, selector: '#buy' }, undefined)).rejects.toThrow(
      /overflow:hidden|reveal/,
    );
  });

  it('clicks normally when the aim lands inside the viewport', async () => {
    const sent = installChrome(inView);
    const { mouseClick } = await load();
    const out = (await mouseClick({ tabId: TAB, selector: '#buy' }, undefined)) as {
      data: { ok: boolean; y: number };
    };
    expect(out.data).toMatchObject({ ok: true, y: 400 });
    expect(sent.some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(true);
  });

  it('hover refuses on the same terms', async () => {
    installChrome(offCanvas);
    const { hover } = await load();
    await expect(hover({ tabId: TAB, selector: '#menu' }, undefined)).rejects.toThrow(
      /hover: button was scrolled into view and still measures/,
    );
  });
});
