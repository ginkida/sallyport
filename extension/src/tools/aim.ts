/** Pure aiming logic behind `mouse_click`.
 *
 * `findClickPoint` picks where to actually dispatch the mouse events: the
 * element's center first, then four points pulled toward the corners —
 * overlays (badges, ripples, avatars, absolutely-positioned siblings)
 * usually cover part of the box, not all of it, and CDP mouse events go to
 * whatever is topmost at the dispatch point. When no probe point reaches
 * the target, the click is reported as `covered` together with a
 * description of (and a handle to) the node that would eat it.
 *
 * `describePoint` is the coordinate-mode companion: viewport bounds plus
 * what currently sits at an (x, y) the agent picked by hand.
 *
 * Both are serialised via `Function.prototype.toString` into page probes
 * (`mouse.ts`), so they MUST stay self-contained — no imports, no closure
 * references. The serialised literals are FIXED — agent input reaches
 * `describePoint` only as structured `Runtime.callFunctionOn` arguments,
 * never by string interpolation — the same trust shape as `fetch_in_page`'s
 * fixed body, so no per-domain evaluate flag is required. This module is
 * `chrome.*`-free so vitest can drive it against fake DOM shapes.
 */

export type AimElementLike = {
  tagName?: string;
  id?: string;
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
  getRootNode?: () => unknown;
  contains: (other: unknown) => boolean;
  shadowRoot?: { contains: (other: unknown) => boolean } | null;
  getAttribute?: (name: string) => string | null;
  scrollIntoView?: (opts?: unknown) => void;
};

export type AimRootLike = {
  elementFromPoint?: (x: number, y: number) => AimElementLike | null;
};

export type AimDocumentLike = AimRootLike & {
  defaultView?: { innerWidth?: number; innerHeight?: number } | null;
};

export type ClickPoint = {
  tag: string;
  x: number;
  y: number;
  visible: boolean;
  covered: boolean;
  hitTarget: string | null;
  hitTag: string | null;
  /** The covering node itself (an element handle when run in-page). Never
   * serialised by value — `mouse.ts` pulls it out as an objectId to mint a
   * `@eN` ref for it. */
  hitEl: unknown;
};

export function findClickPoint(el: AimElementLike, doc: AimRootLike): ClickPoint {
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  // Hit-test from the element's own root so targets inside open shadow
  // trees resolve to the inner node, not the shadow host.
  const rootCand = el.getRootNode ? (el.getRootNode() as AimRootLike) : doc;
  const from = rootCand && typeof rootCand.elementFromPoint === 'function' ? rootCand : doc;

  // The click is "ours" only if the topmost node at the point is the target
  // or inside it (light or open-shadow descendant). An ancestor at the point
  // means the target does not paint there — the event would go to the
  // ancestor and never reach the target's listeners.
  function mine(hit: AimElementLike | null): boolean {
    return (
      !!hit &&
      (hit === (el as unknown) ||
        el.contains(hit) ||
        !!(el.shadowRoot && el.shadowRoot.contains(hit)))
    );
  }

  const offsets = [
    [0.5, 0.5],
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ];
  let pickX = r.left + r.width / 2;
  let pickY = r.top + r.height / 2;
  let covered = true;
  let centerHit: AimElementLike | null = null;
  for (let i = 0; i < offsets.length; i++) {
    const x = r.left + r.width * offsets[i][0];
    const y = r.top + r.height * offsets[i][1];
    const hit = from.elementFromPoint ? from.elementFromPoint(x, y) : null;
    if (i === 0) centerHit = hit;
    if (mine(hit)) {
      pickX = x;
      pickY = y;
      covered = false;
      break;
    }
  }

  let hitTarget: string | null = null;
  let hitTag: string | null = null;
  if (covered && centerHit) {
    const label = centerHit.getAttribute ? centerHit.getAttribute('aria-label') || '' : '';
    hitTag = centerHit.tagName || null;
    hitTarget =
      (centerHit.tagName || 'NODE') +
      (centerHit.id ? '#' + centerHit.id : '') +
      (label ? '[' + label.slice(0, 40) + ']' : '');
  }
  return {
    tag: el.tagName || '',
    x: pickX,
    y: pickY,
    visible: r.width > 0 && r.height > 0,
    covered: covered,
    hitTarget: hitTarget,
    hitTag: hitTag,
    hitEl: covered ? centerHit : null,
  };
}

export type PointInfo = {
  vw: number;
  vh: number;
  hitTarget: string | null;
};

export function describePoint(doc: AimDocumentLike, x: number, y: number): PointInfo {
  const view = doc.defaultView;
  const vw = view && typeof view.innerWidth === 'number' ? view.innerWidth : 0;
  const vh = view && typeof view.innerHeight === 'number' ? view.innerHeight : 0;
  const hit = doc.elementFromPoint ? doc.elementFromPoint(x, y) : null;
  let hitTarget: string | null = null;
  if (hit) {
    const label = hit.getAttribute ? hit.getAttribute('aria-label') || '' : '';
    hitTarget =
      (hit.tagName || 'NODE') +
      (hit.id ? '#' + hit.id : '') +
      (label ? '[' + label.slice(0, 40) + ']' : '');
  }
  return { vw: vw, vh: vh, hitTarget: hitTarget };
}
