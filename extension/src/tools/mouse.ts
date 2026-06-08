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

/** Synthetic .click() (the existing `click` tool) doesn't trip pointer-event
 * listeners that some apps rely on (canvas, drag-and-drop, react-dnd, some
 * game UIs). `mouse_click` dispatches real `Input.dispatchMouseEvent` press
 * + release at the element's geometric center, escalating `clickCount` for
 * double/triple clicks. */
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
  // the event silently.
  const probe = await cdp<{
    result: { value?: { tag: string; x: number; y: number; visible: boolean } };
  }>(tab.id!, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function() {
      this.scrollIntoView({ block: 'center', inline: 'center' });
      const r = this.getBoundingClientRect();
      return {
        tag: this.tagName,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        visible: r.width > 0 && r.height > 0,
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
  for (let i = 1; i <= clickCount; i++) {
    await cdp(tab.id!, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: v.x,
      y: v.y,
      button,
      clickCount: i,
      buttons: bit,
    });
    await cdp(tab.id!, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: v.x,
      y: v.y,
      button,
      clickCount: i,
      buttons: 0,
    });
  }

  return {
    tabId: tab.id,
    url: tab.url,
    data: { ok: true, tag: v.tag, x: v.x, y: v.y, button, clickCount },
  };
};
