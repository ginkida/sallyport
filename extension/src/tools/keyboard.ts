import { attach, cdp } from './cdp.js';
import { BridgeError } from './errors.js';
import { findActiveField } from './focus.js';
import { ensureAllowed } from './gates.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

const SPECIAL: Record<string, { key: string; code: string; vkc: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', vkc: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vkc: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', vkc: 27 },
  esc: { key: 'Escape', code: 'Escape', vkc: 27 },
  tab: { key: 'Tab', code: 'Tab', vkc: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', vkc: 8 },
  delete: { key: 'Delete', code: 'Delete', vkc: 46 },
  space: { key: ' ', code: 'Space', vkc: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vkc: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vkc: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vkc: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vkc: 39 },
  home: { key: 'Home', code: 'Home', vkc: 36 },
  end: { key: 'End', code: 'End', vkc: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vkc: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vkc: 34 },
};

const MODIFIERS: Record<string, { bit: number; key: string; code: string; vkc: number }> = {
  alt: { bit: 1, key: 'Alt', code: 'AltLeft', vkc: 18 },
  ctrl: { bit: 2, key: 'Control', code: 'ControlLeft', vkc: 17 },
  control: { bit: 2, key: 'Control', code: 'ControlLeft', vkc: 17 },
  cmd: { bit: 4, key: 'Meta', code: 'MetaLeft', vkc: 91 },
  meta: { bit: 4, key: 'Meta', code: 'MetaLeft', vkc: 91 },
  shift: { bit: 8, key: 'Shift', code: 'ShiftLeft', vkc: 16 },
};

let cachedOs: string | null = null;
async function getOs(): Promise<string> {
  if (cachedOs === null) cachedOs = (await chrome.runtime.getPlatformInfo()).os;
  return cachedOs;
}

function resolveKey(k: string): { key: string; code: string; vkc: number; text?: string } {
  const lower = k.toLowerCase();
  if (SPECIAL[lower]) return SPECIAL[lower];
  const fm = lower.match(/^f(\d{1,2})$/);
  if (fm) {
    const n = parseInt(fm[1], 10);
    if (n >= 1 && n <= 12) return { key: `F${n}`, code: `F${n}`, vkc: 111 + n };
  }
  if (k.length === 1) {
    if (/^[a-zA-Z]$/.test(k)) {
      const l = k.toLowerCase();
      const u = k.toUpperCase();
      return { key: l, code: `Key${u}`, vkc: u.charCodeAt(0), text: l };
    }
    if (/^[0-9]$/.test(k)) {
      return { key: k, code: `Digit${k}`, vkc: k.charCodeAt(0), text: k };
    }
  }
  throw new BridgeError('bad_key', `send_keys: unknown key "${k}"`);
}

/** True when a keystroke segment actually TYPES a character into the focused
 * field: a bare key that resolves to `text` (letter/digit/space/enter) with no
 * non-shift modifier — a chord like `mod+a`/`ctrl+c` is a command, not text.
 * Pure / tested.
 *
 * This drives the focus-boundary password re-probe (see dispatchKeys). Rather
 * than enumerate the keys that CAN move focus — an open-ended set: Tab has a
 * default action, Space/Enter ACTIVATE the focused control, and a site keydown
 * handler can call `.focus()` on ANY key — we re-probe before every segment that
 * would deposit a character. Whatever moved focus, the credential can't land in a
 * password field the up-front probe never saw. */
export function segmentTypesText(seg: string): boolean {
  const parts = seg
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  // A non-shift modifier makes this a command chord (mod+a, ctrl+c), not text.
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i].toLowerCase() !== 'shift') return false;
  }
  try {
    return resolveKey(parts[parts.length - 1]).text !== undefined;
  } catch {
    return false;
  }
}

async function dispatchKeys(tabId: number, keysStr: string, allowPassword: boolean): Promise<void> {
  const os = await getOs();
  const modKey = os === 'mac' ? MODIFIERS.cmd : MODIFIERS.ctrl;
  const segments = keysStr.trim().split(/\s+/);
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    // Re-assert the password gate before every character-typing segment (after
    // the first — the up-front probe covers that). Focus can move mid-sequence in
    // ways no key list captures: Tab's default action, Space/Enter ACTIVATING the
    // focused control, or a site keydown handler calling `.focus()` on any key.
    // So instead of enumerating focus-movers, we re-probe before depositing each
    // character — `<mover> secret` can never land the credential in a password
    // field the up-front probe never saw, and the throw fires force-redaction.
    if (s > 0 && segmentTypesText(seg)) {
      await ensureNotPasswordField(tabId, allowPassword, 'send_keys');
    }
    const parts = seg
      .split('+')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) continue;
    let modBits = 0;
    const mods: { bit: number; key: string; code: string; vkc: number }[] = [];
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i].toLowerCase();
      const m = p === 'mod' ? modKey : MODIFIERS[p];
      if (!m) throw new BridgeError('bad_key', `send_keys: not a modifier: "${parts[i]}"`);
      modBits |= m.bit;
      mods.push(m);
    }
    const spec = resolveKey(parts[parts.length - 1]);
    const shifted =
      (modBits & MODIFIERS.shift.bit) !== 0 && spec.key.length === 1 && /^[a-z]$/.test(spec.key)
        ? { ...spec, key: spec.key.toUpperCase(), text: spec.key.toUpperCase() }
        : spec;

    let cur = 0;
    for (const m of mods) {
      cur |= m.bit;
      await cdp(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        modifiers: cur,
        key: m.key,
        code: m.code,
        windowsVirtualKeyCode: m.vkc,
      });
    }
    const onlyShift = (modBits & ~MODIFIERS.shift.bit) === 0 && shifted.text !== undefined;
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      modifiers: modBits,
      key: shifted.key,
      code: shifted.code,
      windowsVirtualKeyCode: shifted.vkc,
      ...(onlyShift ? { text: shifted.text } : {}),
    });
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: modBits,
      key: shifted.key,
      code: shifted.code,
      windowsVirtualKeyCode: shifted.vkc,
    });
    for (let i = mods.length - 1; i >= 0; i--) {
      cur &= ~mods[i].bit;
      await cdp(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        modifiers: cur,
        key: mods[i].key,
        code: mods[i].code,
        windowsVirtualKeyCode: mods[i].vkc,
      });
    }
  }
}

// Page probe for the focused field: the pure `findActiveField` (in focus.ts,
// unit-tested) serialised and invoked with the page's `document`. It descends
// open shadow roots so a focused <input type=password> inside a custom
// element is seen (a naive document.activeElement.type reads the shadow
// *host* and the gate is bypassed). A fixed literal — no agent interpolation
// — so it carries the same trust shape as fetch_in_page's fixed body and
// does not require the per-domain evaluate flag.
const ACTIVE_FIELD_PROBE = '(' + findActiveField.toString() + ')(document)';

/** Mirror `fill`'s password-field gate for keystroke-level tools.
 *
 * `Input.insertText` and `Input.dispatchKeyEvent` go to whatever element is
 * focused. Without this probe, an agent could click a password input via
 * `click` (which has no password gate of its own — it doesn't type), focus
 * lands in the password field, and then `key_type` / `send_keys` would
 * happily type into it, bypassing `fill`'s `password_field` check.
 *
 * Coverage: the top frame, including OPEN shadow roots (the common case —
 * `attachShadow({mode:'open'})` is the default). Two residual blind spots,
 * both documented in SECURITY.md: (1) CLOSED shadow roots, whose
 * `.shadowRoot` is null to page script, so the focused node can't be
 * reached; (2) cross-origin iframes, whose inner activeElement the top
 * frame can't see. Both require an allowlisted page the user already
 * trusted. We probe rather than ship a partial frame traversal that would
 * lie about its coverage. */
async function ensureNotPasswordField(
  tabId: number,
  allowPassword: boolean,
  tool: string,
): Promise<void> {
  if (allowPassword) return;
  const probe = await cdp<{ result: { value?: { tag: string; type: string } } }>(
    tabId,
    'Runtime.evaluate',
    {
      expression: ACTIVE_FIELD_PROBE,
      returnByValue: true,
    },
  );
  const v = probe.result.value;
  if (v && v.tag === 'INPUT' && v.type === 'password') {
    throw new BridgeError(
      'password_field',
      `${tool}: focus is on <input type=password>; pass allowPassword=true to override`,
    );
  }
}

export const keyType: Tool = async (args) => {
  const text = String(args.text ?? '');
  if (!text) throw new BridgeError('bad_args', 'key_type: text required');
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  await ensureNotPasswordField(tab.id!, args.allowPassword === true, 'key_type');
  await cdp(tab.id!, 'Input.insertText', { text });
  return { tabId: tab.id, url: tab.url, data: { ok: true, length: text.length } };
};

export const sendKeys: Tool = async (args) => {
  const keys = String(args.keys || '');
  if (!keys.trim()) throw new BridgeError('bad_args', 'send_keys: keys required');
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  const allowPassword = args.allowPassword === true;
  await ensureNotPasswordField(tab.id!, allowPassword, 'send_keys');
  await dispatchKeys(tab.id!, keys, allowPassword);
  return { tabId: tab.id, url: tab.url, data: { ok: true } };
};
