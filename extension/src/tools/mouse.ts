import { attach, cdp } from './cdp.js';
import { resolveSelectorOrRef } from './dom.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
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
 * `mouseMoved` (hover) → press → release via `Input.dispatchMouseEvent` at
 * the element's geometric center, with human-ish delays between events,
 * escalating `clickCount` for double/triple clicks. SPAs that gate
 * navigation on a complete pointer sequence (pointerdown → pointerup with
 * a plausible gap, hover state set beforehand) reject a bare instantaneous
 * press+release; the timings below are what makes them accept the click. */
const HOVER_SETTLE_MS = 30;
const PRESS_HOLD_MS = 60;
const BETWEEN_CLICKS_MS = 80;
export const mouseClick: Tool = async (args) => {
  const selector = String(args.selector || '');
  if (!selector) throw new BridgeError('bad_args', 'mouse_click: selector required');

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

  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  const objectId = await resolveSelectorOrRef(tab.id!, selector, 'mouse_click');

  // Scroll into view first so the bounding rect is in the visible viewport;
  // otherwise center coords can land outside (0,0)–(viewport) and CDP drops
  // the event silently. The hit-test reports which element actually sits at
  // the click point: real mouse events go to the topmost element there, so
  // when an overlay/wrapper covers the target's center, the click lands on
  // that node instead — `covered` + `hitTarget` in the result make this
  // visible to the agent instead of looking like a click that did nothing.
  // The probe is a fixed literal (no agent input interpolated).
  const probe = await cdp<{
    result: {
      value?: {
        tag: string;
        x: number;
        y: number;
        visible: boolean;
        covered: boolean;
        hitTarget: string | null;
      };
    };
  }>(tab.id!, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function() {
      this.scrollIntoView({ block: 'center', inline: 'center' });
      const r = this.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      // Hit-test from the element's own root so targets inside open shadow
      // trees resolve to the inner node, not the shadow host.
      const root = this.getRootNode ? this.getRootNode() : document;
      const from = root && root.elementFromPoint ? root : document;
      const hit = from.elementFromPoint(x, y);
      // The click is "ours" only if the topmost node at the point is the
      // target or inside it (light or open-shadow descendant). An ancestor
      // at the point means the target does not paint there — the event
      // would go to the ancestor and never reach the target's listeners.
      const related =
        !!hit &&
        (hit === this ||
          this.contains(hit) ||
          (this.shadowRoot && this.shadowRoot.contains(hit)));
      let hitTarget = null;
      if (hit && !related) {
        const label = hit.getAttribute ? hit.getAttribute('aria-label') || '' : '';
        hitTarget =
          hit.tagName +
          (hit.id ? '#' + hit.id : '') +
          (label ? '[' + label.slice(0, 40) + ']' : '');
      }
      return {
        tag: this.tagName,
        x: x,
        y: y,
        visible: r.width > 0 && r.height > 0,
        covered: !!hit && !related,
        hitTarget: hitTarget,
      };
    }`,
    returnByValue: true,
  });
  const v = probe.result.value;
  if (!v) throw new BridgeError('not_found', 'mouse_click: could not measure element');
  if (!v.visible) {
    throw new BridgeError('not_visible', `mouse_click: element ${v.tag} has zero size`);
  }

  const bit = BUTTON_BITS[button];
  // Hover first: pointermove/mouseover set the hover state many UIs require
  // before they honour a click on the same coordinates.
  await cdp(tab.id!, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: v.x,
    y: v.y,
    button: 'none',
    buttons: 0,
    pointerType: 'mouse',
  });
  await sleep(HOVER_SETTLE_MS);
  for (let i = 1; i <= clickCount; i++) {
    await cdp(tab.id!, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: v.x,
      y: v.y,
      button,
      clickCount: i,
      buttons: bit,
      pointerType: 'mouse',
    });
    await sleep(PRESS_HOLD_MS);
    await cdp(tab.id!, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: v.x,
      y: v.y,
      button,
      clickCount: i,
      buttons: 0,
      pointerType: 'mouse',
    });
    if (i < clickCount) await sleep(BETWEEN_CLICKS_MS);
  }

  return {
    tabId: tab.id,
    url: tab.url,
    data: {
      ok: true,
      tag: v.tag,
      x: v.x,
      y: v.y,
      button,
      clickCount,
      // Diagnostic, not a gate: the click is dispatched either way (the
      // covering node may be a legitimate event-handling layer), but the
      // agent learns where the events actually landed.
      ...(v.covered ? { covered: true, hitTarget: v.hitTarget } : {}),
    },
  };
};
