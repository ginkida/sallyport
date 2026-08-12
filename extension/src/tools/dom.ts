import { attach, cdp, looksLikeMissingNodeError, looksLikeSelectorSyntaxError } from './cdp.js';
import { BridgeError, invalidSelectorError, staleRefError } from './errors.js';
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

/** Resolve a browser-owned backendNodeId to a live page objectId.
 *
 * Split out of `resolveSelectorOrRef` for callers that have PINNED a node up
 * front and can no longer go through the ref map — `reveal`, whose own loop
 * re-snapshots on every pass and therefore renumbers the tab's refs out from
 * under the container it was handed. A backendNodeId is the browser's own
 * identity for the node and survives that. `label` is only for the error text. */
export async function resolveBackendNode(
  tabId: number,
  backendNodeId: number,
  label: string,
  tool: string,
): Promise<string> {
  let resolved: { object: { objectId?: string } };
  try {
    resolved = await cdp<{ object: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
      backendNodeId,
    });
  } catch (e) {
    if (looksLikeMissingNodeError(e)) throw staleRefError(tool, label);
    throw e;
  }
  if (!resolved.object.objectId) {
    throw new BridgeError('bad_ref', `${tool}: could not resolve ref to DOM`);
  }
  return resolved.object.objectId;
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
    return resolveBackendNode(tabId, r.backendDOMNodeId, selector, tool);
  }
  const doc = await cdp<{ root: { nodeId: number } }>(tabId, 'DOM.getDocument', { depth: 0 });
  let q: { nodeId: number };
  try {
    q = await cdp<{ nodeId: number }>(tabId, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector,
    });
  } catch (e) {
    if (looksLikeSelectorSyntaxError(e)) throw invalidSelectorError(tool, selector);
    throw e;
  }
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

// Walk document.activeElement down to the element that ACTUALLY holds focus.
// CDP Input.insertText writes to this leaf, which is not always the resolved
// node, and TWO structures move it:
//
//  - a shadow host with `delegatesFocus:true` delegates `focus()` to an inner
//    control, yet `document.activeElement` (retargeted to the document) still
//    reports the HOST — so the up-front gate, inspecting the resolved host,
//    sees no password field while the write lands on the inner one;
//  - a same-origin IFRAME. `fill(selector='iframe.login')` resolves to the
//    frame ELEMENT, which is not a password field, so the up-front gate passes;
//    `focus()` on it moves focus INTO the frame, and the insertText then lands
//    on whatever is focused there — which can be an `<input type=password>` the
//    gate never saw. Descending into the frame closes that: the leaf is
//    re-gated like any other. A cross-origin frame throws on `contentDocument`
//    and the walk stops at the frame element, which is the honest answer — we
//    cannot see in, and nothing is typed there that we could have inspected
//    anyway (the keystroke tools use CDP's own OOPIF walk for that case).
//
// Bounded so a pathological focus cycle cannot spin. FIXED literal, no agent
// interpolation (invariant #4). The descent runs in page JS, so a hostile
// allowlisted page could hide a closed root or lie — the same stronger-adversary
// residual documented for the keystroke probe (SECURITY.md); against an honest
// page + agent mis-driving (the invariant #5 threat) it resolves the true
// write target.
export const DEEPEST_ACTIVE_ELEMENT_EXPR =
  '(() => { let a = document.activeElement;' +
  ' for (let i = 0; i < 20 && a; i++) {' +
  ' if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }' +
  ' if (a.tagName === "IFRAME" || a.tagName === "FRAME") {' +
  ' let d = null; try { d = a.contentDocument; } catch (e) { d = null; }' +
  ' if (d && d.activeElement) { a = d.activeElement; continue; } }' +
  ' break; }' +
  ' return a; })()';

/** After `focus()` has run, re-apply the password gate to the element that will
 * ACTUALLY receive the CDP `Input.insertText` — the deepest focused leaf, which
 * for a `delegatesFocus` shadow host is an inner node the up-front gate (checking
 * the resolved host) never inspected. Reads the leaf's `type` via CDP ground
 * truth (`targetIsPasswordField`), so a value can't be routed into an
 * `<input type=password>` (invariant #5). No-op when `allowPassword`, or when
 * nothing is focused (`ensureFocusLanded` handles the no-focus case). */
async function ensureFocusedLeafNotPassword(
  tabId: number,
  allowPassword: boolean,
): Promise<string | null> {
  if (allowPassword) return null;
  const active = await cdp<{ result: { objectId?: string } }>(tabId, 'Runtime.evaluate', {
    expression: DEEPEST_ACTIVE_ELEMENT_EXPR,
  });
  const objectId = active.result.objectId;
  if (!objectId) return null;
  if (await targetIsPasswordField(tabId, objectId)) {
    throw new BridgeError(
      'password_field',
      'fill: focus resolved to <input type=password> (e.g. a delegatesFocus shadow host); ' +
        'pass allowPassword=true to override',
    );
  }
  return objectId;
}

/** Click the node — unless the click is guaranteed to do nothing, in which case
 * say so instead of pretending.
 *
 * Two cases the browser silently swallows: a form control with the HTML
 * `disabled` attribute (Chrome dispatches no click event at all) and a node the
 * page has detached (`.click()` fires into a document nobody is watching).
 * Both used to return `{ok:true}` — the most expensive kind of wrong answer,
 * since the agent then spends turns hunting for why the page did not react, and
 * an embedded `waitFor` cannot rescue it either: it just times out.
 *
 * Deliberately NOT refused: a zero-size element. A synthetic `.click()` on a
 * `display:none` node works and is a legitimate, common pattern — a hidden
 * `<input type=file>` behind a styled label is exactly how upload flows are
 * built. Geometry is `mouse_click`'s business, because it dispatches real
 * coordinates; `click` does not. The zero rect is REPORTED (`hidden`) rather
 * than acted on.
 *
 * `this.disabled` is page-readable and therefore page-spoofable, which is fine
 * under invariant #4's rule that a probe may report anything so long as nothing
 * load-bearing rests on it: the worst a lying page achieves is refusing a click
 * that would have been the no-op we are reporting anyway. It cannot cause an
 * action, only decline one. FIXED literal, no agent interpolation. */
export const CLICK_FN = `function() {
  if (this.disabled === true) return { tag: this.tagName, blocked: 'disabled' };
  if (this.isConnected === false) return { tag: this.tagName, blocked: 'detached' };
  this.scrollIntoView({ block: 'center' });
  this.click();
  const r = this.getBoundingClientRect();
  const out = { tag: this.tagName, text: (this.textContent || '').slice(0, 100) };
  if (r.width === 0 && r.height === 0) out.hidden = true;
  return out;
}`;

type ClickProbe = {
  tag?: string;
  text?: string;
  hidden?: true;
  blocked?: 'disabled' | 'detached';
};

export const click: Tool = async (args) => {
  const selector = String(args.selector || '');
  if (!selector) throw new BridgeError('bad_args', 'click: selector required');
  const waitSpec = parseWaitFor(args.waitFor, 'click');
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  const objectId = await resolveSelectorOrRef(tab.id!, selector, 'click');
  const out = await cdp<{ result: { value?: ClickProbe } }>(tab.id!, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: CLICK_FN,
    returnByValue: true,
  });
  const probe = out.result.value ?? {};
  if (probe.blocked === 'disabled') {
    throw new BridgeError(
      'element_disabled',
      `click: ${probe.tag ?? 'the element'} is disabled, so the browser dispatches no click — ` +
        `satisfy whatever enables it (fill the form, wait_for it to become enabled), then retry`,
    );
  }
  if (probe.blocked === 'detached') {
    // Route by how the target was NAMED, not by how it failed: telling an agent
    // that passed a CSS selector to "re-snapshot for a fresh ref" points at a
    // ref it never held. (DOM.querySelector only returns connected nodes, so
    // this branch means the page detached it between the query and the click.)
    if (isRef(selector)) throw staleRefError('click', selector);
    throw new BridgeError(
      'not_found',
      `click: ${selector} was detached from the document before the click landed — ` +
        `re-locate it (find/wait_for) and retry`,
    );
  }
  const wait = waitSpec ? await runEmbeddedWait(tab.id!, waitSpec) : null;
  return {
    tabId: tab.id,
    url: tab.url,
    data: { ok: true, ...probe, ...(wait ? { wait } : {}) },
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

/** What the post-write read-back can honestly conclude.
 *
 *  - `yes`     the field contains what we sent;
 *  - `no`      the field is EMPTY — nothing landed at all;
 *  - `unclear` the field has content that is not literally our text. An input
 *              mask ("+7 (912) …"), a normaliser, or a `maxlength` truncation
 *              all look like this, and `len` is what tells them apart. Calling
 *              this `false` would be a wrong verdict on a fill that worked,
 *              which is worse than admitting the ambiguity.
 */
export type Applied = 'yes' | 'no' | 'unclear';

/** Read back whether the text we just typed is actually in the field.
 *
 * `method:'value'` was already hardened against silently no-opping (a
 * React-controlled input reverts a programmatic `.value` on its next render) —
 * and its remedy is to fall through to `insertText`, which verified nothing at
 * all. Masks, `maxlength`, and editors that swallow composition give exactly
 * the same false `ok:true` there.
 *
 * Returns ONLY `{matched, len}` — never the string. That is what keeps
 * invariant #5 intact: the caller already knows the text (it just sent it), so
 * a boolean tells it nothing new, while the content itself never crosses back.
 * `len` is the diagnostic that separates "nothing landed" from "landed but
 * truncated to 20 by maxlength". Skipped entirely when `allowPassword` is set,
 * i.e. on the only nodes where a length could describe a credential; with it
 * unset the password gate has already proved this is not one. FIXED literal,
 * the expected text travels as a structured callFunctionOn argument. */
/** Ask BOTH plausible write targets whether the text is there.
 *
 * `Input.insertText` writes to the deepest focused leaf, which is not always
 * the node the selector named — a `delegatesFocus` shadow host is not the
 * field. But the reverse trap is just as real: for a field inside a same-origin
 * iframe the main frame's `document.activeElement` is the `<iframe>` ELEMENT,
 * which has no value at all, so reading only the leaf would report a perfectly
 * successful fill as "nothing landed". Reading only the resolved node has the
 * mirror-image failure on the shadow host. So read both and take the answer
 * that found the text; on a miss report the longer of the two lengths, which is
 * the one that describes an actual field rather than a wrapper.
 *
 * The walk starts from the node's OWN `ownerDocument`, never a bare `document`
 * — both because the probe must be self-contained (a free identifier would be a
 * ReferenceError in some contexts, and every other serialised probe here is
 * pinned on that), and because it is more correct: for a field inside an
 * iframe, that document's `activeElement` is the field itself, where the main
 * frame's would be the `<iframe>` element. Open shadow roots and same-origin
 * iframes are still descended defensively; a cross-origin one throws on
 * `contentDocument` and the walk stops there, which is the honest answer — we
 * cannot see in, and CDP's own frame walk (keyboard.ts) is what handles that.
 * Bounded so a pathological structure cannot spin.
 *
 * Content NEVER leaves: only a length and a boolean. Both candidates have
 * already cleared the password gate on the path that runs this — the resolved
 * node via `targetIsPasswordField`, the focused leaf via
 * `ensureFocusedLeafNotPassword` — and the whole read-back is skipped when
 * `allowPassword` is set. FIXED literal; the expected text is a structured
 * callFunctionOn argument. */
export const FILL_READBACK_FN = `function(expected) {
  function read(el) {
    if (!el) return null;
    if (el.isContentEditable) return el.innerText || el.textContent || '';
    return 'value' in el ? String(el.value) : null;
  }
  function focusedLeaf(doc) {
    var a = doc && doc.activeElement;
    for (var i = 0; i < 20 && a; i++) {
      if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
      if (a.tagName === 'IFRAME') {
        var d = null;
        try { d = a.contentDocument; } catch (e) { d = null; }
        if (d && d.activeElement) { a = d.activeElement; continue; }
      }
      break;
    }
    return a;
  }
  var candidates = [this, focusedLeaf(this.ownerDocument)];
  var best = -1;
  for (var i = 0; i < candidates.length; i++) {
    var v = read(candidates[i]);
    if (v === null) continue;
    if (v === expected || v.indexOf(expected) !== -1) return { len: v.length, matched: true };
    if (v.length > best) best = v.length;
  }
  return { len: best < 0 ? 0 : best, matched: false };
}`;

/** Turn the probe's two numbers into the tri-state verdict. Pure, so the one
 * judgement call here — that a non-empty field which does not contain our text
 * is `unclear`, not a failure — is pinned by a test rather than buried. */
export function classifyApplied(matched: boolean, len: number): Applied {
  if (matched) return 'yes';
  return len === 0 ? 'no' : 'unclear';
}

async function readBackApplied(
  tabId: number,
  objectId: string,
  expected: string,
): Promise<{ applied: Applied; len: number } | null> {
  try {
    const out = await cdp<{ result: { value?: { matched?: boolean; len?: number } } }>(
      tabId,
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: FILL_READBACK_FN,
        arguments: [{ value: expected }],
        returnByValue: true,
      },
    );
    const v = out.result.value;
    if (!v || typeof v.matched !== 'boolean' || typeof v.len !== 'number') return null;
    return { applied: classifyApplied(v.matched, v.len), len: v.len };
  } catch {
    // The node died between the write and the read, or the page refused the
    // call. Report nothing rather than guessing — an absent `applied` is
    // honest, a wrong one would be worse than the silence it replaces.
    return null;
  }
}

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
    const landed =
      args.allowPassword === true || value === ''
        ? null
        : await readBackApplied(tab.id!, objectId, value);
    const insertWait = waitSpec ? await runEmbeddedWait(tab.id!, waitSpec) : null;
    return {
      tabId: tab.id,
      url: tab.url,
      data: {
        ok: true,
        tag: prep.result.value?.tag ?? '',
        mode: 'insertText',
        ...(landed ?? {}),
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
    const fbLanded =
      args.allowPassword === true || value === ''
        ? null
        : await readBackApplied(tab.id!, objectId, value);
    const fbWait = waitSpec ? await runEmbeddedWait(tab.id!, waitSpec) : null;
    return {
      tabId: tab.id,
      url: tab.url,
      data: {
        ok: true,
        tag: res.tag,
        mode: 'insertText',
        fallbackFrom: 'value',
        ...(fbLanded ?? {}),
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
// A ceiling on top of the default. Without one, `maxChars: 500000` was a single
// call that put ~125k tokens into the window permanently — and unlike a
// snapshot there is no structure to skim, so the model pays for all of it on
// every later turn. With `offset` below, a genuinely long page is now readable
// in pages instead, which is both cheaper and resumable.
const MAX_READ_MAX_CHARS = 200_000;

export function parseMaxChars(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_READ_MAX_CHARS;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1) {
    throw new BridgeError('bad_args', 'read_text: maxChars must be an integer >= 1');
  }
  return Math.min(v, MAX_READ_MAX_CHARS);
}

export function parseOffset(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 0) {
    throw new BridgeError('bad_args', 'read_text: offset must be an integer >= 0');
  }
  return v;
}

export type CappedText = {
  text: string;
  truncated?: true;
  totalChars?: number;
  offset?: number;
  nextOffset?: number;
};

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/** Slice the page text into one readable window.
 *
 * The cut used to be reported (`truncated`/`totalChars`) but not resumable: the
 * only way past character 20 000 was to re-read from zero with a bigger cap,
 * paying for the first 20 000 characters a second time and putting them in the
 * context twice. `nextOffset` is the whole fix — hand it straight back as
 * `offset` to continue.
 *
 * Both edges are snapped off the middle of a surrogate pair. JS string indices
 * are UTF-16 code units, so a naive slice through an emoji leaves a LONE
 * SURROGATE — which `protocol.ts` refuses to sign, turning the whole read into
 * `unserialisable_result`. On a chat SPA, the exact thing this tool is for,
 * that is not a rare boundary. Snapping costs at most one code unit per edge.
 *
 * A page is never returned empty while more text remains: with `maxChars: 1`
 * landing on a pair, the pair is taken whole rather than emitting
 * `{text:'', nextOffset: offset}`, which a paging agent would loop on forever.
 * Pure, so all of this is testable without chrome. */
export function capText(text: string, maxChars: number, offset = 0): CappedText {
  const total = text.length;
  let start = Math.min(offset, total);
  // A low surrogate at `start` means the previous read stopped mid-pair (or the
  // caller invented the offset) — step past the orphan rather than emitting it.
  if (start > 0 && start < total && isLowSurrogate(text.charCodeAt(start))) {
    if (isHighSurrogate(text.charCodeAt(start - 1))) start += 1;
  }
  let end = Math.min(start + maxChars, total);
  if (
    end < total &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  ) {
    end -= 1;
    // …unless that would make this page empty, which would stall a paging loop.
    if (end <= start) end = Math.min(start + 2, total);
  }
  const slice = text.slice(start, end);
  const out: CappedText = { text: slice };
  if (start > 0) out.offset = start;
  if (end < total) {
    out.truncated = true;
    out.totalChars = total;
    out.nextOffset = end;
  } else if (start > 0) {
    // Reached the end on a continuation read — say how long the whole thing was
    // so the agent can tell "done" from "maybe more".
    out.totalChars = total;
  }
  return out;
}

export const readText: Tool = async (args) => {
  const maxChars = parseMaxChars(args.maxChars);
  const offset = parseOffset(args.offset);
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
    let resolved: { object: { objectId?: string } };
    try {
      resolved = await cdp<{ object: { objectId?: string } }>(tab.id!, 'DOM.resolveNode', {
        backendNodeId: r.backendDOMNodeId,
      });
    } catch (e) {
      if (looksLikeMissingNodeError(e)) throw staleRefError('read_text', args.ref);
      throw e;
    }
    if (!resolved.object.objectId) {
      throw new BridgeError('bad_ref', 'could not resolve ref to a DOM node');
    }
    const out = await cdp<{ result: { value?: string } }>(tab.id!, 'Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration: READ_TEXT_FN,
      returnByValue: true,
    });
    return { tabId: tab.id, url: tab.url, data: capText(out.result.value ?? '', maxChars, offset) };
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
  return { tabId: tab.id, url: tab.url, data: capText(out.result.value ?? '', maxChars, offset) };
};
