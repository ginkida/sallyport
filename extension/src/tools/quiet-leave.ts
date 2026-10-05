/** Leaving an AGENT tab without a "Leave site?" / "Close site?" prompt.
 *
 * A page with a `beforeunload` handler that has seen a user gesture — and an
 * agent's click or fill IS one, CDP input carries real activation — makes
 * Chrome ask before the page goes away. That prompt is browser UI, and to show
 * it Chrome ACTIVATES the tab and FOCUSES its window (measured, Chrome 154:
 * `tabs.onActivated` + `windows.onFocusChanged` within ~15 ms of the request,
 * whether or not a CDP client handles the dialog — `Page.handleJavaScriptDialog`
 * lands only after the window is already raised). On macOS a focused window
 * means the whole Chrome app comes to the front: the human, working somewhere
 * else, is yanked into an agent window they never asked to see and has to click
 * "Close" for the agent to continue. Until they do, `chrome.tabs.remove` never
 * resolves and the navigation never happens.
 *
 * So for a tab the agent itself owns, nothing here ANSWERS the prompt — that is
 * too late — it makes sure the prompt is never raised:
 *  - closing: `Target.closeTarget` on the tab's own target. Chrome closes the
 *    page without running `beforeunload` (unload/pagehide still run) — the
 *    same thing Puppeteer's `page.close()` does by default.
 *  - navigating (navigate/reload/history_go in place): the main frame's
 *    `beforeunload` listeners are removed right before the navigation, found
 *    with `DOMDebugger.getEventListeners` and removed through fixed function
 *    literals with the handler passed as a structured argument — no agent
 *    input reaches the page (invariant #4's shape). If the navigation then
 *    stays in the SAME document (a `#hash`, a pushState history entry), they
 *    are put back (`rearmIfSameDocument`) — the page keeps its leave guard.
 *    CDP has no "navigate without beforeunload" and no way to suppress the
 *    native dialog; registering a stopping listener from an isolated world
 *    does not work either (window listeners run in registration order, so the
 *    page's own ones already ran).
 *
 * WHO it applies to is the point: `mayLeaveQuietly` — a tab the agent CREATED
 * (a minted epoch) that the human has NOT engaged with. A human tab — the
 * standalone active-tab fallback, anything without an epoch — and an agent tab
 * the human activated or dragged into their own window keep Chrome's prompt:
 * there it may be guarding something a PERSON typed. Skipping `beforeunload`
 * also skips whatever else the page did in it (a last-moment draft save); for
 * a page only an agent was driving, leaving is what the agent asked for.
 *
 * Every step is best-effort and bounded: anything that fails falls back to the
 * plain path (`chrome.tabs.remove`, or navigating with the listeners in place),
 * i.e. at worst today's behaviour, never a refusal. */

import { budgetLeft, raceDeadline } from './budget.js';
import { CALL_GROUP, cdp, isAttached, onSessionDetached } from './cdp.js';
import { agentTabRecord, isBrokerMode } from './ownership.js';
import { mainFrameLoaderId } from './resolve.js';

/** How long a quiet close waits for the tab to be reported gone before
 * falling back. `Target.closeTarget` is answered by the browser, not the
 * renderer, and the removal follows within milliseconds. */
export const QUIET_CLOSE_CONFIRM_MS = 1_000;

/** Ceiling on removing (or restoring) a page's beforeunload listeners around a
 * navigation. They are renderer-answered, so a page frozen on an `alert()`
 * never answers — and the navigation must still go ahead. */
export const DISARM_DEADLINE_MS = 1_500;

/** May this tab be closed or navigated away from without Chrome's beforeunload
 * prompt? Only an agent-created tab (epoch minted) the human has not engaged
 * with. Fail-closed: no record ⇒ no. */
export function mayCloseQuietly(tabId: number): boolean {
  const rec = agentTabRecord(tabId);
  return rec !== undefined && !rec.human;
}

/** The navigation-side gate: same rule, and only while the daemon runs as a
 * broker — standalone has no agent tabs, and an epoch left over from an
 * earlier broker session must not change how a standalone navigate behaves. */
export function mayLeaveQuietly(tabId: number): boolean {
  return isBrokerMode() && mayCloseQuietly(tabId);
}

/** tabId → its PAGE target id. Only `type === 'page'`: a frame or worker target
 * reporting the same tabId must never be the one closed. A batch close looks
 * this up once and passes it to every `closeAgentTab`. Never throws. */
export type PageTargets = Map<number, string>;

export async function pageTargets(): Promise<PageTargets> {
  const out: PageTargets = new Map();
  try {
    for (const t of await chrome.debugger.getTargets()) {
      if (t.type === 'page' && typeof t.tabId === 'number' && !out.has(t.tabId)) {
        out.set(t.tabId, t.id);
      }
    }
  } catch {
    // API unavailable — no quiet route for anyone
  }
  return out;
}

/** Resolves true once `tabs.onRemoved` reports `tabId`, false after `ms`.
 * Subscribed before the close is sent, so a fast removal is never missed. */
function watchRemoval(tabId: number): { gone: (ms: number) => Promise<boolean>; stop: () => void } {
  let fire: (() => void) | undefined;
  let removed = false;
  const listener = (id: number) => {
    if (id !== tabId) return;
    removed = true;
    fire?.();
  };
  chrome.tabs.onRemoved.addListener(listener);
  return {
    gone: (ms) =>
      removed
        ? Promise.resolve(true)
        : new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(removed), ms);
            fire = () => {
              clearTimeout(timer);
              resolve(true);
            };
          }),
    stop: () => chrome.tabs.onRemoved.removeListener?.(listener),
  };
}

async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

function messageOf(e: unknown): string {
  return String((e as Error)?.message ?? e);
}

/** What `closeAgentTab` did: closed without beforeunload, closed with the
 * plain `chrome.tabs.remove` (prompt possible), or — `quietOnly` — left open. */
export type CloseOutcome = 'quiet' | 'removed' | 'kept';

/** Close a tab the way it deserves — the ONE place that policy lives (close_tab,
 * the reaper, `_release_tabs`, the popup sweep).
 *
 * `mayCloseQuietly` (an agent tab the human has not engaged with) → closed
 * without its beforeunload handlers, so no prompt is raised and nothing is
 * activated or focused; if the quiet route is unavailable (no debugger
 * foothold — DevTools holds the tab, a page extensions may not debug) the
 * plain removal runs. Anything else → `chrome.tabs.remove`, Chrome's prompt
 * intact: it may guard something a person typed.
 *
 * `quietOnly` (the reaper): never the plain removal. A housekeeping close that
 * raised a prompt would be the very focus theft this exists to prevent, so a
 * tab that cannot go quietly is `kept` — evicted another time, or swept by the
 * human. `targets` lets a batch share one `getTargets` lookup.
 *
 * A tab that no longer exists rejects like `chrome.tabs.remove` does (or is
 * `kept` under `quietOnly`). */
export async function closeAgentTab(
  tabId: number,
  opts: { quietOnly?: boolean; targets?: PageTargets } = {},
): Promise<CloseOutcome> {
  if (mayCloseQuietly(tabId) && (await tryQuietClose(tabId, opts.targets))) return 'quiet';
  if (opts.quietOnly) return 'kept';
  await chrome.tabs.remove(tabId);
  return 'removed';
}

/** The quiet route alone: true once the tab is gone. Never throws.
 *
 * The session: if `cdp.ts` holds the tab, use that session and never detach
 * it. Otherwise attach here — raw, not `cdp.ts:attach` (keep-awake and
 * capture setup would be wasted on a closing tab) — and, if the close does not
 * take, detach again and clear `cdp.ts`'s state for the tab (a concurrent
 * `attach` may have adopted the session meanwhile, and Chrome sends no
 * `onDetach` for our own detach). An "already attached" answer here is
 * ambiguous — our session after a worker restart, or another client's
 * (DevTools): the close is tried, and a definite refusal falls back at once.
 *
 * A `Target.closeTarget` that succeeds, or dies with "Detached while handling
 * command" (the session ends with the target), waits for `tabs.onRemoved`; any
 * other rejection is a refusal and falls back immediately. */
async function tryQuietClose(tabId: number, targets?: PageTargets): Promise<boolean> {
  const targetId = targets?.get(tabId) ?? (await pageTargets()).get(tabId);
  if (targetId === undefined) return false;
  let attachedHere = false;
  if (!isAttached(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      attachedHere = true;
    } catch (e) {
      if (!/already attached/i.test(messageOf(e))) return false;
    }
  }
  let watch: ReturnType<typeof watchRemoval> | undefined;
  try {
    watch = watchRemoval(tabId);
    let accepted: boolean;
    try {
      const r = (await chrome.debugger.sendCommand({ tabId }, 'Target.closeTarget', {
        targetId,
      })) as { success?: unknown } | undefined;
      accepted = r?.success !== false;
    } catch (e) {
      accepted = /detached while handling command/i.test(messageOf(e));
    }
    if (accepted && (await watch.gone(QUIET_CLOSE_CONFIRM_MS))) return true;
    if (!(await tabExists(tabId))) return true;
  } catch {
    // listener API unavailable — the caller's fallback decides
  } finally {
    watch?.stop();
  }
  if (attachedHere) {
    // Leave no debugger session (and no debugging bar) behind on a tab that
    // stays open, and no `attached` entry in cdp.ts for a session that is gone.
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    onSessionDetached(tabId);
  }
  return false;
}

/** Removes ONE listener; `this` is the page's window, both arguments arrive
 * as structured `callFunctionOn` arguments (the handler by objectId). */
export const REMOVE_LISTENER_FN =
  'function(fn, capture) { this.removeEventListener("beforeunload", fn, { capture: capture === true }); }';

/** Puts one back — skipping the IDL handler (`idl`), which `RESTORE_HANDLER_FN`
 * restores as a handler rather than adding it as a second, plain listener. */
export const ADD_LISTENER_FN =
  'function(fn, capture, idl) { if (fn === idl) return; this.addEventListener("beforeunload", fn, { capture: capture === true }); }';

/** Reads the `onbeforeunload` IDL handler (`window.onbeforeunload = …` or a
 * `<body onbeforeunload>` attribute) — kept so it can be restored. */
export const READ_HANDLER_FN = 'function() { return this.onbeforeunload; }';

/** Clears it: `removeEventListener` cannot reach an IDL handler. */
export const CLEAR_HANDLER_FN = 'function() { this.onbeforeunload = null; }';

/** Restores it, unless the page has set a new one meanwhile. */
export const RESTORE_HANDLER_FN =
  'function(fn) { if (this.onbeforeunload === null) this.onbeforeunload = fn; }';

type ListenerInfo = {
  type?: unknown;
  useCapture?: unknown;
  handler?: { objectId?: unknown };
  originalHandler?: { objectId?: unknown };
};

/** The `beforeunload` listeners worth removing: well-formed entries only.
 * `originalHandler` first — it is the REGISTERED object (a `handleEvent`
 * object, the bound function), which is what `removeEventListener` matches;
 * `handler` is the function Chrome would call. Pure. */
export function beforeUnloadHandlers(
  listeners: unknown,
): Array<{ objectId: string; capture: boolean }> {
  if (!Array.isArray(listeners)) return [];
  const out: Array<{ objectId: string; capture: boolean }> = [];
  for (const l of listeners as ListenerInfo[]) {
    if (!l || l.type !== 'beforeunload') continue;
    const original = l.originalHandler?.objectId;
    const objectId = typeof original === 'string' ? original : l.handler?.objectId;
    if (typeof objectId !== 'string') continue;
    out.push({ objectId, capture: l.useCapture === true });
  }
  return out;
}

/** What `disarmBeforeUnload` took away, for `rearmIfSameDocument`. The objects
 * live in `CALL_GROUP`, which nothing frees while the call holds the tab. */
export type Disarmed = {
  windowId: string;
  handlers: Array<{ objectId: string; capture: boolean }>;
  /** The IDL handler that was cleared, or null. */
  idl: string | null;
  /** The document it happened in (null = the browser would not say). */
  loaderId: string | null;
};

async function disarmInner(tabId: number, startedAt?: number): Promise<Disarmed | null> {
  const { result } = await cdp<{ result?: { objectId?: string } }>(tabId, 'Runtime.evaluate', {
    expression: 'window',
    objectGroup: CALL_GROUP,
  });
  const windowId = result?.objectId;
  if (!windowId) return null;
  const { listeners } = await cdp<{ listeners?: unknown }>(tabId, 'DOMDebugger.getEventListeners', {
    objectId: windowId,
    objectGroup: CALL_GROUP,
  });
  const handlers = beforeUnloadHandlers(listeners);
  // An IDL handler is reported here too, so nothing listed means nothing to do.
  if (handlers.length === 0) return null;
  const loaderId = await mainFrameLoaderId(tabId, startedAt).catch(() => null);
  const read = await cdp<{ result?: { type?: string; objectId?: string } }>(
    tabId,
    'Runtime.callFunctionOn',
    { objectId: windowId, functionDeclaration: READ_HANDLER_FN },
  );
  const idl = read.result?.type === 'function' ? (read.result.objectId ?? null) : null;
  await Promise.all(
    handlers.map((h) =>
      cdp(tabId, 'Runtime.callFunctionOn', {
        objectId: windowId,
        functionDeclaration: REMOVE_LISTENER_FN,
        arguments: [{ objectId: h.objectId }, { value: h.capture }],
      }),
    ),
  );
  if (idl) {
    await cdp(tabId, 'Runtime.callFunctionOn', {
      objectId: windowId,
      functionDeclaration: CLEAR_HANDLER_FN,
    });
  }
  return { windowId, handlers, idl, loaderId };
}

/** Remove the main frame's `beforeunload` listeners so the navigation about to
 * be issued on `tabId` raises no prompt. Only for a tab `mayLeaveQuietly`
 * approved; the caller has already attached. Never throws, bounded by
 * `DISARM_DEADLINE_MS` and by what the call has left: on any failure the
 * navigation simply goes ahead as it always did. Returns what was removed
 * (null = nothing, or could not tell), for `rearmIfSameDocument`.
 *
 * Main frame only — a CHILD frame's listener can still prompt (crossing into
 * frames would need per-frame contexts and OOPIF sessions). */
export async function disarmBeforeUnload(
  tabId: number,
  startedAt?: number,
): Promise<Disarmed | null> {
  const ms = Math.min(DISARM_DEADLINE_MS, budgetLeft(startedAt, Date.now()));
  if (ms <= 0) return null;
  try {
    return await raceDeadline(
      disarmInner(tabId, startedAt),
      ms,
      () => new Error('disarm timed out'),
    );
  } catch {
    return null;
  }
}

/** After the navigation: if the tab is still on the SAME document (a `#hash`
 * navigate, a same-document history hop), put back what `disarmBeforeUnload`
 * removed — leaving was the point, and the page did not leave. Compared by the
 * main frame's loader id; unknown on either side ⇒ nothing restored (a new
 * document's context could not take the old objects anyway). Best-effort,
 * bounded like the disarm, never throws. Returns whether it restored. */
export async function rearmIfSameDocument(
  tabId: number,
  disarmed: Disarmed | null,
  startedAt?: number,
): Promise<boolean> {
  if (!disarmed || disarmed.loaderId === null) return false;
  const ms = Math.min(DISARM_DEADLINE_MS, budgetLeft(startedAt, Date.now()));
  if (ms <= 0) return false;
  const { windowId, handlers, idl, loaderId } = disarmed;
  const work = async (): Promise<boolean> => {
    if ((await mainFrameLoaderId(tabId, startedAt)) !== loaderId) return false;
    const idlArg = idl ? { objectId: idl } : { value: null };
    await Promise.all(
      handlers.map((h) =>
        cdp(tabId, 'Runtime.callFunctionOn', {
          objectId: windowId,
          functionDeclaration: ADD_LISTENER_FN,
          arguments: [{ objectId: h.objectId }, { value: h.capture }, idlArg],
        }),
      ),
    );
    if (idl) {
      await cdp(tabId, 'Runtime.callFunctionOn', {
        objectId: windowId,
        functionDeclaration: RESTORE_HANDLER_FN,
        arguments: [{ objectId: idl }],
      });
    }
    return true;
  };
  try {
    return await raceDeadline(work(), ms, () => new Error('rearm timed out'));
  } catch {
    return false;
  }
}
