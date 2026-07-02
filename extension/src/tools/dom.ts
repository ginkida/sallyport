import { attach, cdp } from './cdp.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { parseWaitFor, runEmbeddedWait, READ_TEXT_FN } from './poll.js';
import { getRef, isRef } from './refs.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

export { READ_TEXT_FN } from './poll.js';

/** Guard for fill's insertText paths. CDP `Input.insertText` has no node
 * argument — it writes to `document.activeElement` — so a write is only safe
 * when `focus()` actually landed. `focused` is reported by FILL_CLEAR_FN
 * (`activeElement === this` in the node's own root). Fail closed so a fill never
 * silently types into the wrong element (invariant #5). Companion check:
 * `ensureFocusedLeafNotPassword` then re-applies the password gate to the DEEPEST
 * focused leaf — this check alone is fooled by a `delegatesFocus` shadow host
 * (activeElement retargets to the host, so `=== this` holds) that delegates focus
 * to an inner password input. Pure / unit-tested. */
export function ensureFocusLanded(focused: boolean | undefined): void {
  if (focused !== true) {
    throw new BridgeError(
      'not_focusable',
      'fill: the target did not take focus, so typing would land in a different element — ' +
        'target a focusable field (input/textarea/contenteditable), or use method:value',
    );
  }
}

export async function resolveSelectorOrRef(
  tabId: number,
  selector: string,
  tool: string,
): Promise<string> {
  if (isRef(selector)) {
    const r = getRef(tabId, selector);
    if (!r) {
      throw new BridgeError(
        'bad_ref',
        `${tool}: unknown ref "${selector}" for tab ${tabId} — run snapshot first`,
      );
    }
    const resolved = await cdp<{ object: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
      backendNodeId: r.backendDOMNodeId,
    });
    if (!resolved.object.objectId) {
      throw new BridgeError('bad_ref', `${tool}: could not resolve ref to DOM`);
    }
    return resolved.object.objectId;
  }
  const doc = await cdp<{ root: { nodeId: number } }>(tabId, 'DOM.getDocument', { depth: 0 });
  const q = await cdp<{ nodeId: number }>(tabId, 'DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector,
  });
  if (!q.nodeId) {
    throw new BridgeError('not_found', `${tool}: element not found: ${selector}`);
  }
  const resolved = await cdp<{ object: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
    nodeId: q.nodeId,
  });
  if (!resolved.object.objectId) {
    throw new BridgeError('not_found', `${tool}: could not resolve element`);
  }
  return resolved.object.objectId;
}

/**
 * Decide whether a fill target is an `<input type=password>` from the flat
 * `[name, value, name, value, …]` attribute list CDP's `DOM.getAttributes`
 * returns. The list comes from the browser's own DOM, NOT from a page-readable
 * JS getter, so a hostile page cannot mask a password field from the gate by
 * shadowing `this.type` with a throwing or lying accessor.
 *
 * Fail-closed: a nullish list means the node's attributes could not be read,
 * so we treat it as a password field rather than letting text through. A
 * present-but-empty list (an element with no attributes) is an ordinary field.
 * Attribute names are compared case-insensitively and the value is trimmed and
 * lower-cased to match the HTML content-attribute semantics (`type=PASSWORD`).
 */
export function attributesIndicatePassword(attrs: readonly string[] | null | undefined): boolean {
  if (!attrs) return true;
  for (let i = 0; i + 1 < attrs.length; i += 2) {
    if (attrs[i].toLowerCase() === 'type') {
      return attrs[i + 1].trim().toLowerCase() === 'password';
    }
  }
  return false;
}

/**
 * Resolve the fill target to a DOM node and read its `type` attribute through
 * CDP, so the password gate reads the browser's ground truth instead of a
 * page-controllable `this.type`. Any failure to read the node fails closed
 * (treated as a password field).
 */
async function targetIsPasswordField(tabId: number, objectId: string): Promise<boolean> {
  const node = await cdp<{ nodeId?: number }>(tabId, 'DOM.requestNode', { objectId });
  if (!node.nodeId) return true;
  const res = await cdp<{ attributes?: string[] }>(tabId, 'DOM.getAttributes', {
    nodeId: node.nodeId,
  });
  return attributesIndicatePassword(res.attributes);
}

// Walk document.activeElement down through OPEN shadow roots to the element that
// ACTUALLY holds focus. CDP Input.insertText writes to this leaf, which is not
// always the resolved node: a shadow host with `delegatesFocus:true` delegates
// `focus()` to an inner control, yet `document.activeElement` (retargeted to the
// document) still reports the HOST — so the up-front gate, which inspects the
// resolved host, sees no password field while the write lands on the inner one.
// FIXED literal, no agent interpolation (invariant #4). The descent runs in page
// JS, so a hostile allowlisted page could hide a closed root or lie — the same
// stronger-adversary residual documented for the keystroke probe (SECURITY.md);
// against an honest page + agent mis-driving (the invariant #5 threat) it
// resolves the true write target.
const DEEPEST_ACTIVE_ELEMENT_EXPR =
  '(() => { let a = document.activeElement;' +
  ' while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;' +
  ' return a; })()';

/** After `focus()` has run, re-apply the password gate to the element that will
 * ACTUALLY receive the CDP `Input.insertText` — the deepest focused leaf, which
 * for a `delegatesFocus` shadow host is an inner node the up-front gate (checking
 * the resolved host) never inspected. Reads the leaf's `type` via CDP ground
 * truth (`targetIsPasswordField`), so a value can't be routed into an
 * `<input type=password>` (invariant #5). No-op when `allowPassword`, or when
 * nothing is focused (`ensureFocusLanded` handles the no-focus case). */
async function ensureFocusedLeafNotPassword(tabId: number, allowPassword: boolean): Promise<void> {
  if (allowPassword) return;
  const active = await cdp<{ result: { objectId?: string } }>(tabId, 'Runtime.evaluate', {
    expression: DEEPEST_ACTIVE_ELEMENT_EXPR,
  });
  const objectId = active.result.objectId;
  if (!objectId) return;
  if (await targetIsPasswordField(tabId, objectId)) {
    throw new BridgeError(
      'password_field',
      'fill: focus resolved to <input type=password> (e.g. a delegatesFocus shadow host); ' +
        'pass allowPassword=true to override',
    );
  }
}

export const click: Tool = async (args) => {
  const selector = String(args.selector || '');
  if (!selector) throw new BridgeError('bad_args', 'click: selector required');
  const waitSpec = parseWaitFor(args.waitFor, 'click');
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  const objectId = await resolveSelectorOrRef(tab.id!, selector, 'click');
  const out = await cdp<{ result: { value?: { tag: string; text: string } } }>(
    tab.id!,
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration:
        "function() { this.scrollIntoView({ block: 'center' }); this.click(); " +
        "return { tag: this.tagName, text: (this.textContent || '').slice(0, 100) }; }",
      returnByValue: true,
    },
  );
  const wait = waitSpec ? await runEmbeddedWait(tab.id!, waitSpec) : null;
  return {
    tabId: tab.id,
    url: tab.url,
    data: { ok: true, ...(out.result.value ?? {}), ...(wait ? { wait } : {}) },
  };
};

// Focus the target, select its whole content and delete it with real input
// events (execCommand fires beforeinput/input with a delete inputType), so
// the subsequent CDP Input.insertText lands in an empty field. Falls back to
// the native value setter if execCommand is refused. FIXED literal — the
// value itself never enters this function; it goes through Input.insertText.
// Also reports `focused`: whether this node is the active element in its own
// root AFTER focus(). Input.insertText has no node argument and writes to
// document.activeElement, so if focus() did not land here (non-focusable div,
// disabled/detached node) the caller MUST refuse — otherwise the text would be
// typed into whatever else is focused, e.g. a password field the gate never saw.
const FILL_CLEAR_FN = `function() {
  this.focus();
  const doc = this.ownerDocument;
  const win = doc.defaultView || window;
  if (this.isContentEditable) {
    const sel = win.getSelection();
    if (sel) {
      const r = doc.createRange();
      r.selectNodeContents(this);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  } else if (typeof this.select === 'function') {
    try { this.select(); } catch (_) {}
  }
  let cleared = false;
  try { cleared = doc.execCommand('delete', false); } catch (_) {}
  if (!cleared && !this.isContentEditable && 'value' in this && this.value !== '') {
    const proto = this.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement : win.HTMLInputElement;
    const d = proto ? Object.getOwnPropertyDescriptor(proto.prototype, 'value') : null;
    if (d && d.set) d.set.call(this, ''); else this.value = '';
    this.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return { tag: this.tagName, focused: this.getRootNode().activeElement === this };
}`;

export const fill: Tool = async (args) => {
  const selector = String(args.selector || '');
  if (!selector) throw new BridgeError('bad_args', 'fill: selector required');
  if (args.value === undefined || args.value === null) {
    throw new BridgeError('bad_args', 'fill: value required');
  }
  if (args.method !== undefined && args.method !== 'value' && args.method !== 'insertText') {
    throw new BridgeError('bad_args', "fill: method must be 'value' or 'insertText'");
  }
  const method = args.method === 'insertText' ? 'insertText' : 'value';
  const value = String(args.value);
  const waitSpec = parseWaitFor(args.waitFor, 'fill');
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);

  const objectId = await resolveSelectorOrRef(tab.id!, selector, 'fill');

  if (args.allowPassword !== true && (await targetIsPasswordField(tab.id!, objectId))) {
    throw new BridgeError(
      'password_field',
      'fill: refusing to type into <input type=password>; pass allowPassword=true to override',
    );
  }

  if (method === 'insertText') {
    // Clear via the fixed function above, then type through CDP — the page
    // sees the same composition of events a real keyboard/IME produces,
    // which frameworks that ignore programmatic .value (Telegram, Slack,
    // draft.js editors) do react to.
    const prep = await cdp<{ result: { value?: { tag: string; focused?: boolean } } }>(
      tab.id!,
      'Runtime.callFunctionOn',
      { objectId, functionDeclaration: FILL_CLEAR_FN, returnByValue: true },
    );
    // Input.insertText writes to document.activeElement, not this node. If focus
    // did not land here, refuse — otherwise the text goes to whatever else is
    // focused (e.g. a password field the gate above never inspected), and the
    // unredacted value would be logged. Fail closed (invariant #5). Then re-check
    // the ACTUAL focused leaf: a delegatesFocus shadow host passes ensureFocusLanded
    // (activeElement retargets to the host === this) yet delegates focus to an
    // inner <input type=password> the resolved-node gate never saw.
    ensureFocusLanded(prep.result.value?.focused);
    await ensureFocusedLeafNotPassword(tab.id!, args.allowPassword === true);
    if (value !== '') {
      await cdp(tab.id!, 'Input.insertText', { text: value });
    }
    const insertWait = waitSpec ? await runEmbeddedWait(tab.id!, waitSpec) : null;
    return {
      tabId: tab.id,
      url: tab.url,
      data: {
        ok: true,
        tag: prep.result.value?.tag ?? '',
        mode: 'insertText',
        ...(insertWait ? { wait: insertWait } : {}),
      },
    };
  }

  const fnBody = `function(v) {
    this.focus();
    if (this.isContentEditable) {
      const sel = window.getSelection();
      if (sel) {
        const r = document.createRange();
        r.selectNodeContents(this);
        sel.removeAllRanges();
        sel.addRange(r);
      }
      let inserted = false;
      try { inserted = document.execCommand('insertText', false, v); } catch (_) {}
      if (!inserted) {
        this.textContent = v;
        this.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: v, bubbles: true }));
      }
      return {
        tag: this.tagName,
        mode: 'contenteditable',
        applied: (this.innerText || this.textContent || ''),
      };
    }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(this, v); else this.value = v;
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
    // Read back the live value so the handler can tell whether the set actually
    // stuck (React-controlled inputs revert a programmatic .value on render).
    return { tag: this.tagName, mode: 'value', applied: ('value' in this ? String(this.value) : '') };
  }`;
  const out = await cdp<{ result: { value?: { tag: string; mode: string; applied: string } } }>(
    tab.id!,
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: fnBody,
      arguments: [{ value }],
      returnByValue: true,
    },
  );
  const res = out.result.value ?? { tag: '', mode: 'value', applied: '' };
  // Verify the value actually landed. React-controlled inputs silently revert a
  // programmatic .value on their next render, so method:value can no-op while
  // still returning ok:true — a footgun (you think the field is filled; it's
  // empty). On a mismatch, fall back to the same keyboard-level insertText path
  // method:insertText uses (frameworks DO observe it). The password gate already
  // passed above, so the fallback can't slip text into a password field.
  const stuck = res.applied === value || (value !== '' && res.applied.includes(value));
  if (!stuck) {
    const fbPrep = await cdp<{ result: { value?: { tag: string; focused?: boolean } } }>(
      tab.id!,
      'Runtime.callFunctionOn',
      { objectId, functionDeclaration: FILL_CLEAR_FN, returnByValue: true },
    );
    // Same guard as the method:insertText path: the fallback also types via
    // Input.insertText (document.activeElement), so refuse if focus didn't land
    // and re-check the actual focused leaf for a delegatesFocus password bypass.
    ensureFocusLanded(fbPrep.result.value?.focused);
    await ensureFocusedLeafNotPassword(tab.id!, args.allowPassword === true);
    if (value !== '') await cdp(tab.id!, 'Input.insertText', { text: value });
    const fbWait = waitSpec ? await runEmbeddedWait(tab.id!, waitSpec) : null;
    return {
      tabId: tab.id,
      url: tab.url,
      data: {
        ok: true,
        tag: res.tag,
        mode: 'insertText',
        fallbackFrom: 'value',
        ...(fbWait ? { wait: fbWait } : {}),
      },
    };
  }
  const wait = waitSpec ? await runEmbeddedWait(tab.id!, waitSpec) : null;
  return {
    tabId: tab.id,
    url: tab.url,
    data: { ok: true, tag: res.tag, mode: res.mode, ...(wait ? { wait } : {}) },
  };
};

// A whole-page innerText on a chat SPA easily runs to tens of KB — past the
// MCP tool-result budget, which shunts the payload into a file the agent
// then has to re-read. Cap by default; `maxChars` overrides either way, and
// the `truncated`/`totalChars` markers keep the cut visible.
const DEFAULT_READ_MAX_CHARS = 20_000;

function parseMaxChars(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_READ_MAX_CHARS;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1) {
    throw new BridgeError('bad_args', 'read_text: maxChars must be an integer >= 1');
  }
  return v;
}

function capText(
  text: string,
  maxChars: number,
): { text: string; truncated?: true; totalChars?: number } {
  if (text.length <= maxChars) return { text };
  return { text: text.slice(0, maxChars), truncated: true, totalChars: text.length };
}

export const readText: Tool = async (args) => {
  const maxChars = parseMaxChars(args.maxChars);
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);

  if (typeof args.ref === 'string' && isRef(args.ref)) {
    const r = getRef(tab.id!, args.ref);
    if (!r) {
      throw new BridgeError(
        'bad_ref',
        `unknown ref "${args.ref}" for tab ${tab.id} — run snapshot first`,
      );
    }
    const resolved = await cdp<{ object: { objectId?: string } }>(tab.id!, 'DOM.resolveNode', {
      backendNodeId: r.backendDOMNodeId,
    });
    if (!resolved.object.objectId) {
      throw new BridgeError('bad_ref', 'could not resolve ref to a DOM node');
    }
    const out = await cdp<{ result: { value?: string } }>(tab.id!, 'Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration: READ_TEXT_FN,
      returnByValue: true,
    });
    return { tabId: tab.id, url: tab.url, data: capText(out.result.value ?? '', maxChars) };
  }

  const doc = await cdp<{ root: { nodeId: number } }>(tab.id!, 'DOM.getDocument', { depth: 0 });
  const bodyQ = await cdp<{ nodeId: number }>(tab.id!, 'DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: 'body',
  });
  if (!bodyQ.nodeId) return { tabId: tab.id, url: tab.url, data: { text: '' } };
  const resolved = await cdp<{ object: { objectId?: string } }>(tab.id!, 'DOM.resolveNode', {
    nodeId: bodyQ.nodeId,
  });
  if (!resolved.object.objectId) {
    return { tabId: tab.id, url: tab.url, data: { text: '' } };
  }
  const out = await cdp<{ result: { value?: string } }>(tab.id!, 'Runtime.callFunctionOn', {
    objectId: resolved.object.objectId,
    functionDeclaration: READ_TEXT_FN,
    returnByValue: true,
  });
  return { tabId: tab.id, url: tab.url, data: capText(out.result.value ?? '', maxChars) };
};
