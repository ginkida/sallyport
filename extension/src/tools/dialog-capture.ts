/** Per-tab auto-handling + capture of native JS dialogs
 * (alert / confirm / prompt / beforeunload).
 *
 * Closes an automation dead-end: an open JS dialog FREEZES the page's JS —
 * every subsequent evaluate-backed probe (waits, clicks, snapshots' DOM
 * fallback) hangs to its timeout — and the dialog itself is native browser UI
 * that no CDP input event can click. Worse, in broker mode the dialog pops in
 * the dedicated non-focused agent window where the human isn't looking. With
 * handling on, every dialog is answered immediately by policy and recorded;
 * `handle_dialog` (dialog.ts) reads the record and lets an agent ARM the
 * response for the next dialog (accept a confirm(), type into a prompt())
 * before triggering it.
 *
 * Security shape — the THIRD `chrome.debugger.onEvent` surface (sibling of
 * console-capture.ts / network-capture.ts), same conservative rules:
 *  - OPT-IN: only runs when the popup setting `handleDialogs` is on (default
 *    off); `ensureDialogCapture` is called from `attach()` ONLY then, so the
 *    unconditional attach hot-path never widens the CDP footprint. Structured
 *    CDP only (`Page.enable` + `Page.handleJavaScriptDialog`) — no JS eval,
 *    no interpolation (#4): an armed `promptText` travels as a structured
 *    protocol argument.
 *  - SAFE DEFAULTS: alert → accept (OK is its only button), everything else →
 *    dismiss (confirm() sees cancel, prompt() sees null, beforeunload stays on
 *    the page). Escalation — accepting a confirm/beforeunload — is a per-dialog
 *    one-shot armed through the allowlist-gated tool, never sticky.
 *  - ORIGIN-BOUND ARMING: the one-shot is tagged with the origin `handle_dialog`
 *    was allowlist-checked against when it armed. It only fires for a dialog
 *    from that SAME origin (fail-closed on an unresolvable dialog origin) — a
 *    cross-origin iframe (ad, embed) on the same tab can't consume an escalated
 *    accept/promptText meant for a different page. A non-matching dialog gets
 *    the safe default and leaves the arm untouched for the dialog it was
 *    actually meant for. Origin-binding alone doesn't cover an arm that never
 *    met ITS dialog and the tab later returns to the SAME origin for unrelated
 *    work — `clearArmedDialog` (called from navigate/reload/history_go
 *    alongside ref invalidation) additionally drops a pending arm on any
 *    navigation, so it can't outlive the page it was set on.
 *  - LIVE OFF-SWITCH: unchecking the popup setting actively revokes handling
 *    (`Page.disable` + drops any pending arm) on every already-enabled tab —
 *    UNCONDITIONALLY, the same shape as keep-awake's `releaseKeepAwake`, so an
 *    MV3 service-worker restart (which wipes the ephemeral `enabledTabs` this
 *    module tracks, while the underlying `chrome.debugger` session survives)
 *    can't silently defeat the off-switch. The acting surface must not stay
 *    live after the human opts back into answering dialogs themselves.
 *  - BOUNDED: per-tab ring of ≤20 entries × ≤512-char message (#6 fine);
 *  - PER-TAB + CLEARED on `tabs.onRemoved`/`debugger.onDetach` (#7 untouched);
 *  - ORIGIN-TAGGED: each entry records the dialog's frame origin and
 *    `handle_dialog` filters reads to the allowlist (#3), fail-closed on an
 *    unknown origin — a tab can navigate cross-origin while buffering.
 *
 * The pure helpers (response policy, arg parsing, entry shaping, origin
 * filter) are `chrome.*`-free so vitest drives them directly; the thin event
 * wiring is covered on the wire by the e2e harness — the same split the other
 * capture modules use.
 */

import { BridgeError } from './errors.js';
import { originFromStackUrl, pushCapped } from './console-capture.js';

export const DIALOG_MAX_ENTRIES = 20;
export const DIALOG_MAX_MESSAGE = 512;
export const DIALOG_MAX_PROMPT_TEXT = 2048;

/** What we answered a dialog with (the CDP `Page.handleJavaScriptDialog`
 * arguments). `promptText` only ever rides an accepted prompt(). */
export interface DialogResponse {
  accept: boolean;
  promptText?: string;
}

/** An armed one-shot: the response plus the origin it was allowlist-checked
 * against at arm time — the binding `decideDialogResponse` enforces before
 * ever applying it to an opening dialog. */
export interface ArmedDialog {
  response: DialogResponse;
  origin: string | null;
}

export interface DialogEntry {
  ts: number;
  /** CDP dialog type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
   * (kept as the raw wire string so an unknown future type is visible,
   * not mislabelled). */
  type: string;
  message: string;
  /** Origin of the frame that opened the dialog, or null when it could not be
   * determined — null entries are dropped at read time (fail-closed). */
  origin: string | null;
  response: DialogResponse;
  /** True when an agent-armed one-shot (not the default policy) produced the
   * response. */
  armed: boolean;
}

/** Default answer when nothing is armed: alert has only OK, so accepting is
 * the sole way to close it; every other type gets the safe "cancel" —
 * confirm() → false, prompt() → null, beforeunload → stay on the page. An
 * unknown future type falls in the dismiss bucket. Pure. */
export function defaultDialogResponse(type: string): DialogResponse {
  return { accept: type === 'alert' };
}

/** Resolve the response for an opening dialog from an (optional) armed
 * one-shot. ORIGIN-BOUND (invariant #3): the arm only applies when the
 * dialog's origin matches the origin it was allowlist-checked against at arm
 * time — fail-closed when either origin is unresolvable (`null` never
 * matches `null`), so a cross-origin iframe or a tab that has since navigated
 * elsewhere can't hijack an escalated accept/promptText meant for a different
 * page. A non-matching dialog falls through to the safe default AND does not
 * consume the arm, leaving it live for the dialog it was actually meant for.
 * Alerts are always accepted when the arm DOES apply — accept is their only
 * meaningful answer, so an armed dismiss must not wedge into a nonsensical
 * reply. `promptText` is honoured only on an accepted prompt(); on any other
 * type it is dropped rather than sent (the protocol ignores it there, and
 * recording it would misdescribe what happened). Pure. */
export function decideDialogResponse(
  armed: ArmedDialog | undefined,
  type: string,
  dialogOrigin: string | null,
): { response: DialogResponse; armed: boolean } {
  if (!armed || dialogOrigin === null || armed.origin !== dialogOrigin) {
    return { response: defaultDialogResponse(type), armed: false };
  }
  if (type === 'alert') return { response: { accept: true }, armed: true };
  const response: DialogResponse = { accept: armed.response.accept };
  if (type === 'prompt' && armed.response.accept && armed.response.promptText !== undefined) {
    response.promptText = armed.response.promptText;
  }
  return { response, armed: true };
}

export interface DialogEventParams {
  message?: string;
  type?: string;
  url?: string;
}

/** Shape a `Page.javascriptDialogOpening` event + the response we gave into a
 * ring entry. Message capped, origin extracted from the frame URL (null on
 * anything opaque — dropped at read time). Pure. */
export function shapeDialogEntry(
  params: DialogEventParams,
  response: DialogResponse,
  armed: boolean,
  ts: number,
): DialogEntry {
  const raw = typeof params.message === 'string' ? params.message : '';
  return {
    ts,
    type: typeof params.type === 'string' ? params.type : '',
    message: raw.length > DIALOG_MAX_MESSAGE ? raw.slice(0, DIALOG_MAX_MESSAGE) : raw,
    origin: originFromStackUrl(params.url),
    response,
    armed,
  };
}

export interface DialogArgs {
  action?: 'accept' | 'dismiss';
  promptText?: string;
  limit: number;
}

/** Parse `handle_dialog`'s args. `action` arms a one-shot for the tab's next
 * dialog; `promptText` is only meaningful on an accept (a dismissed prompt()
 * returns null regardless, so accepting text on a dismiss would silently lie).
 * Pure, fail-fast on anything malformed. */
export function parseDialogArgs(args: Record<string, unknown>): DialogArgs {
  const out: DialogArgs = { limit: DIALOG_MAX_ENTRIES };
  const action = args.action;
  if (action !== undefined && action !== null) {
    if (action !== 'accept' && action !== 'dismiss') {
      throw new BridgeError('bad_args', "handle_dialog: action must be 'accept' or 'dismiss'");
    }
    out.action = action;
  }
  const promptText = args.promptText;
  if (promptText !== undefined && promptText !== null) {
    if (typeof promptText !== 'string') {
      throw new BridgeError('bad_args', 'handle_dialog: promptText must be a string');
    }
    if (out.action !== 'accept') {
      throw new BridgeError('bad_args', "handle_dialog: promptText requires action:'accept'");
    }
    if (promptText.length > DIALOG_MAX_PROMPT_TEXT) {
      throw new BridgeError(
        'bad_args',
        `handle_dialog: promptText too long (max ${DIALOG_MAX_PROMPT_TEXT} chars)`,
      );
    }
    out.promptText = promptText;
  }
  const limit = args.limit;
  if (limit !== undefined && limit !== null) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) {
      throw new BridgeError('bad_args', 'handle_dialog: limit must be a positive integer');
    }
    out.limit = Math.min(n, DIALOG_MAX_ENTRIES);
  }
  return out;
}

/** The armed one-shot as the tool result reports it (`null` when nothing is
 * armed) — action strings, not the raw accept boolean, so the result mirrors
 * the arguments the agent sent. Pure. */
export function describeArmed(
  armed: DialogResponse | undefined,
): { action: 'accept' | 'dismiss'; promptText?: string } | null {
  if (!armed) return null;
  return {
    action: armed.accept ? 'accept' : 'dismiss',
    ...(armed.promptText !== undefined ? { promptText: armed.promptText } : {}),
  };
}

// --- chrome-bound state + wiring -------------------------------------------

const buffers = new Map<number, DialogEntry[]>();
const enabledTabs = new Set<number>();
const armedByTab = new Map<number, ArmedDialog>();

async function onDebuggerEvent(
  source: { tabId?: number },
  method: string,
  params?: unknown,
): Promise<void> {
  if (source.tabId === undefined || method !== 'Page.javascriptDialogOpening') return;
  const tabId = source.tabId;
  const p = (params ?? {}) as DialogEventParams;
  const oneShot = armedByTab.get(tabId);
  const dialogOrigin = originFromStackUrl(p.url);
  const { response, armed } = decideDialogResponse(oneShot, String(p.type ?? ''), dialogOrigin);
  // Only consume the arm when it actually applied — an origin mismatch (a
  // decoy dialog from another frame) must leave it live for the dialog it was
  // meant for.
  if (armed) armedByTab.delete(tabId);
  // Answer FIRST — the page's JS is frozen until the dialog is handled.
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', {
      accept: response.accept,
      ...(response.promptText !== undefined ? { promptText: response.promptText } : {}),
    });
  } catch {
    // tab gone, or the user beat us to the native dialog — record regardless,
    // the entry documents what we TRIED to answer.
  }
  const buf = buffers.get(tabId) ?? [];
  pushCapped(buf, shapeDialogEntry(p, response, armed, Date.now()), DIALOG_MAX_ENTRIES);
  buffers.set(tabId, buf);
}

// Registered once. Guarded so importing this module in vitest (no chrome) just
// loads the pure helpers without demanding the API. A third onEvent listener
// alongside console-capture's and network-capture's — each filters by method,
// so they coexist without routing.
if (typeof chrome !== 'undefined' && chrome.debugger?.onEvent) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    void onDebuggerEvent(source, method, params);
  });
}

/** Idempotently turn on dialog handling for a tab. Issues `Page.enable`
 * (which makes `Page.javascriptDialogOpening` fire) at most once per tab.
 * Called from `attach()` ONLY when the handleDialogs setting is on. Uses
 * `chrome.debugger.sendCommand` directly to avoid an import cycle with
 * cdp.ts. Best-effort: a failure drops the flag so a later attach retries and
 * never breaks the tool call. */
export async function ensureDialogCapture(tabId: number): Promise<void> {
  if (enabledTabs.has(tabId)) return;
  enabledTabs.add(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  } catch {
    enabledTabs.delete(tabId);
  }
}

/** Turn dialog handling back OFF for a tab — the `handleDialogs` off-switch
 * (mirrors `cdp.ts:releaseKeepAwake`'s shape). Runs every `attach()` call when
 * the setting is off.
 *
 * UNCONDITIONAL, deliberately NOT gated on "does `enabledTabs` still remember
 * this tab" — exactly like `releaseKeepAwake`. `enabledTabs` is ephemeral
 * module state that an MV3 service-worker restart wipes, while the
 * `chrome.debugger` session (and whatever CDP domains it enabled) survives
 * that restart — `attach()`'s own "already attached" catch exists BECAUSE of
 * this. A gated revoke would silently no-op after a restart: the user
 * unchecks the setting, `enabledTabs.has(tabId)` reads false on the fresh
 * Set, `Page.disable` never fires, and dialogs keep getting auto-answered
 * forever — exactly the bug this function exists to prevent, just deferred to
 * the next SW restart instead of never happening. `Page.disable` is
 * idempotent (a harmless no-op on a tab where it was never enabled), so the
 * unconditional call costs nothing on the common path. Actively stops
 * `javascriptDialogOpening` from firing at all — dialogs go back to native,
 * human-clickable behaviour — and drops any pending arm: an escalated
 * one-shot must not survive the human opting back into answering dialogs
 * themselves. */
export async function releaseDialogCapture(tabId: number): Promise<void> {
  enabledTabs.delete(tabId);
  armedByTab.delete(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.disable');
  } catch {
    // tab gone, or already disabled — nothing to revoke
  }
}

/** Drop a tab's buffer + enabled flag + armed one-shot — wired into
 * tabs.onRemoved / debugger.onDetach (cdp.ts) so state never outlives the
 * tab. */
export function clearDialogs(tabId: number): void {
  buffers.delete(tabId);
  enabledTabs.delete(tabId);
  armedByTab.delete(tabId);
}

/** Drop ONLY a tab's pending arm (buffer/capture state untouched) — wired
 * into navigate/reload/history_go (tabs.ts / history.ts) alongside
 * `clearRefsForTab`. Origin-binding alone stops a CROSS-origin dialog from
 * hijacking an arm, but an arm that never met the dialog it was meant for
 * would otherwise sit live indefinitely and could silently fire on a later,
 * unrelated SAME-origin dialog once the tab happens to return there — an arm
 * is scoped to intent for the page it was set on, not a standing grant that
 * survives the agent moving on to other work. */
export function clearArmedDialog(tabId: number): void {
  armedByTab.delete(tabId);
}

/** Arm a one-shot response for the tab's next dialog (replacing any pending
 * one), bound to `origin` — the origin `handle_dialog` allowlist-checked at
 * arm time. Only reachable through the allowlist-gated `handle_dialog` tool. */
export function armDialog(tabId: number, response: DialogResponse, origin: string | null): void {
  armedByTab.set(tabId, { response, origin });
}

/** The currently armed one-shot's response, if any (origin stripped — callers
 * outside this module only need what it will answer with). */
export function getArmedDialog(tabId: number): DialogResponse | undefined {
  return armedByTab.get(tabId)?.response;
}

/** Snapshot a tab's captured entries (a copy, oldest→newest). */
export function readDialogs(tabId: number): DialogEntry[] {
  return [...(buffers.get(tabId) ?? [])];
}
