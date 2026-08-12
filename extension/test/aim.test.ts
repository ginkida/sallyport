import { describe, expect, it } from 'vitest';

import {
  describePoint,
  findClickPoint,
  pointOutsideViewport,
  type AimDocumentLike,
  type AimElementLike,
  type AimRootLike,
} from '../src/tools/aim.js';

type Rect = { left: number; top: number; width: number; height: number };

/** A target element whose subtree membership is decided by an explicit set. */
function fakeEl(
  rect: Rect,
  opts: {
    tag?: string;
    id?: string;
    descendants?: unknown[];
    shadowDescendants?: unknown[];
    getRootNode?: () => unknown;
  } = {},
): AimElementLike {
  const descendants = new Set(opts.descendants ?? []);
  const shadow = opts.shadowDescendants ? new Set(opts.shadowDescendants) : null;
  return {
    tagName: opts.tag ?? 'A',
    id: opts.id,
    getBoundingClientRect: () => rect,
    contains: (other: unknown) => descendants.has(other),
    shadowRoot: shadow ? { contains: (other: unknown) => shadow.has(other) } : null,
    getAttribute: () => null,
    ...(opts.getRootNode ? { getRootNode: opts.getRootNode } : {}),
  };
}

function overlay(tag = 'DIV', id = '', label = ''): AimElementLike {
  return {
    tagName: tag,
    id,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    contains: () => false,
    getAttribute: (name: string) => (name === 'aria-label' && label ? label : null),
  };
}

/** Document whose elementFromPoint answers from a lookup function. */
function docWith(hit: (x: number, y: number) => AimElementLike | null): AimRootLike {
  return { elementFromPoint: hit };
}

const RECT: Rect = { left: 100, top: 50, width: 200, height: 100 };
// Probe points for RECT: center (200,100), then (150,75) (250,75) (150,125) (250,125).

describe('findClickPoint', () => {
  it('clicks the center when the element is its own hit target', () => {
    const el = fakeEl(RECT);
    const p = findClickPoint(
      el,
      docWith(() => el),
    );
    expect(p).toMatchObject({ x: 200, y: 100, covered: false, visible: true, hitTarget: null });
  });

  it('treats a light-DOM descendant at the point as a hit', () => {
    const inner = overlay('SPAN');
    const el = fakeEl(RECT, { descendants: [inner] });
    const p = findClickPoint(
      el,
      docWith(() => inner),
    );
    expect(p.covered).toBe(false);
  });

  it('treats an open-shadow descendant at the point as a hit', () => {
    const inner = overlay('SPAN');
    const el = fakeEl(RECT, { shadowDescendants: [inner] });
    const p = findClickPoint(
      el,
      docWith(() => inner),
    );
    expect(p.covered).toBe(false);
  });

  it('sidesteps an overlay that only covers the center', () => {
    const el = fakeEl(RECT);
    const badge = overlay();
    // Center is eaten by the badge; the first quadrant point reaches the el.
    const p = findClickPoint(
      el,
      docWith((x, y) => (x === 200 && y === 100 ? badge : el)),
    );
    expect(p.covered).toBe(false);
    expect([p.x, p.y]).toEqual([150, 75]);
  });

  it('reports a full cover with a descriptor of the center hit', () => {
    const el = fakeEl(RECT);
    const cover = overlay('DIV', 'modal', 'Close dialog');
    const p = findClickPoint(
      el,
      docWith(() => cover),
    );
    expect(p.covered).toBe(true);
    expect(p.x).toBe(200); // falls back to the center
    expect(p.y).toBe(100);
    expect(p.hitTarget).toBe('DIV#modal[Close dialog]');
    expect(p.hitTag).toBe('DIV');
    expect(p.hitEl).toBe(cover);
  });

  it('an ancestor at the point counts as covered (target does not paint there)', () => {
    const el = fakeEl(RECT);
    const ancestor = overlay('LI');
    const p = findClickPoint(
      el,
      docWith(() => ancestor),
    );
    expect(p.covered).toBe(true);
    expect(p.hitTarget).toBe('LI');
  });

  it('hit-tests from the element root when getRootNode provides one', () => {
    const el: AimElementLike = fakeEl(RECT, {
      getRootNode: () => ({ elementFromPoint: () => el }) satisfies AimRootLike,
    });
    // The document-level hit-test would claim "covered"; the root wins.
    const p = findClickPoint(
      el,
      docWith(() => overlay()),
    );
    expect(p.covered).toBe(false);
  });

  it('flags zero-size elements as not visible', () => {
    const el = fakeEl({ left: 10, top: 10, width: 0, height: 0 });
    const p = findClickPoint(
      el,
      docWith(() => null),
    );
    expect(p.visible).toBe(false);
  });

  it('survives a missing elementFromPoint (covered, no hit info)', () => {
    const el = fakeEl(RECT);
    const p = findClickPoint(el, {});
    expect(p.covered).toBe(true);
    expect(p.hitTarget).toBeNull();
    expect(p.hitEl).toBeNull();
  });

  it('serialises to a self-contained literal (no imports/closures)', () => {
    const src = findClickPoint.toString();
    expect(src).not.toMatch(/\brequire\b|\bimport\b/);

    const revived = (0, eval)('(' + src + ')') as typeof findClickPoint;
    const el = fakeEl(RECT);
    expect(
      revived(
        el,
        docWith(() => el),
      ).covered,
    ).toBe(false);
  });
});

describe('describePoint', () => {
  const doc = (hit: AimElementLike | null, vw = 1280, vh = 800): AimDocumentLike => ({
    elementFromPoint: () => hit,
    defaultView: { innerWidth: vw, innerHeight: vh },
  });

  it('returns viewport bounds and a descriptor of the node at the point', () => {
    const info = describePoint(doc(overlay('BUTTON', 'send', 'Send message')), 10, 20);
    expect(info).toEqual({ vw: 1280, vh: 800, hitTarget: 'BUTTON#send[Send message]' });
  });

  it('handles nothing at the point and a missing view', () => {
    const info = describePoint({ elementFromPoint: () => null }, 5, 5);
    expect(info).toEqual({ vw: 0, vh: 0, hitTarget: null });
  });

  it('serialises to a self-contained literal', () => {
    const src = describePoint.toString();

    const revived = (0, eval)('(' + src + ')') as typeof describePoint;
    expect(revived(doc(null), 1, 1).vw).toBe(1280);
  });
});

/**
 * `visible` is width>0 && height>0 — SIZE, not position. An element scrolled
 * out of view or translated off-canvas passes it while CDP silently discards
 * the dispatched event, so `mouse_click` used to report ok:true for a click
 * that never happened. Coordinate mode has been guarded all along; selector
 * mode was not.
 */
describe('pointOutsideViewport', () => {
  const vp = { vw: 1000, vh: 800 };

  it('accepts a point inside', () => {
    expect(pointOutsideViewport({ x: 500, y: 400, ...vp })).toBe(false);
    expect(pointOutsideViewport({ x: 0, y: 0, ...vp })).toBe(false);
    expect(pointOutsideViewport({ x: 999, y: 799, ...vp })).toBe(false);
  });

  it('rejects a point past any edge', () => {
    expect(pointOutsideViewport({ x: 1000, y: 400, ...vp })).toBe(true);
    expect(pointOutsideViewport({ x: 500, y: 800, ...vp })).toBe(true);
    expect(pointOutsideViewport({ x: -1, y: 400, ...vp })).toBe(true);
    expect(pointOutsideViewport({ x: 500, y: -1, ...vp })).toBe(true);
    // The common real case: the element is below the fold.
    expect(pointOutsideViewport({ x: 500, y: 4200, ...vp })).toBe(true);
  });

  it('fails OPEN when the viewport could not be measured', () => {
    // Refusing on a reading we do not have would block legitimate clicks;
    // dispatching is what happened before the check existed.
    expect(pointOutsideViewport({ x: 5000, y: 5000, vw: 0, vh: 0 })).toBe(false);
    expect(pointOutsideViewport({ x: 5000, y: 5000, vw: 1000, vh: 0 })).toBe(false);
  });
});

describe('findClickPoint reports the viewport it measured', () => {
  it('carries vw/vh out so the refusal decision can live in TypeScript', () => {
    const el = {
      tagName: 'BUTTON',
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 40 }),
      contains: () => true,
      scrollIntoView: () => {},
    };
    const doc = {
      elementFromPoint: () => el,
      defaultView: { innerWidth: 1280, innerHeight: 720 },
    };
    const point = findClickPoint(el as never, doc as never);
    expect(point.vw).toBe(1280);
    expect(point.vh).toBe(720);
    expect(pointOutsideViewport(point)).toBe(false);
  });

  it('reports zeros when there is no view to read, so the check fails open', () => {
    const el = {
      tagName: 'BUTTON',
      getBoundingClientRect: () => ({ left: 0, top: 9000, width: 10, height: 10 }),
      contains: () => true,
      scrollIntoView: () => {},
    };
    const point = findClickPoint(el as never, { elementFromPoint: () => el } as never);
    expect(point.vw).toBe(0);
    expect(pointOutsideViewport(point)).toBe(false);
  });
});
