/** `get_state` — a cheap single-element liveness/visibility/box/text probe.
 *
 * The dominant cost in an automation loop is verification: after every action
 * the only way to ask "is @e5 still there / visible / did its text change /
 * where is it now" was to re-snapshot the whole 2000-node tree (tens of KB, a
 * full @eN ref-space reset) and re-find the element. `get_state` answers that
 * in one tiny round-trip and — critically — NEVER throws for a vanished node:
 * a missing element is {exists:false, reason}, a pollable signal, instead of
 * the bad_ref / not_found error that ends a poll loop.
 *
 * Security shape:
 *  - allowlist-gated (#3) via ensureAllowed, like every page-touching tool;
 *  - reads through a FIXED function literal (ELEMENT_STATE_FN) with the cap as
 *    the ONLY argument, carried as a structured callFunctionOn value, never
 *    interpolated — the same trust shape as read_text's READ_TEXT_FN / the aim
 *    probes, so it needs no per-domain evaluate flag (#4);
 *  - reads NO live field `.value` — only getBoundingClientRect geometry and
 *    innerText/textContent (an <input>'s text content is empty), so it opens no
 *    password-readback channel (#5);
 *  - mints NO refs — getRef only reads the per-tab map (#7);
 *  - fails closed: any resolve/probe failure reports {exists:false}, so a node
 *    that died mid-call can never masquerade as visible.
 */

import { attach, cdp, looksLikeSelectorSyntaxError } from './cdp.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { getRef, isRef, type RefInfo } from './refs.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

// get_state's text is for change-detection / a quick label read, NOT a
// full-page dump — read_text owns that. Default small, capped so the in-page
// slice (and therefore the returnByValue transfer) stays bounded even if the
// target is <body>.
const DEFAULT_STATE_MAX_CHARS = 2_000;
const MAX_STATE_MAX_CHARS = 20_000;

// A post-action check is rarely one assertion — "the dialog is gone AND the row
// appeared AND Save is enabled" is three, and one per call meant three model
// turns to verify a single click. Batching them is the cheapest round-trip
// saving in the toolset. Capped because each entry is its own CDP resolve+probe
// pair and the result has to stay small enough to be worth reading.
const MAX_STATE_SELECTORS = 10;

/** Parse get_state's `selector`: one CSS selector / @eN, or a batch of up to
 * MAX_STATE_SELECTORS of them. Returns the list plus whether the caller asked
 * in the scalar form, because the two answer shapes differ (a single state
 * object vs `{elements:[…]}`) and the scalar one must stay byte-compatible.
 * Pure, so the validation is unit-testable without chrome. */
export function parseStateSelectors(raw: unknown): { selectors: string[]; batch: boolean } {
  if (typeof raw === 'string') {
    if (!raw) throw new BridgeError('bad_args', 'get_state: selector required');
    return { selectors: [raw], batch: false };
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new BridgeError('bad_args', 'get_state: selector array must not be empty');
    }
    if (raw.length > MAX_STATE_SELECTORS) {
      throw new BridgeError(
        'bad_args',
        `get_state: at most ${MAX_STATE_SELECTORS} selectors per call (got ${raw.length})`,
      );
    }
    const selectors = raw.map((s, i) => {
      if (typeof s !== 'string' || s === '') {
        throw new BridgeError('bad_args', `get_state: selector[${i}] must be a non-empty string`);
      }
      return s;
    });
    return { selectors, batch: true };
  }
  throw new BridgeError(
    'bad_args',
    'get_state: selector required — a CSS selector or @eN, or an array of up to ' +
      `${MAX_STATE_SELECTORS} of them`,
  );
}

/** Parse + validate get_state's `maxChars` (capped at MAX_STATE_MAX_CHARS).
 * Pure, so the cap and rejections are unit-testable without chrome — mirrors
 * dom.ts:parseMaxChars / poll.ts:parseMaxSteps. */
export function parseStateMaxChars(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_STATE_MAX_CHARS;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1) {
    throw new BridgeError('bad_args', 'get_state: maxChars must be an integer >= 1');
  }
  return Math.min(v, MAX_STATE_MAX_CHARS);
}

// FIXED literal — `cap` is the only input and travels as a STRUCTURED
// callFunctionOn argument, NEVER interpolated into the body; `this` is the
// resolved element. Reads geometry + innerText/textContent only — never
// `this.value` — so no field content leaks (invariant #5). The text is sliced
// in-page so a huge element (a <body> ref) can't blow the transfer; `textLen`
// preserves the truncation signal without shipping the whole string. Same
// trust shape as read_text's READ_TEXT_FN.
export const ELEMENT_STATE_FN = `function(cap) {
  var r = this.getBoundingClientRect();
  var win = this.ownerDocument ? this.ownerDocument.defaultView : null;
  var t = (this.innerText || this.textContent || '').trim();
  return {
    tag: this.tagName || '',
    textLen: t.length,
    text: t.length > cap ? t.slice(0, cap) : t,
    x: r.left, y: r.top, width: r.width, height: r.height,
    inViewport: !!win && r.bottom > 0 && r.right > 0 &&
                r.top < win.innerHeight && r.left < win.innerWidth
  };
}`;

export type RawElementState = {
  tag: string;
  textLen: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  inViewport: boolean;
};

export type ElementState = {
  exists: true;
  visible: boolean;
  tag: string;
  text: string;
  truncated?: true;
  textLen?: number;
  box?: { x: number; y: number; width: number; height: number };
  inViewport?: boolean;
};

/** Shape the raw in-page probe reading into the tool result. Pure, so the
 * visible-derivation, box rounding and truncation marker are unit-testable
 * without chrome.
 *
 * `visible` mirrors poll.ts:selectorVisible / wait_for's notion of visible: a
 * laid-out box with width AND height > 0 (display:none → zero rect → false;
 * visibility:hidden still occupies layout → true, same as getBoxModel). `box`
 * and `inViewport` are reported only when visible — a hidden element has no
 * meaningful geometry. Coordinates are viewport-relative CSS px (the same
 * frame mouse_click's x/y use), rounded to integers. */
export function shapeElementState(raw: RawElementState): ElementState {
  const visible = raw.width > 0 && raw.height > 0;
  const out: ElementState = {
    exists: true,
    visible,
    tag: (raw.tag || '').toLowerCase(),
    text: raw.text,
  };
  if (raw.textLen > raw.text.length) {
    out.truncated = true;
    out.textLen = raw.textLen;
  }
  if (visible) {
    out.box = {
      x: Math.round(raw.x),
      y: Math.round(raw.y),
      width: Math.round(raw.width),
      height: Math.round(raw.height),
    };
    out.inViewport = raw.inViewport === true;
  }
  return out;
}

type AbsentState = {
  exists: false;
  reason: 'unknown_ref' | 'detached' | 'not_found';
  ref?: string;
};

/** Resolve a selector/@eN to a live objectId WITHOUT throwing on absence.
 * Returns the objectId on success, or an {exists:false} payload describing why
 * the element isn't there — the whole point of get_state is that a vanished
 * node is a pollable answer, not an error. An invalid CSS selector is the one
 * thing that DOES throw (bad_args): it's a permanent agent mistake, so retrying
 * the poll can never help. */
async function resolveForState(
  tabId: number,
  selector: string,
  ref: string | undefined,
  refInfo: RefInfo | null,
  documentRoot: () => Promise<number>,
): Promise<{ objectId: string } | AbsentState> {
  if (isRef(selector)) {
    if (!refInfo) return { exists: false, reason: 'unknown_ref', ref };
    let objectId: string | null = null;
    try {
      const resolved = await cdp<{ object: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
        backendNodeId: refInfo.backendDOMNodeId,
      });
      objectId = resolved.object.objectId ?? null;
    } catch {
      objectId = null;
    }
    return objectId ? { objectId } : { exists: false, reason: 'detached', ref };
  }

  const root = await documentRoot();
  let nodeId = 0;
  try {
    const q = await cdp<{ nodeId: number }>(tabId, 'DOM.querySelector', { nodeId: root, selector });
    nodeId = q.nodeId;
  } catch (e) {
    // Only genuinely malformed CSS is the agent's permanent mistake. This used
    // to be a blanket catch, which relabelled every transient CDP rejection —
    // a wedged renderer, a node binding that went away — as `bad_args`
    // (retryable=no), telling the agent to rewrite a selector that was fine.
    if (looksLikeSelectorSyntaxError(e)) {
      throw new BridgeError('bad_args', `get_state: invalid selector: ${selector}`);
    }
    // Anything else: we have no answer, so say so rather than inventing one.
    // {exists:false} would be a positive claim — and "is the modal gone? yes"
    // is exactly the wrong way to be wrong here.
    throw e;
  }
  if (!nodeId) return { exists: false, reason: 'not_found' };
  let objectId: string | null = null;
  try {
    const resolved = await cdp<{ object: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
      nodeId,
    });
    objectId = resolved.object.objectId ?? null;
  } catch {
    objectId = null;
  }
  return objectId ? { objectId } : { exists: false, reason: 'detached' };
}

/** Everything `get_state` reports about ONE selector. Never throws for an
 * absent node (that is the tool's whole point); an invalid CSS selector is the
 * one exception, and it is a permanent agent mistake rather than a page state. */
async function probeOne(
  tabId: number,
  selector: string,
  maxChars: number,
  documentRoot: () => Promise<number>,
): Promise<Record<string, unknown>> {
  const ref = isRef(selector)
    ? '@' + (selector.startsWith('@') ? selector.slice(1) : selector)
    : undefined;
  const refInfo = isRef(selector) ? getRef(tabId, selector) : null;

  const resolved = await resolveForState(tabId, selector, ref, refInfo, documentRoot);
  if ('exists' in resolved) return resolved;

  // Probe the live node. A failure here means it died between resolve and call
  // (SPA re-render) — fail closed to {exists:false}, never report visible.
  let raw: RawElementState | null = null;
  try {
    const out = await cdp<{ result: { value?: RawElementState } }>(
      tabId,
      'Runtime.callFunctionOn',
      {
        objectId: resolved.objectId,
        functionDeclaration: ELEMENT_STATE_FN,
        arguments: [{ value: maxChars }],
        returnByValue: true,
      },
    );
    raw = out.result.value ?? null;
  } catch {
    raw = null;
  }
  if (!raw) return { exists: false, reason: 'detached', ...(ref ? { ref } : {}) };

  return {
    ...shapeElementState(raw),
    ...(ref ? { ref } : {}),
    ...(refInfo ? { role: refInfo.role, name: refInfo.name } : {}),
  };
}

/** The tab's document root, fetched at most ONCE per get_state call and shared
 * by every selector in a batch.
 *
 * Load-bearing, not a micro-optimisation. Chromium's
 * `InspectorDOMAgent::getDocument` calls `DiscardFrontendBindings()`, which
 * throws away every nodeId the agent has handed out so far — that is why
 * Puppeteer and Playwright cache the document rather than re-fetching it. Each
 * probe fetching its own root would therefore invalidate the roots (and the
 * queried nodeIds) of the probes around it, and the failure surfaces as
 * "Could not find node with given id" on a selector that was perfectly valid.
 *
 * Lazily memoised so an all-@eN call issues no `DOM.getDocument` at all: refs
 * resolve by browser-owned backendNodeId and never touch the nodeId map. */
function documentRootOnce(tabId: number): () => Promise<number> {
  let pending: Promise<number> | null = null;
  return () => {
    pending ??= cdp<{ root: { nodeId: number } }>(tabId, 'DOM.getDocument', { depth: 0 }).then(
      (d) => d.root.nodeId,
    );
    return pending;
  };
}

export const getState: Tool = async (args) => {
  const { selectors, batch } = parseStateSelectors(args.selector);
  const maxChars = parseStateMaxChars(args.maxChars);
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  const tabId = tab.id!;
  const documentRoot = documentRootOnce(tabId);

  if (!batch) {
    const data = await probeOne(tabId, selectors[0], maxChars, documentRoot);
    return { tabId, url: tab.url, data };
  }
  // SEQUENTIALLY, deliberately. What the batch buys is the one MCP call it
  // replaces — a whole model turn. Running the probes concurrently on top of
  // that would save tens of milliseconds of CDP latency while interleaving
  // commands against one tab's shared DOM-agent state, which is precisely what
  // invariant #8's per-tab serialisation exists to prevent; no other tool in
  // this codebase does it, and nothing here can test it (the chrome-bound paths
  // are outside vitest). The shared document root above already removes the
  // bulk of the round-trips a naive loop would spend.
  const elements: Array<Record<string, unknown>> = [];
  for (const selector of selectors) {
    elements.push({ selector, ...(await probeOne(tabId, selector, maxChars, documentRoot)) });
  }
  return { tabId, url: tab.url, data: { elements } };
};
