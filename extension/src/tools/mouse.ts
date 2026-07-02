import { describePoint, findClickPoint, type ClickPoint, type PointInfo } from './aim.js';
import { attach, cdp } from './cdp.js';
import { resolveSelectorOrRef } from './dom.js';
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
  | { mode: 'coord'; x: number; y: number }
  | { mode: 'selector'; selector: string };

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
async function aimAtElement(
  tabId: number,
  objectId: string,
  tool: string,
): Promise<{ point: Omit<ClickPoint, 'hitEl'>; hitTargetRef: string | null }> {
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
        functionDeclaration:
          'function() { return { tag: this.tag, x: this.x, y: this.y, visible: this.visible, ' +
          'covered: this.covered, hitTarget: this.hitTarget, hitTag: this.hitTag }; }',
        returnByValue: true,
        objectGroup: GROUP,
      },
    );
    const point = infoRes.result.value;
    if (!point) throw new BridgeError('not_found', `${tool}: could not measure element`);

    let hitTargetRef: string | null = null;
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
    return { point, hitTargetRef };
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
      },
    };
  }

  const objectId = await resolveSelectorOrRef(tab.id!, target.selector, 'mouse_click');
  const { point, hitTargetRef } = await aimAtElement(tab.id!, objectId, 'mouse_click');
  if (!point.visible) {
    throw new BridgeError('not_visible', `mouse_click: element ${point.tag} has zero size`);
  }

  await dispatchClick(tab.id!, point.x, point.y, button, clickCount);
  const wait = waitSpec ? await runEmbeddedWait(tab.id!, waitSpec) : null;

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

  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);

  if (target.mode === 'coord') {
    const { x, y } = target;
    const info = await validateViewportPoint(tab.id!, x, y, 'hover');
    await dispatchHover(tab.id!, x, y);
    const coordWait = waitSpec ? await runEmbeddedWait(tab.id!, waitSpec) : null;
    return {
      tabId: tab.id,
      url: tab.url,
      data: {
        ok: true,
        x,
        y,
        ...(info?.hitTarget ? { hitTarget: info.hitTarget } : {}),
        ...(coordWait ? { wait: coordWait } : {}),
      },
    };
  }

  const objectId = await resolveSelectorOrRef(tab.id!, target.selector, 'hover');
  const { point, hitTargetRef } = await aimAtElement(tab.id!, objectId, 'hover');
  if (!point.visible) {
    throw new BridgeError('not_visible', `hover: element ${point.tag} has zero size`);
  }

  await dispatchHover(tab.id!, point.x, point.y);
  const wait = waitSpec ? await runEmbeddedWait(tab.id!, waitSpec) : null;

  return {
    tabId: tab.id,
    url: tab.url,
    data: {
      ok: true,
      tag: point.tag,
      x: point.x,
      y: point.y,
      ...(wait ? { wait } : {}),
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
