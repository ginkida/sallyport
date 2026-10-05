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
 *    with `DOMDebugger.getEventListeners` and removed through two fixed
 *    function literals (`REMOVE_LISTENER_FN`, `CLEAR_HANDLER_FN`) with the
 *    handler passed as a structured argument — no agent input reaches the page
 *    (invariant #4's shape). CDP has no "navigate without beforeunload" and no
 *    way to suppress the native dialog; registering a stopping listener from
 *    an isolated world does not work either (window listeners run in
 *    registration order, so the page's own ones already ran).
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
import { CALL_GROUP, cdp } from './cdp.js';
import { agentTabRecord, isBrokerMode } from './ownership.js';

/** How long a quiet close waits for the tab to be reported gone before
 * falling back to `chrome.tabs.remove`. `Target.closeTarget` is answered by the
 * browser, not the renderer, and the removal follows within milliseconds. */
export const QUIET_CLOSE_CONFIRM_MS = 1_000;

/** Ceiling on removing a page's beforeunload listeners before a navigation.
 * They are renderer-answered (`Runtime.evaluate`), so a page frozen on an
 * `alert()` never answers — and the navigation must still go ahead. */
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

/** Close `tabId` without running its beforeunload handlers, so no prompt is
 * raised and nothing is activated or focused. Falls back to `chrome.tabs.remove`
 * when the quiet route is unavailable (no debugger foothold — DevTools already
 * open on the tab, a page an extension may not attach to). Returns which route
 * closed it. A missing tab rejects like `chrome.tabs.remove` does.
 *
 * Callers decide WHETHER a tab may be closed quietly (`mayCloseQuietly`); this
 * only knows how. Its own debugger attachment is raw (not `cdp.ts:attach`): the
 * tab is about to go, so keep-awake/capture setup would be wasted work, and
 * `tabs.onRemoved`/`onDetach` clear whatever `cdp.ts` held for it. */
export async function closeTabQuietly(tabId: number): Promise<'quiet' | 'removed'> {
  if (await tryQuietClose(tabId)) return 'quiet';
  await chrome.tabs.remove(tabId);
  return 'removed';
}

/** The quiet route alone: true once the tab is gone. Never throws — every
 * refusal means "use the plain removal". */
async function tryQuietClose(tabId: number): Promise<boolean> {
  let watch: ReturnType<typeof watchRemoval> | undefined;
  let attachedHere = false;
  try {
    const targets = await chrome.debugger.getTargets();
    const targetId = targets.find((t) => t.tabId === tabId)?.id;
    if (targetId === undefined) return false; // no such tab (or not attachable)
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      attachedHere = true;
    } catch (e) {
      // Already attached is normally our own session (cdp.ts) — use it. Any
      // other refusal (DevTools holds the tab, a page extensions may not
      // debug) means there is no quiet route.
      if (!String((e as Error)?.message ?? e).includes('already attached')) return false;
    }
    watch = watchRemoval(tabId);
    // "Detached while handling command" is the SUCCESS case too: the session
    // dies with the target. Whether the tab is gone is what counts.
    await chrome.debugger
      .sendCommand({ tabId }, 'Target.closeTarget', { targetId })
      .catch(() => undefined);
    if ((await watch.gone(QUIET_CLOSE_CONFIRM_MS)) || !(await tabExists(tabId))) return true;
  } catch {
    // getTargets/attach/listener API unavailable — the plain removal decides
  } finally {
    watch?.stop();
  }
  if (attachedHere) {
    // Don't leave a debugger session (and Chrome's debugging bar) behind on a
    // tab whose plain removal may now wait on a prompt.
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
  }
  return false;
}

/** Removes ONE listener; `this` is the page's window, both arguments arrive
 * as structured `callFunctionOn` arguments (the handler by objectId). */
export const REMOVE_LISTENER_FN =
  'function(fn, capture) { this.removeEventListener("beforeunload", fn, { capture: capture === true }); }';

/** Clears the `onbeforeunload` IDL handler (`window.onbeforeunload = …` or a
 * `<body onbeforeunload>` attribute), which `removeEventListener` cannot reach. */
export const CLEAR_HANDLER_FN = 'function() { this.onbeforeunload = null; }';

type ListenerInfo = { type?: unknown; useCapture?: unknown; handler?: { objectId?: unknown } };

/** The `beforeunload` listeners worth removing: well-formed entries only. Pure. */
export function beforeUnloadHandlers(
  listeners: unknown,
): Array<{ objectId: string; capture: boolean }> {
  if (!Array.isArray(listeners)) return [];
  const out: Array<{ objectId: string; capture: boolean }> = [];
  for (const l of listeners as ListenerInfo[]) {
    if (!l || l.type !== 'beforeunload') continue;
    const objectId = l.handler?.objectId;
    if (typeof objectId !== 'string') continue;
    out.push({ objectId, capture: l.useCapture === true });
  }
  return out;
}

async function disarmInner(tabId: number): Promise<number> {
  const { result } = await cdp<{ result?: { objectId?: string } }>(tabId, 'Runtime.evaluate', {
    expression: 'window',
    objectGroup: CALL_GROUP,
  });
  const windowId = result?.objectId;
  if (!windowId) return 0;
  const { listeners } = await cdp<{ listeners?: unknown }>(tabId, 'DOMDebugger.getEventListeners', {
    objectId: windowId,
    objectGroup: CALL_GROUP,
  });
  const handlers = beforeUnloadHandlers(listeners);
  for (const h of handlers) {
    await cdp(tabId, 'Runtime.callFunctionOn', {
      objectId: windowId,
      functionDeclaration: REMOVE_LISTENER_FN,
      arguments: [{ objectId: h.objectId }, { value: h.capture }],
    });
  }
  await cdp(tabId, 'Runtime.callFunctionOn', {
    objectId: windowId,
    functionDeclaration: CLEAR_HANDLER_FN,
  });
  return handlers.length;
}

/** Remove the main frame's `beforeunload` listeners so the navigation about to
 * be issued on `tabId` raises no prompt. Only for a tab `mayLeaveQuietly`
 * approved; the caller has already attached. Never throws, bounded by
 * `DISARM_DEADLINE_MS` and by what the call has left: on any failure the
 * navigation simply goes ahead as it always did. Returns how many listeners
 * were removed (`null` = could not tell), for tests and diagnostics.
 *
 * Main frame only — a CHILD frame's listener can still prompt (crossing into
 * frames would need per-frame contexts and OOPIF sessions). If the navigation
 * then never leaves the document (a same-document history hop, a 204), the
 * page simply goes on without its leave guard; it is an agent tab. */
export async function disarmBeforeUnload(
  tabId: number,
  startedAt?: number,
): Promise<number | null> {
  const ms = Math.min(DISARM_DEADLINE_MS, budgetLeft(startedAt, Date.now()));
  if (ms <= 0) return null;
  try {
    return await raceDeadline(disarmInner(tabId), ms, () => new Error('disarm timed out'));
  } catch {
    return null;
  }
}
