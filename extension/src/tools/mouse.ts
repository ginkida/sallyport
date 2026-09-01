import {
  describePoint,
  findClickPoint,
  pointOutsideViewport,
  type ClickPoint,
  type PointInfo,
} from './aim.js';
import { attach, cdp } from './cdp.js';
import { parseObserve, runObserve } from './observe.js';
import { resolveSelectorOrRef } from './resolve.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { parseWaitFor, runEmbeddedWait } from './poll.js';
import { newRef } from './refs.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

/** CDP wants both `button` (string) and `buttons` (bitmask of pressed buttons
 * during the event). Left=1, right=2, middle=4. */
const BUTTON_BITS: Record<string, number> = {
  left: 1,
  middle: 4,
  right: 2,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Synthetic .click() (the existing `click` tool) doesn't trip pointer-event
 * listeners that some apps rely on (canvas, drag-and-drop, react-dnd, some
 * game UIs). `mouse_click` dispatches the full real-input sequence —
 * `mouseMoved` (hover) → press → release via `Input.dispatchMouseEvent`,
 * with human-ish delays between events, escalating `clickCount` for
 * double/triple clicks. SPAs that gate navigation on a complete pointer
 * sequence (pointerdown → pointerup with a plausible gap, hover state set
 * beforehand) reject a bare instantaneous press+release; the timings below
 * are what makes them accept the click. */
const HOVER_SETTLE_MS = 30;
const PRESS_HOLD_MS = 60;
const BETWEEN_CLICKS_MS = 80;

// The aiming probes from aim.ts (pure, unit-tested), serialised. FIXED
// literals — agent input reaches `describePoint` only as structured
// callFunctionOn arguments, never by interpolation — so they carry the same
// trust shape as fetch_in_page's fixed body and need no evaluate flag.
const CLICK_POINT_PROBE =
  'function() { return (' + findClickPoint.toString() + ')(this, document); }';
const POINT_INFO_PROBE =
  'function(x, y) { return (' + describePoint.toString() + ')(this, x, y); }';

async function dispatchClick(
  tabId: number,
  x: number,
  y: number,
  button: string,
  clickCount: number,
): Promise<void> {
  const bit = BUTTON_BITS[button];
  // Hover first: pointermove/mouseover set the hover state many UIs require
  // before they honour a click on the same coordinates.
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
    buttons: 0,
    pointerType: 'mouse',
  });
  await sleep(HOVER_SETTLE_MS);
  for (let i = 1; i <= clickCount; i++) {
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      clickCount: i,
      buttons: bit,
      pointerType: 'mouse',
    });
    await sleep(PRESS_HOLD_MS);
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      clickCount: i,
      buttons: 0,
      pointerType: 'mouse',
    });
    if (i < clickCount) await sleep(BETWEEN_CLICKS_MS);
  }
}

/** The hover preamble alone: a single `mouseMoved` with no button pressed —
 * exactly the first step dispatchClick sends to set the :hover state before a
 * press, exposed standalone for the `hover` tool. Strictly weaker than a click
 * (no press/release, so nothing is activated). The state is transient: a CDP
 * synthetic mouseMoved drives :hover only until the next mouse move. */
async function dispatchHover(tabId: number, x: number, y: number): Promise<void> {
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
    buttons: 0,
    pointerType: 'mouse',
  });
}

function parseCoord(raw: unknown, name: string, tool: string): number {
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) {
    throw new BridgeError('bad_args', `${tool}: ${name} must be a non-negative number`);
  }
  return v;
}

export type PointerTarget =
  { mode: 'coord'; x: number; y: number } | { mode: 'selector'; selector: string };

/** Disambiguate a pointer tool's target: exactly one of a selector/@eN OR an
 * explicit viewport x+y (both coords required, non-negative, finite). Shared by
 * `mouse_click` and `hover`; `tool` names the caller in the error messages. The
 * viewport-bounds check needs CDP and lives in validateViewportPoint — this
 * stays pure so the selector-vs-coord rules and coord validation are
 * unit-testable. */
export function parsePointerTarget(args: Record<string, unknown>, tool: string): PointerTarget {
  const selector = String(args.selector || '');
  const hasX = args.x !== undefined && args.x !== null;
  const hasY = args.y !== undefined && args.y !== null;
  if (hasX !== hasY) {
    throw new BridgeError('bad_args', `${tool}: x and y must be given together`);
  }
  const coordMode = hasX && hasY;
  if (coordMode && selector) {
    throw new BridgeError('bad_args', `${tool}: pass either selector or x/y, not both`);
  }
  if (!coordMode && !selector) {
    throw new BridgeError('bad_args', `${tool}: selector or x/y required`);
  }
  if (coordMode) {
    return { mode: 'coord', x: parseCoord(args.x, 'x', tool), y: parseCoord(args.y, 'y', tool) };
  }
  return { mode: 'selector', selector };
}

/** Selector mode: run the serialised `findClickPoint` against the resolved
 * element. The probe returns by reference (it carries the covering element),
 * so the plain fields are pulled by value in a second call and — when the
 * click is covered — the covering node is resolved to a backendNodeId and
 * minted a per-tab `@eN` ref the agent can click directly. */
/** Copy the aim probe's result out of the page BY VALUE.
 *
 * `findClickPoint` returns the covering element itself in `hitEl`, so the
 * result has to stay a remote object; this second call lifts the plain fields.
 * That makes it a hand-written mirror of `ClickPoint` — and a mirror silently
 * drifts. It did: `vw`/`vh` were added to the probe for the off-viewport
 * refusal but not here, so they arrived `undefined`, the refusal took its
 * fail-open branch on every call, and the feature was inert while the whole
 * suite stayed green. The cast to `Omit<ClickPoint,'hitEl'>` is an assertion,
 * not a check, so TypeScript could not see it either.
 *
 * `CLICK_POINT_KEYS` is the single list both this projection and its test are
 * built from, so the next field added to `ClickPoint` fails a test instead of
 * quietly never arriving. */
export const CLICK_POINT_KEYS = [
  'tag',
  'x',
  'y',
  'vw',
  'vh',
  'visible',
  'covered',
  'hitTarget',
  'hitTag',
] as const;

export const CLICK_POINT_BY_VALUE =
  'function() { return { ' + CLICK_POINT_KEYS.map((k) => `${k}: this.${k}`).join(', ') + ' }; }';

async function aimAtElement(
  tabId: number,
  objectId: string,
  tool: string,
): Promise<{
  point: Omit<ClickPoint, 'hitEl'>;
  hitTargetRef: string | null;
  hitBackendNodeId: number | null;
}> {
  const GROUP = 'sallyport_mouse';
  const probe = await cdp<{
    result: { objectId?: string };
    exceptionDetails?: { text: string };
  }>(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: CLICK_POINT_PROBE,
    objectGroup: GROUP,
  });
  if (probe.exceptionDetails || !probe.result.objectId) {
    throw new BridgeError('not_found', `${tool}: could not measure element`);
  }
  try {
    const infoRes = await cdp<{ result: { value?: Omit<ClickPoint, 'hitEl'> } }>(
      tabId,
      'Runtime.callFunctionOn',
      {
        objectId: probe.result.objectId,
        functionDeclaration: CLICK_POINT_BY_VALUE,
        returnByValue: true,
        objectGroup: GROUP,
      },
    );
    const point = infoRes.result.value;
    if (!point) throw new BridgeError('not_found', `${tool}: could not measure element`);

    let hitTargetRef: string | null = null;
    let hitBackendNodeId: number | null = null;
    if (point.covered) {
      const hitRes = await cdp<{ result: { objectId?: string } }>(tabId, 'Runtime.callFunctionOn', {
        objectId: probe.result.objectId,
        functionDeclaration: 'function() { return this.hitEl; }',
        objectGroup: GROUP,
      });
      if (hitRes.result.objectId) {
        try {
          const d = await cdp<{ node: { backendNodeId?: number } }>(tabId, 'DOM.describeNode', {
            objectId: hitRes.result.objectId,
          });
          if (d.node.backendNodeId !== undefined) {
            hitBackendNodeId = d.node.backendNodeId;
            hitTargetRef =
              '@' +
              newRef(
                tabId,
                d.node.backendNodeId,
                (point.hitTag || 'node').toLowerCase(),
                point.hitTarget ?? '',
              );
          }
        } catch {
          // Covering node died between probe and describe — keep the
          // textual hitTarget, just without a ref.
        }
      }
    }
    return { point, hitTargetRef, hitBackendNodeId };
  } finally {
    try {
      await cdp(tabId, 'Runtime.releaseObjectGroup', { objectGroup: GROUP });
    } catch {
      // best-effort cleanup
    }
  }
}

/** Coordinate-mode guard shared by mouse_click and hover: measure the viewport
 * via the fixed POINT_INFO_PROBE and reject a point outside it (CDP silently
 * drops events beyond the viewport, which would read as "nothing happened").
 * Returns the PointInfo (carrying what currently sits at the point) so the
 * caller can echo a hitTarget diagnostic. */
async function validateViewportPoint(
  tabId: number,
  x: number,
  y: number,
  tool: string,
): Promise<PointInfo | null> {
  const docEval = await cdp<{ result: { objectId?: string } }>(tabId, 'Runtime.evaluate', {
    expression: 'document',
  });
  let info: PointInfo | null = null;
  if (docEval.result.objectId) {
    const infoRes = await cdp<{ result: { value?: PointInfo } }>(tabId, 'Runtime.callFunctionOn', {
      objectId: docEval.result.objectId,
      functionDeclaration: POINT_INFO_PROBE,
      arguments: [{ value: x }, { value: y }],
      returnByValue: true,
    });
    info = infoRes.result.value ?? null;
  }
  if (info && info.vw > 0 && info.vh > 0 && (x > info.vw || y > info.vh)) {
    throw new BridgeError(
      'bad_args',
      `${tool}: point (${x}, ${y}) is outside the viewport (${info.vw}x${info.vh})`,
    );
  }
  return info;
}

/** Re-mint the covering node's ref into the ref space an observation just
 * created.
 *
 * `observe` runs `buildSnapshotTree`, which resets the tab's refs — so a
 * `hitTargetRef` minted while aiming is dead by the time the result carrying it
 * reaches the agent, and refs are monotonic, so it does not even alias: it just
 * fails. Shipping a ref in the same payload that invalidated it is the kind of
 * small lie that costs a round-trip to discover. Minting again after the
 * observation puts it in the generation the result actually ships. */
function remintHitTarget(
  tabId: number,
  hitBackendNodeId: number | null,
  point: { hitTag?: string | null; hitTarget?: string | null },
): string | null {
  if (hitBackendNodeId === null) return null;
  return (
    '@' +
    newRef(tabId, hitBackendNodeId, (point.hitTag || 'node').toLowerCase(), point.hitTarget ?? '')
  );
}

/** What to say when the aimed point lands outside the viewport.
 *
 * The old text told the agent to "scroll it into view (scroll/reveal) and
 * retry" — advice the tool had ALREADY taken: `findClickPoint` scrolls the
 * element into view (instantly, so the rect it measures is the post-scroll one)
 * before measuring anything. So the one situation this fires in is the one
 * where scrolling did not help, and the suggested remedy was a loop: scroll,
 * retry, get the same refusal, scroll again.
 *
 * What is actually true when a scrolled-to element still measures outside: it
 * is positioned or transformed off-canvas, it lives in a region clipped by
 * `overflow:hidden` (a closed drawer, an off-screen menu panel), or it is in a
 * virtualised list whose own container has to be paged. Those want a different
 * action — open whatever reveals it, or `reveal` the container — never another
 * `scroll`. */
function offViewportMessage(
  tool: string,
  p: { tag: string; x: number; y: number; vw: number; vh: number },
): string {
  return (
    `${tool}: ${p.tag} was scrolled into view and still measures at (${Math.round(p.x)}, ` +
    `${Math.round(p.y)}) of ${p.vw}x${p.vh}, outside the viewport — the browser would discard ` +
    `the event. Scrolling again will not change this: the element is likely positioned or ` +
    `transformed off-canvas, or inside a region clipped by overflow:hidden (a closed drawer or ` +
    `menu panel). Open whatever reveals it, use reveal for a virtualised container, or pick a ` +
    `different element.`
  );
}

export const mouseClick: Tool = async (args) => {
  const target = parsePointerTarget(args, 'mouse_click');

  const button = String(args.button ?? 'left').toLowerCase();
  if (!(button in BUTTON_BITS)) {
    throw new BridgeError(
      'bad_args',
      `mouse_click: button must be left|middle|right, got: ${button}`,
    );
  }

  const rawCount = args.clickCount;
  const clickCount = rawCount === undefined ? 1 : Number(rawCount);
  if (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3) {
    throw new BridgeError('bad_args', 'mouse_click: clickCount must be an integer between 1 and 3');
  }
  const waitSpec = parseWaitFor(args.waitFor, 'mouse_click');
  const observeSpec = parseObserve(args.observe, 'mouse_click');

  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);

  if (target.mode === 'coord') {
    // Manual aim: the agent picked a viewport point (from a screenshot or the
    // hit diagnostics). validateViewportPoint rejects an off-screen point — CDP
    // silently drops events outside the viewport ("click did nothing").
    const { x, y } = target;
    const info = await validateViewportPoint(tab.id!, x, y, 'mouse_click');
    await dispatchClick(tab.id!, x, y, button, clickCount);
    const coordWait = waitSpec ? await runEmbeddedWait(tab.id!, waitSpec) : null;
    const coordObserved = observeSpec ? await runObserve(tab.id!, observeSpec) : null;
    return {
      tabId: tab.id,
      url: tab.url,
      data: {
        ok: true,
        x,
        y,
        button,
        clickCount,
        ...(info?.hitTarget ? { hitTarget: info.hitTarget } : {}),
        ...(coordWait ? { wait: coordWait } : {}),
        ...(coordObserved ? { observed: coordObserved } : {}),
      },
    };
  }

  const objectId = await resolveSelectorOrRef(tab.id!, target.selector, 'mouse_click');
  const {
    point,
    hitTargetRef: aimedRef,
    hitBackendNodeId,
  } = await aimAtElement(tab.id!, objectId, 'mouse_click');
  if (!point.visible) {
    throw new BridgeError('not_visible', `mouse_click: element ${point.tag} has zero size`);
  }
  if (pointOutsideViewport(point)) {
    throw new BridgeError('not_visible', offViewportMessage('mouse_click', point));
  }

  await dispatchClick(tab.id!, point.x, point.y, button, clickCount);
  const wait = waitSpec ? await runEmbeddedWait(tab.id!, waitSpec) : null;
  const observed = observeSpec ? await runObserve(tab.id!, observeSpec) : null;
  // AFTER the observation: it reset the ref space, so a ref minted while aiming
  // would be dead in the very payload that carries it.
  const hitTargetRef = observed ? remintHitTarget(tab.id!, hitBackendNodeId, point) : aimedRef;

  return {
    tabId: tab.id,
    url: tab.url,
    data: {
      ok: true,
      tag: point.tag,
      x: point.x,
      y: point.y,
      button,
      clickCount,
      ...(wait ? { wait } : {}),
      ...(observed ? { observed } : {}),
      // Diagnostic, not a gate: the click is dispatched either way (the
      // covering node may be a legitimate event-handling layer), but the
      // agent learns where the events actually landed — and gets a ref to
      // click the covering node directly.
      ...(point.covered
        ? {
            covered: true,
            hitTarget: point.hitTarget,
            ...(hitTargetRef ? { hitTargetRef } : {}),
          }
        : {}),
    },
  };
};

/** Hover over an element/point without clicking — the standalone hover preamble
 * (`Input.dispatchMouseEvent{mouseMoved}`). Unblocks CSS `:hover`-only menus,
 * tooltips and "show actions on row hover" UIs that a click would dismiss or
 * mis-activate. Target is a selector/@eN (auto-aimed via the same probes as
 * mouse_click, reporting `covered`/`hitTargetRef` when an overlay sits on top)
 * or explicit viewport x/y. Strictly weaker than mouse_click: no press/release,
 * nothing is activated. Pair with embedded `waitFor` to hover→wait-for-menu in
 * one call. The :hover state is transient — a synthetic mouseMoved holds it only
 * until the next mouse move. */
export const hover: Tool = async (args) => {
  const target = parsePointerTarget(args, 'hover');
  const waitSpec = parseWaitFor(args.waitFor, 'hover');
  const observeSpec = parseObserve(args.observe, 'hover');

  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);

  if (target.mode === 'coord') {
    const { x, y } = target;
    const info = await validateViewportPoint(tab.id!, x, y, 'hover');
    await dispatchHover(tab.id!, x, y);
    const coordWait = waitSpec ? await runEmbeddedWait(tab.id!, waitSpec) : null;
    const coordObserved = observeSpec ? await runObserve(tab.id!, observeSpec) : null;
    return {
      tabId: tab.id,
      url: tab.url,
      data: {
        ok: true,
        x,
        y,
        ...(info?.hitTarget ? { hitTarget: info.hitTarget } : {}),
        ...(coordWait ? { wait: coordWait } : {}),
        ...(coordObserved ? { observed: coordObserved } : {}),
      },
    };
  }

  const objectId = await resolveSelectorOrRef(tab.id!, target.selector, 'hover');
  const {
    point,
    hitTargetRef: aimedRef,
    hitBackendNodeId,
  } = await aimAtElement(tab.id!, objectId, 'hover');
  if (!point.visible) {
    throw new BridgeError('not_visible', `hover: element ${point.tag} has zero size`);
  }
  if (pointOutsideViewport(point)) {
    throw new BridgeError('not_visible', offViewportMessage('hover', point));
  }

  await dispatchHover(tab.id!, point.x, point.y);
  const wait = waitSpec ? await runEmbeddedWait(tab.id!, waitSpec) : null;
  const observed = observeSpec ? await runObserve(tab.id!, observeSpec) : null;
  // See mouse_click: re-mint after the observation reset the ref space.
  const hitTargetRef = observed ? remintHitTarget(tab.id!, hitBackendNodeId, point) : aimedRef;

  return {
    tabId: tab.id,
    url: tab.url,
    data: {
      ok: true,
      tag: point.tag,
      x: point.x,
      y: point.y,
      ...(wait ? { wait } : {}),
      ...(observed ? { observed } : {}),
      ...(point.covered
        ? {
            covered: true,
            hitTarget: point.hitTarget,
            ...(hitTargetRef ? { hitTargetRef } : {}),
          }
        : {}),
    },
  };
};
