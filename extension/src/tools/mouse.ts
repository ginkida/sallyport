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

function parseCoord(raw: unknown, name: string): number {
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) {
    throw new BridgeError('bad_args', `mouse_click: ${name} must be a non-negative number`);
  }
  return v;
}

/** Selector mode: run the serialised `findClickPoint` against the resolved
 * element. The probe returns by reference (it carries the covering element),
 * so the plain fields are pulled by value in a second call and — when the
 * click is covered — the covering node is resolved to a backendNodeId and
 * minted a per-tab `@eN` ref the agent can click directly. */
async function aimAtElement(
  tabId: number,
  objectId: string,
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
    throw new BridgeError('not_found', 'mouse_click: could not measure element');
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
    if (!point) throw new BridgeError('not_found', 'mouse_click: could not measure element');

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

export const mouseClick: Tool = async (args) => {
  const selector = String(args.selector || '');
  const hasX = args.x !== undefined && args.x !== null;
  const hasY = args.y !== undefined && args.y !== null;
  if (hasX !== hasY) {
    throw new BridgeError('bad_args', 'mouse_click: x and y must be given together');
  }
  const coordMode = hasX && hasY;
  if (coordMode && selector) {
    throw new BridgeError('bad_args', 'mouse_click: pass either selector or x/y, not both');
  }
  if (!coordMode && !selector) {
    throw new BridgeError('bad_args', 'mouse_click: selector or x/y required');
  }

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

  if (coordMode) {
    // Manual aim: the agent picked a viewport point (from a screenshot or
    // the hit diagnostics). Validate it against the viewport — CDP silently
    // drops events outside it, which would read as "click did nothing".
    const x = parseCoord(args.x, 'x');
    const y = parseCoord(args.y, 'y');
    const docEval = await cdp<{ result: { objectId?: string } }>(tab.id!, 'Runtime.evaluate', {
      expression: 'document',
    });
    let info: PointInfo | null = null;
    if (docEval.result.objectId) {
      const infoRes = await cdp<{ result: { value?: PointInfo } }>(
        tab.id!,
        'Runtime.callFunctionOn',
        {
          objectId: docEval.result.objectId,
          functionDeclaration: POINT_INFO_PROBE,
          arguments: [{ value: x }, { value: y }],
          returnByValue: true,
        },
      );
      info = infoRes.result.value ?? null;
    }
    if (info && info.vw > 0 && info.vh > 0 && (x > info.vw || y > info.vh)) {
      throw new BridgeError(
        'bad_args',
        `mouse_click: point (${x}, ${y}) is outside the viewport (${info.vw}x${info.vh})`,
      );
    }
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

  const objectId = await resolveSelectorOrRef(tab.id!, selector, 'mouse_click');
  const { point, hitTargetRef } = await aimAtElement(tab.id!, objectId);
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
