import { attach, CALL_GROUP, cdp } from './cdp.js';
import { pageFrameOrigins } from './frames.js';
import { BridgeError, staleRefError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { parseObserve, runObserve } from './observe.js';
import { parseWaitFor, runEmbeddedWait } from './poll.js';
import { capText, parseMaxChars, parseOffset, READ_TEXT_FN } from './text.js';
import { domNodeAcceptsText, domNodeIsPassword } from './focus.js';
import { getRef, isRef } from './refs.js';
import { resolveBackendNode, resolveSelectorOrRef } from './resolve.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

export { READ_TEXT_FN } from './text.js';

/** Guard for fill's insertText paths. CDP `Input.insertText` has no node
 * argument — it writes to `document.activeElement` — so a write is only safe
 * when `focus()` actually landed. `focused` is reported by FILL_CLEAR_FN
 * (`activeElement === this` in the node's own root). Fail closed so a fill never
 * silently types into the wrong element (invariant #5). It is only the cheap
 * first answer, and page-reported: `armFillGuard` then asks the BROWSER where
 * focus is (it sees past a `delegatesFocus` host into a closed shadow root) and
 * fences the insert to the target. Pure / unit-tested. */
export function ensureFocusLanded(focused: boolean | undefined): void {
  if (focused !== true) {
    throw new BridgeError(
      'not_focusable',
      'fill: the target did not take focus, so typing would land in a different element — ' +
        'target a focusable field (input/textarea/contenteditable), or use method:value',
    );
  }
}

/**
 * Read the fill target's tag and `type` through CDP, so the password gate reads
 * the browser's ground truth instead of a page-controllable `this.type`. Any
 * failure to read the node fails closed (treated as a password field).
 *
 * `DOM.describeNode` by objectId, not `DOM.requestNode` + `getAttributes`:
 * requestNode needs the document already pushed to the frontend and answers
 * nodeId 0 when nothing has called `DOM.getDocument` — exactly the state right
 * after an a11y snapshot, so `fill('@e3')` on a plain text field failed closed
 * as `password_field` and the error told the agent to pass allowPassword=true.
 * describeNode needs no pushed document (the keystroke gate already uses it).
 */
export async function targetIsPasswordField(tabId: number, objectId: string): Promise<boolean> {
  const out = await cdp<{ node?: unknown }>(tabId, 'DOM.describeNode', { objectId, depth: 0 });
  const verdict = domNodeIsPassword(out.node);
  return verdict === null ? true : verdict;
}

// --- target-bound typing ---------------------------------------------------
//
// `Input.insertText` has no node argument: it types into whatever holds focus
// AT THAT MOMENT. A gate that asks "is wherever focus went safe?" therefore
// races the page — Chrome applies a frame's pending autofocus (an
// `<input type=password autofocus>`) only at the insert, so a check that saw
// the frame's <body> passed and the text landed in the password field
// (reproduced; invariant #5). fill instead asks "did focus land ON THE TARGET
// it was told to fill?", which the browser answers exactly, and fences the
// insert itself to that target:
//
//  1. bindFillTarget — the target is the resolved node. A frame element is
//     never a target (its focus lives in another document); a same-origin
//     frame whose document is an EDITOR (contenteditable body / designMode)
//     retargets to that body — found browser-side, and gated against the
//     allowlist by the frame's OWN origin, since the tab's url says nothing
//     about a frame's.
//  2. armFillGuard (before the insert) — Accessibility.queryAXTree over the
//     target's subtree must show the focused node (it sees through CLOSED
//     shadow roots, and does not descend into child frames); that node — the
//     WRITE node — must hold text and, without allowPassword, not be a
//     password field. A real element holding focus is also what stops a
//     pending autofocus from moving it: autofocus only fires when nothing is.
//  3. the guard itself — capture `beforeinput` listeners in an ISOLATED world
//     (page prototype overrides don't reach it) at EVERY root on the write
//     node's path: its own shadow root, each enclosing one, and the window.
//     Each compares the event target as retargeted for THAT root, so two
//     fields inside one shadow root are told apart (a window-level listener
//     alone sees only the outermost host for both). Any trusted insert aimed
//     elsewhere is cancelled; the insert must also have reached the write node.
//     Prevention, not detection after.
//
// Residuals (SECURITY.md): a move into ANOTHER document between the check and
// the insert is detected (`focus_moved`), not prevented; a page capture
// listener registered first can stopImmediatePropagation before ours runs.

const FRAME_OWNER_TAGS = new Set(['IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'FENCEDFRAME', 'PORTAL']);
const FILL_GUARD_GROUP = 'sallyport-fill-guard';
const FILL_WORLD = 'sallyport-fill';

type DescribedNode = {
  nodeName?: unknown;
  backendNodeId?: unknown;
  frameId?: unknown;
  contentDocument?: DescribedNode;
  children?: DescribedNode[];
};

type FillTarget = {
  objectId: string;
  backendNodeId: number;
  /** The frame whose document holds the target; null = the main frame,
   * looked up only when a guard is armed (method:value never needs it). */
  frameId: string | null;
  /** The target is a frame's editable body, not a field: write with insertText only. */
  editorFrame: boolean;
};

async function releaseGuardGroup(tabId: number): Promise<void> {
  try {
    await cdp(tabId, 'Runtime.releaseObjectGroup', { objectGroup: FILL_GUARD_GROUP });
  } catch {
    // a navigation already released it
  }
}

/** `backendNodeId` resolved INSIDE an isolated world of `frameId`. The world is
 * created per call, never cached: execution-context ids are unique only within
 * one renderer, so a cached id can name a DIFFERENT context (the page's own
 * world) after a cross-process navigation — and resolve without an error. */
async function resolveIsolated(
  tabId: number,
  frameId: string,
  backendNodeId: number,
): Promise<string> {
  const { executionContextId } = await cdp<{ executionContextId: number }>(
    tabId,
    'Page.createIsolatedWorld',
    { frameId, worldName: FILL_WORLD },
  );
  const { object } = await cdp<{ object: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
    backendNodeId,
    executionContextId,
    objectGroup: FILL_GUARD_GROUP,
  });
  if (!object.objectId) {
    throw new BridgeError(
      'focus_probe_failed',
      'fill: could not reach the target to guard the write',
    );
  }
  return object.objectId;
}

type FrameTreeNode = {
  frame?: { id?: unknown; url?: unknown; securityOrigin?: unknown };
  childFrames?: FrameTreeNode[];
};

async function frameTree(tabId: number): Promise<FrameTreeNode> {
  const out = await cdp<{ frameTree?: FrameTreeNode }>(tabId, 'Page.getFrameTree');
  if (!out.frameTree) {
    throw new BridgeError('focus_probe_failed', 'fill: could not read the page frames');
  }
  return out.frameTree;
}

async function mainFrameId(tabId: number): Promise<string> {
  const id = (await frameTree(tabId)).frame?.id;
  if (typeof id !== 'string') {
    throw new BridgeError('focus_probe_failed', 'fill: could not identify the page frame');
  }
  return id;
}

/** The url to allowlist-check a frame by: its own http(s) url; else (about:blank,
 * srcdoc — the usual editor frame) the url of its parent when the parent has the
 * origin the frame inherited — so a path-pinned entry (`https://x.com/app/*`)
 * still admits an editor on `/app/edit` — else that origin. Opaque → null. Pure. */
export function frameGateUrl(tree: FrameTreeNode, frameId: string): string | null {
  const stack: Array<[FrameTreeNode, FrameTreeNode | null]> = [[tree, null]];
  for (let n = 0; n < 1000 && stack.length; n++) {
    const [node, parent] = stack.pop()!;
    if (node.frame?.id === frameId) {
      const url = typeof node.frame.url === 'string' ? node.frame.url : '';
      if (/^https?:\/\//i.test(url)) return url;
      const origin = node.frame.securityOrigin;
      if (typeof origin !== 'string' || !/^https?:\/\//i.test(origin)) return null;
      const parentUrl = parent?.frame?.url;
      if (typeof parentUrl === 'string' && /^https?:\/\//i.test(parentUrl)) {
        try {
          if (new URL(parentUrl).origin === origin) return parentUrl;
        } catch {
          // fall through to the bare origin
        }
      }
      return origin + '/';
    }
    for (const child of node.childFrames ?? []) stack.push([child, node]);
  }
  return null;
}

async function isEditableIsolated(
  tabId: number,
  frameId: string,
  backendNodeId: number,
): Promise<boolean> {
  const objectId = await resolveIsolated(tabId, frameId, backendNodeId);
  const out = await cdp<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
    tabId,
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: 'function() { return this.isContentEditable === true; }',
      returnByValue: true,
    },
  );
  return !out.exceptionDetails && out.result?.value === true;
}

export function findBody(
  node: DescribedNode | undefined,
  depth: number,
): DescribedNode | undefined {
  if (!node || depth < 0) return undefined;
  if (String(node.nodeName ?? '').toUpperCase() === 'BODY') return node;
  for (const child of node.children ?? []) {
    const hit = findBody(child, depth - 1);
    if (hit) return hit;
  }
  return undefined;
}

/** Step 1: what fill will write into, identified by the browser. */
async function bindFillTarget(tabId: number, objectId: string): Promise<FillTarget> {
  const { node } = await cdp<{ node: DescribedNode }>(tabId, 'DOM.describeNode', { objectId });
  const name = String(node.nodeName ?? '').toUpperCase();
  if (typeof node.backendNodeId !== 'number') {
    throw new BridgeError('focus_probe_failed', 'fill: could not identify the target');
  }
  if (!FRAME_OWNER_TAGS.has(name)) {
    return { objectId, backendNodeId: node.backendNodeId, frameId: null, editorFrame: false };
  }
  const tag = name.toLowerCase();
  // Through the frame OWNER with pierce, not by the child document's own id:
  // once the main document has been fetched, Chrome refuses the latter
  // ("Node with given id does not belong to the document").
  const { node: deep } = await cdp<{ node: DescribedNode }>(tabId, 'DOM.describeNode', {
    objectId,
    depth: 4,
    pierce: true,
  });
  const body = findBody(deep.contentDocument, 3);
  if (typeof deep.frameId !== 'string' || !body || typeof body.backendNodeId !== 'number') {
    throw new BridgeError(
      'wrong_element',
      `fill: <${tag}> is a frame whose document this tab cannot reach (out-of-process, ` +
        'not loaded, or not a page) — nothing typed into it could be verified, so fill does not',
    );
  }
  const gateUrl = frameGateUrl(await frameTree(tabId), deep.frameId);
  if (!gateUrl) {
    throw new BridgeError('wrong_element', `fill: <${tag}> holds an opaque-origin document`);
  }
  await ensureAllowed(gateUrl);
  try {
    if (!(await isEditableIsolated(tabId, deep.frameId, body.backendNodeId))) {
      throw new BridgeError(
        'wrong_element',
        `fill: <${tag}> is a frame, not a field — fill types into a frame only when its ` +
          'whole document is an editor (contenteditable body or designMode)',
      );
    }
  } finally {
    await releaseGuardGroup(tabId);
  }
  const resolved = await cdp<{ object: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
    backendNodeId: body.backendNodeId,
    objectGroup: CALL_GROUP,
  });
  if (!resolved.object.objectId) {
    throw new BridgeError('focus_probe_failed', 'fill: could not reach the editor body');
  }
  return {
    objectId: resolved.object.objectId,
    backendNodeId: body.backendNodeId,
    frameId: deep.frameId,
    editorFrame: true,
  };
}

/** Fixed literal, `this` = the WRITE node in the ISOLATED world.
 *
 * The check is the FOCUS CHAIN, not the event target: every root on the write
 * node's path (its shadow root, each enclosing one, the document) must still
 * have the expected node as its `activeElement`. That is where the insert
 * actually goes — `beforeinput`'s target is fixed before a page handler can
 * move focus, and Chrome inserts at the selection as it stands afterwards — and
 * the guard holds a reference to every root, closed ones included, so it needs
 * no listener inside any of them: ONE capture listener on the window, the
 * first stop on the event path, sees every insert in this document before a
 * page listener below it can stop propagation. It checks both `beforeinput`
 * and `textInput` (which Chrome fires AFTER beforeinput, cancelably, at the
 * point of insertion), so a focus move in a beforeinput handler is caught too.
 * Untrusted (page-dispatched) events are ignored both ways. Throws when the
 * node is not in a document, so the insert never runs unguarded. Self-expires,
 * so a worker lost mid-call can't leave it cancelling the human's typing. */
export const FILL_GUARD_FN = `function() {
  const chain = [];
  let node = this;
  for (let i = 0; i < 32 && node; i++) {
    const root = node.getRootNode();
    chain.push([root, node]);
    if (root && root.nodeType === 11 && root.host) { node = root.host; continue; }
    break;
  }
  const top = chain.length ? chain[chain.length - 1][0] : null;
  const win = top && top.nodeType === 9 ? top.defaultView : null;
  if (!win) throw new Error('fill guard: the write node is not in a document');
  const state = { seen: 0, blocked: 0 };
  const onTarget = () => {
    for (let i = 0; i < chain.length; i++) {
      if (chain[i][0].activeElement !== chain[i][1]) return false;
    }
    return true;
  };
  const check = (e) => {
    if (!e.isTrusted) return;
    if (e.type === 'beforeinput' && (typeof e.inputType !== 'string' || e.inputType.indexOf('insert') !== 0)) return;
    if (!onTarget()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      state.blocked++;
      return;
    }
    if (e.type === 'beforeinput') state.seen++;
  };
  win.addEventListener('beforeinput', check, true);
  win.addEventListener('textInput', check, true);
  let live = true;
  const stop = () => {
    if (!live) return;
    live = false;
    win.removeEventListener('beforeinput', check, true);
    win.removeEventListener('textInput', check, true);
  };
  const timer = setTimeout(stop, 10000);
  return {
    finish() {
      clearTimeout(timer);
      stop();
      return { seen: state.seen, blocked: state.blocked };
    },
  };
}`;

type FillGuard = {
  finish: () => Promise<void>;
  /** The node the browser says will take the text — the target itself, or the
   * field inside its (possibly closed) shadow root. The read-back reads it. */
  writeNode: number;
};

const NOTHING_TYPED = 'nothing was typed (the field may already have been cleared for the write)';

/** The insert under an armed guard. A rejected insert (the page navigated, the
 * frame went away) is reported as unconfirmed — `focus_probe_failed`, which
 * the audit redacts — never as a raw CDP error that would log the value. */
async function guardedInsert(tabId: number, guard: FillGuard, text: string): Promise<void> {
  let failed = false;
  try {
    await cdp(tabId, 'Input.insertText', { text });
  } catch {
    failed = true;
  }
  await guard.finish();
  if (failed) {
    throw new BridgeError(
      'focus_probe_failed',
      'fill: the insert failed partway (the page navigated or the frame went away) — ' +
        'whether any text landed is unknown; check the page',
    );
  }
}

/** Steps 2 and 3, armed AFTER focus() and BEFORE the insert. */
async function armFillGuard(
  tabId: number,
  target: FillTarget,
  allowPassword: boolean,
): Promise<FillGuard> {
  try {
    return await armFillGuardInner(tabId, target, allowPassword);
  } catch (e) {
    await releaseGuardGroup(tabId);
    throw e;
  }
}

async function armFillGuardInner(
  tabId: number,
  target: FillTarget,
  allowPassword: boolean,
): Promise<FillGuard> {
  const frameId = target.frameId ?? (await mainFrameId(tabId));
  const { nodes } = await cdp<{
    nodes?: Array<{
      backendDOMNodeId?: number;
      properties?: Array<{ name?: string; value?: { value?: unknown } }>;
    }>;
  }>(tabId, 'Accessibility.queryAXTree', { objectId: target.objectId });
  const focused = [
    ...new Set(
      (nodes ?? [])
        .filter((n) =>
          (n.properties ?? []).some((p) => p.name === 'focused' && p.value?.value === true),
        )
        .map((n) => n.backendDOMNodeId)
        .filter((id): id is number => typeof id === 'number'),
    ),
  ];
  if (focused.length === 0) {
    throw new BridgeError(
      'not_focusable',
      `fill: focus did not land on the target, so the text would go somewhere else — ${NOTHING_TYPED}; ` +
        'target the field itself (an input, textarea or editor)',
    );
  }
  let writeNode: number | null = null;
  for (const id of focused) {
    // By objectId: for a node in a child frame Chrome refuses a bare
    // backendNodeId once the main document has been fetched.
    const { object } = await cdp<{ object: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
      backendNodeId: id,
      objectGroup: FILL_GUARD_GROUP,
    });
    const { node } = await cdp<{ node?: unknown }>(tabId, 'DOM.describeNode', {
      objectId: object.objectId,
    });
    if (!allowPassword && domNodeIsPassword(node) !== false) {
      throw new BridgeError(
        'password_field',
        'fill: focus resolved to <input type=password> (e.g. inside a shadow root); pass ' +
          'allowPassword=true to override',
      );
    }
    if (writeNode !== null) continue;
    if (domNodeAcceptsText(node) === true || (await isEditableIsolated(tabId, frameId, id))) {
      writeNode = id;
    }
  }
  if (writeNode === null) {
    throw new BridgeError(
      'no_editable_focus',
      `fill: the focused element cannot hold text (read-only, disabled, or not a field) — ${NOTHING_TYPED}`,
    );
  }
  const isolated = await resolveIsolated(tabId, frameId, writeNode);
  const armed = await cdp<{ result?: { objectId?: string }; exceptionDetails?: unknown }>(
    tabId,
    'Runtime.callFunctionOn',
    { objectId: isolated, functionDeclaration: FILL_GUARD_FN, objectGroup: FILL_GUARD_GROUP },
  );
  // A thrown value carries an objectId too: exceptionDetails is the tell.
  const guardId = armed.exceptionDetails ? undefined : armed.result?.objectId;
  if (!guardId) {
    throw new BridgeError(
      'focus_probe_failed',
      `fill: could not guard the write — ${NOTHING_TYPED}`,
    );
  }
  return {
    writeNode,
    async finish() {
      let tally: { seen?: unknown; blocked?: unknown } | undefined;
      try {
        const out = await cdp<{
          result?: { value?: { seen?: unknown; blocked?: unknown } };
          exceptionDetails?: unknown;
        }>(tabId, 'Runtime.callFunctionOn', {
          objectId: guardId,
          functionDeclaration: 'function() { return this.finish(); }',
          returnByValue: true,
        });
        tally = out.exceptionDetails ? undefined : out.result?.value;
      } catch {
        // The page navigated or the frame went away mid-insert: where the text
        // went is unknown, which is exactly what the check below reports.
        tally = undefined;
      } finally {
        await releaseGuardGroup(tabId);
      }
      if (typeof tally?.seen !== 'number' || typeof tally.blocked !== 'number') {
        throw new BridgeError(
          'focus_probe_failed',
          'fill: the text was sent but where it went could not be confirmed — check the page',
        );
      }
      if (tally.blocked > 0) {
        throw new BridgeError(
          'focus_moved',
          'fill: focus moved off the target while typing; the text was stopped before it ' +
            `reached anything else — ${NOTHING_TYPED}`,
        );
      }
      if (tally.seen === 0) {
        throw new BridgeError(
          'focus_moved',
          'fill: the target never received the text — focus moved into another document ' +
            'while typing, so it may have gone there; check the page before retrying',
        );
      }
    },
  };
}

/** Click the node — unless the click is guaranteed to do nothing, in which case
 * say so instead of pretending.
 *
 * Two cases the browser silently swallows: a disabled form control — its own
 * `disabled` attribute, a `<fieldset disabled>` ancestor or a disabled
 * `<optgroup>`, i.e. `:disabled` (Chrome dispatches no click event at all) — and
 * a node the page has detached (`.click()` fires into a document nobody is
 * watching). SVG/MathML have no `.click()`: they get the event it would have
 * dispatched (a PointerEvent in current Chrome).
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
  let off = this.disabled === true;
  // :disabled also covers what .disabled misses: a control inside
  // <fieldset disabled> or a disabled <optgroup>. The browser dispatches no
  // click to any of them.
  try {
    if (!off && typeof this.matches === 'function') off = this.matches(':disabled');
  } catch (e) {}
  if (off) return { tag: this.tagName, blocked: 'disabled' };
  if (this.isConnected === false) return { tag: this.tagName, blocked: 'detached' };
  this.scrollIntoView({ block: 'center' });
  if (typeof this.click === 'function') {
    this.click();
  } else {
    // SVG and MathML elements have no .click(): dispatch what it would have.
    // Chrome's .click() fires a PointerEvent (pointerId -1, pointerType ''):
    // handlers that check \`instanceof PointerEvent\` must see the same.
    const view = (this.ownerDocument && this.ownerDocument.defaultView) || globalThis;
    const Ctor = view.PointerEvent || view.MouseEvent;
    this.dispatchEvent(
      new Ctor('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
        view,
        detail: 1,
        pointerId: -1,
        pointerType: '',
      }),
    );
  }
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

export const click: Tool = async (args, ctx) => {
  const selector = String(args.selector || '');
  if (!selector) throw new BridgeError('bad_args', 'click: selector required');
  const waitSpec = parseWaitFor(args.waitFor, 'click');
  const observeSpec = parseObserve(args.observe, 'click');
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  const objectId = await resolveSelectorOrRef(tab.id!, selector, 'click');
  const out = await cdp<{
    result?: { value?: ClickProbe };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>(tab.id!, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: CLICK_FN,
    returnByValue: true,
  });
  const probe = out.exceptionDetails ? undefined : out.result?.value;
  if (!probe) {
    // The click threw in the page (or gave nothing back). Defaulting to {} here
    // answered ok:true for a click that never happened.
    const why =
      out.exceptionDetails?.exception?.description?.split('\n')[0] ??
      out.exceptionDetails?.text ??
      'no result';
    throw new BridgeError(
      'error',
      // Page-controlled text: cut, then drop any half of a surrogate pair — a
      // lone one makes the whole error unsignable (protocol.ts).
      `click: the click on ${selector} did not run (${why.slice(0, 200).replace(/[\uD800-\uDFFF]/g, '')}) — try mouse_click, ` +
        `which dispatches a real pointer click`,
    );
  }
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
  const wait = waitSpec
    ? await runEmbeddedWait(tab.id!, waitSpec, ctx?.startedAt, !!observeSpec)
    : null;
  const observed = observeSpec ? await runObserve(tab.id!, observeSpec, ctx?.startedAt) : null;
  return {
    tabId: tab.id,
    url: tab.url,
    data: { ok: true, ...probe, ...(wait ? { wait } : {}), ...(observed ? { observed } : {}) },
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
    // instanceof, not tagName: an XHTML page reports 'textarea' in lower case.
    const proto = this instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement : win.HTMLInputElement;
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
/** Read the WRITE node — the one the browser reported holding focus when the
 * guard armed (`armFillGuard`), resolved by backend id, so it is the real
 * field even inside a closed shadow root or an editor frame. Earlier versions
 * guessed between the resolved node and a page-JS walk to "the focused leaf";
 * after the write that leaf can be a DIFFERENT field (a card form advancing to
 * its CVV), whose length is not ours to report.
 *
 * Content NEVER leaves: only a length and a boolean. The write node cleared the
 * password gate in `armFillGuard`, and the whole read-back is skipped when
 * `allowPassword` is set. FIXED literal; the expected text is a structured
 * callFunctionOn argument. */
export const FILL_READBACK_FN = `function(expected) {
  var v = null;
  if (this.isContentEditable) v = this.innerText || this.textContent || '';
  else if ('value' in this) v = String(this.value);
  if (v === null) return { len: 0, matched: false };
  return { len: v.length, matched: v === expected || v.indexOf(expected) !== -1 };
}`;

/** Turn the probe's two numbers into the tri-state verdict. Pure, so the one
 * judgement call here — that a non-empty field which does not contain our text
 * is `unclear`, not a failure — is pinned by a test rather than buried. */
export function classifyApplied(matched: boolean, len: number): Applied {
  if (matched) return 'yes';
  return len === 0 ? 'no' : 'unclear';
}

/** The node to read a write back from: the field the browser said took the
 * text (inside a closed shadow root page JS cannot reach), else the target. */
async function readTarget(
  tabId: number,
  fallback: string,
  writeNode: number | null,
): Promise<string> {
  if (writeNode === null) return fallback;
  try {
    const { object } = await cdp<{ object: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
      backendNodeId: writeNode,
      objectGroup: CALL_GROUP,
    });
    return object.objectId ?? fallback;
  } catch {
    return fallback;
  }
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

export const fill: Tool = async (args, ctx) => {
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
  const observeSpec = parseObserve(args.observe, 'fill');
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
  const target = await bindFillTarget(tab.id!, objectId);

  if (method === 'insertText' || target.editorFrame) {
    // Clear via the fixed function above, then type through CDP — the page
    // sees the same composition of events a real keyboard/IME produces,
    // which frameworks that ignore programmatic .value (Telegram, Slack,
    // draft.js editors) do react to.
    const prep = await cdp<{ result: { value?: { tag: string; focused?: boolean } } }>(
      tab.id!,
      'Runtime.callFunctionOn',
      { objectId: target.objectId, functionDeclaration: FILL_CLEAR_FN, returnByValue: true },
    );
    // Input.insertText writes to document.activeElement, not this node. If focus
    // did not land here, refuse — otherwise the text goes to whatever else is
    // focused (e.g. a password field the gate above never inspected), and the
    // unredacted value would be logged. Fail closed (invariant #5). Then re-check
    // the ACTUAL focused leaf: a delegatesFocus shadow host passes ensureFocusLanded
    // (activeElement retargets to the host === this) yet delegates focus to an
    // inner <input type=password> the resolved-node gate never saw.
    ensureFocusLanded(prep.result.value?.focused);
    let writeNode: number | null = null;
    if (value !== '') {
      const guard = await armFillGuard(tab.id!, target, args.allowPassword === true);
      writeNode = guard.writeNode;
      await guardedInsert(tab.id!, guard, value);
    }
    const landed =
      args.allowPassword === true || value === ''
        ? null
        : await readBackApplied(
            tab.id!,
            await readTarget(tab.id!, target.objectId, writeNode),
            value,
          );
    const insertWait = waitSpec
      ? await runEmbeddedWait(tab.id!, waitSpec, ctx?.startedAt, !!observeSpec)
      : null;
    const insertObserved = observeSpec
      ? await runObserve(tab.id!, observeSpec, ctx?.startedAt)
      : null;
    return {
      tabId: tab.id,
      url: tab.url,
      data: {
        ok: true,
        tag: prep.result.value?.tag ?? '',
        mode: 'insertText',
        ...(landed ?? {}),
        ...(insertWait ? { wait: insertWait } : {}),
        ...(insertObserved ? { observed: insertObserved } : {}),
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
    // The native setter of THIS element's own class (React-safe): the input
    // setter called on a <textarea> throws "Illegal invocation", which used to
    // fail the whole probe and read as a framework revert.
    // instanceof, not tagName: an XHTML page reports 'textarea' in lower case,
    // which would pick the <input> setter and lose the React-safe path.
    const proto = this instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    // No catch-and-assign: on a non-field (a div, a custom element) that would
    // plant an expando .value that reads back as "landed". Let it throw — the
    // insertText fallback then refuses a target that cannot take focus.
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
    let fbWriteNode: number | null = null;
    if (value !== '') {
      const guard = await armFillGuard(tab.id!, target, args.allowPassword === true);
      fbWriteNode = guard.writeNode;
      await guardedInsert(tab.id!, guard, value);
    }
    const fbLanded =
      args.allowPassword === true || value === ''
        ? null
        : await readBackApplied(tab.id!, await readTarget(tab.id!, objectId, fbWriteNode), value);
    const fbWait = waitSpec
      ? await runEmbeddedWait(tab.id!, waitSpec, ctx?.startedAt, !!observeSpec)
      : null;
    const fbObserved = observeSpec ? await runObserve(tab.id!, observeSpec, ctx?.startedAt) : null;
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
        ...(fbObserved ? { observed: fbObserved } : {}),
      },
    };
  }
  const wait = waitSpec
    ? await runEmbeddedWait(tab.id!, waitSpec, ctx?.startedAt, !!observeSpec)
    : null;
  const observed = observeSpec ? await runObserve(tab.id!, observeSpec, ctx?.startedAt) : null;
  return {
    tabId: tab.id,
    url: tab.url,
    data: {
      ok: true,
      tag: res.tag,
      mode: res.mode,
      ...(wait ? { wait } : {}),
      ...(observed ? { observed } : {}),
    },
  };
};

/** An empty whole-page read, with the frames that might explain it.
 *
 * `text: ''` on its own is the least informative answer the tool can give, and
 * it is exactly what a framed page produces. */
async function emptyRead(tab: chrome.tabs.Tab): Promise<Record<string, unknown>> {
  const frames = await pageFrameOrigins(tab.id!);
  return { text: '', ...(frames.length ? { frames } : {}) };
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
    // Same resolve, same classification as every other tool — this branch used
    // to hand-roll it and drift.
    const objectId = await resolveBackendNode(tab.id!, r.backendDOMNodeId, args.ref, 'read_text');
    const out = await cdp<{ result: { value?: string } }>(tab.id!, 'Runtime.callFunctionOn', {
      objectId,
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
  if (!bodyQ.nodeId) return { tabId: tab.id, url: tab.url, data: await emptyRead(tab) };
  const resolved = await cdp<{ object: { objectId?: string } }>(tab.id!, 'DOM.resolveNode', {
    nodeId: bodyQ.nodeId,
    objectGroup: CALL_GROUP,
  });
  if (!resolved.object.objectId) {
    return { tabId: tab.id, url: tab.url, data: await emptyRead(tab) };
  }
  const out = await cdp<{ result: { value?: string } }>(tab.id!, 'Runtime.callFunctionOn', {
    objectId: resolved.object.objectId,
    functionDeclaration: READ_TEXT_FN,
    returnByValue: true,
  });
  // What this read could NOT see. The body probe does not cross a frame
  // boundary, so a page whose real content is framed — a checkout, an SSO step,
  // an embedded dashboard — comes back as the shell's text, or as nothing at
  // all, with no reason given. `snapshot` learned to say so; this is the tool an
  // agent reaches for FIRST, so the silence was more expensive here.
  // Whole-page reads only: a `ref` read is explicitly about one node.
  const frames = await pageFrameOrigins(tab.id!);
  return {
    tabId: tab.id,
    url: tab.url,
    data: {
      ...capText(out.result.value ?? '', maxChars, offset),
      ...(frames.length ? { frames } : {}),
    },
  };
};
