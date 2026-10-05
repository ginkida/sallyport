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
 *    with `DOMDebugger.getEventListeners` and removed through ONE fixed
 *    function literal with the handlers passed as structured arguments — no
 *    agent input reaches the page (invariant #4's shape; `PREPARE_LEAVE_FN`).
 *    Whatever happens next, the caller hands the result back to
 *    `rearmIfSameDocument` in a `finally`: if the tab is still on the SAME
 *    document (a pushState history entry, a navigation that never committed,
 *    a cancelled reload) the page gets back what it did not remove itself
 *    meanwhile; and if the document went into the back/forward cache, it
 *    restores itself on `pageshow` when it comes back. A `#hash` navigate is
 *    not disarmed at all — Chrome runs no `beforeunload` for it.
 *    CDP has no "navigate without beforeunload" and no way to suppress the
 *    native dialog; registering a stopping listener from an isolated world
 *    does not work either (window listeners run in registration order, so the
 *    page's own ones already ran).
 *
 * WHO it applies to is the point: `mayLeaveQuietly` — a tab the agent CREATED
 * (a minted epoch) that the human has NOT engaged with — and that is not, at
 * that moment, the active tab of the focused window (`inFrontOfHuman`: a
 * person can type into a tab without producing the events the `human` mark is
 * built from). A human tab — the standalone active-tab fallback, anything
 * without an epoch — and an agent tab the human activated, dragged into their
 * own window or has in front of them keep Chrome's prompt: there it may be
 * guarding something a PERSON typed. Skipping `beforeunload` also skips
 * whatever else the page did in it (a last-moment draft save); for a page only
 * an agent was driving, leaving is what the agent asked for.
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

/** Is `tabId` the tab in front of the human right now — the ACTIVE tab of the
 * FOCUSED window (`focused` is false for every window while Chrome is not the
 * frontmost app)?
 *
 * The `human` mark (background.ts) is earned by events — an activation in a
 * focused window, a drag, a window focus — and a person can type into an agent
 * tab without producing any: the first tab of a window that took focus anyway
 * (`focused:false` is a request), focused inside the grace that discounts our
 * own create (`agent-window.ts:wasJustCreated`), is already active, and
 * clicking into it fires nothing. A prompt there steals nothing — Chrome is
 * already in front, on that very tab — and may be all that guards what they
 * typed. Browser-answered. Fail-closed: anything it cannot tell ⇒ true (keep
 * the prompt). */
export async function inFrontOfHuman(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active !== true) return false;
    return (await chrome.windows.get(tab.windowId)).focused !== false;
  } catch {
    return true;
  }
}

/** The navigation-side decision as a whole: `mayLeaveQuietly` and not the tab
 * the human has in front of them right now (`inFrontOfHuman`). */
export async function quietLeaveApproved(tabId: number): Promise<boolean> {
  return mayLeaveQuietly(tabId) && !(await inFrontOfHuman(tabId));
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
 * `mayCloseQuietly` (an agent tab the human has not engaged with) and not
 * `inFrontOfHuman` → closed without its beforeunload handlers, so no prompt is raised and nothing is
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
  if (
    mayCloseQuietly(tabId) &&
    !(await inFrontOfHuman(tabId)) &&
    (await tryQuietClose(tabId, opts.targets))
  ) {
    return 'quiet';
  }
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

/** The page half of a quiet leave, ONE fixed literal (invariant #4's shape: the
 * handlers arrive as structured `callFunctionOn` arguments — `handler,
 * capture` pairs by objectId — and nothing an agent sent is interpolated).
 * `this` is the page's window. It changes nothing by itself: it returns a
 * private controller object (reachable only through the CDP handle, never
 * from the page) whose `disarm()` takes the guard away and whose `restore()`
 * gives back what the PAGE did not take away itself in the meantime:
 *
 *  - `disarm()` removes every listener it was handed (by the object the page
 *    REGISTERED — a `handleEvent` object, a bound function) and clears the
 *    `onbeforeunload` IDL handler, which `removeEventListener` cannot reach.
 *    For as long as the guard is down it watches the page's own hands: a
 *    `removeEventListener('beforeunload', fn)` on the window (an own-property
 *    shadow of the inherited method, forwarding to it) or a write to
 *    `onbeforeunload` (an accessor over the browser's own) marks that handler
 *    as the page's decision. An SPA route change inside the document
 *    (pushState/hash) is exactly where a page drops its guard on purpose — an
 *    editor unmounting — and that removal, a no-op on a listener already gone,
 *    would otherwise be undone by `restore()`.
 *  - `restore()` (once) takes the watch down, re-adds what the page did not
 *    remove, and puts the IDL handler back unless the page wrote one since.
 *    Before `disarm()` it is a cancel: a disarm arriving after it does
 *    nothing.
 *  - a `pageshow` listener calls `restore()` when the document comes back from
 *    the back/forward cache: a cross-document leave freezes this very document
 *    — listeners removed — and a later Back revives it. A `beforeunload`
 *    listener does not keep a page out of that cache, and nothing on the
 *    extension side runs at that moment (the human's own Back button counts).
 *
 * Main-world code, so a page can see the shadow while it exists (sub-second,
 * agent tabs only) and can defeat the bookkeeping (calling the prototype's
 * method directly, `document.body.onbeforeunload`): at worst its own guard
 * comes back when it meant to drop it, or stays gone — it reaches nothing
 * else. Every step that might throw on a hostile page is fenced, so `disarm`
 * never half-installs a watch it cannot take down. Self-contained (run
 * standalone by the tests). */
export const PREPARE_LEAVE_FN = `function () {
  var w = this, add = w.addEventListener, remove = w.removeEventListener;
  var list = [], i;
  for (i = 0; i + 1 < arguments.length; i += 2)
    list.push({ fn: arguments[i], capture: arguments[i + 1] === true, pageRemoved: false });
  var desc, o = w;
  while (o && !(desc = Object.getOwnPropertyDescriptor(o, 'onbeforeunload'))) o = Object.getPrototypeOf(o);
  var accessor = !!(desc && desc.get && desc.set);
  var ownIdl = Object.getOwnPropertyDescriptor(w, 'onbeforeunload');
  var ownRemove = Object.getOwnPropertyDescriptor(w, 'removeEventListener');
  var getIdl = function () { return accessor ? desc.get.call(w) : w.onbeforeunload; };
  var setIdl = function (v) { if (accessor) desc.set.call(w, v); else w.onbeforeunload = v; };
  var s = { armed: false, done: false, idl: null, idlTouched: false };
  var hookRemove = function (type, fn, opts) {
    var self = this == null ? w : this;
    if (self === w && type === 'beforeunload') {
      var cap = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
      for (var j = 0; j < list.length; j++)
        if (list[j].fn === fn && list[j].capture === cap) list[j].pageRemoved = true;
    }
    return remove.apply(self, arguments);
  };
  var hookIdl = accessor ? {
    configurable: true,
    enumerable: desc.enumerable,
    get: function () { return desc.get.call(w); },
    set: function (v) { s.idlTouched = true; desc.set.call(w, v); }
  } : null;
  var restore;
  var onShow = function (e) { if (e && e.persisted === true) restore(); };
  var unhook = function () {
    try { remove.call(w, 'pageshow', onShow); } catch (e) {}
    try {
      var r = Object.getOwnPropertyDescriptor(w, 'removeEventListener');
      if (r && r.value === hookRemove) {
        if (ownRemove) Object.defineProperty(w, 'removeEventListener', ownRemove);
        else delete w.removeEventListener;
      }
    } catch (e) {}
    try {
      var d = Object.getOwnPropertyDescriptor(w, 'onbeforeunload');
      if (hookIdl && d && d.get === hookIdl.get) {
        if (ownIdl) Object.defineProperty(w, 'onbeforeunload', ownIdl);
        else delete w.onbeforeunload;
      }
    } catch (e) {}
  };
  restore = function () {
    if (s.done) return false;
    s.done = true;
    if (!s.armed) return false;
    unhook();
    for (var j = 0; j < list.length; j++)
      if (!list[j].pageRemoved && list[j].fn !== s.idl)
        add.call(w, 'beforeunload', list[j].fn, { capture: list[j].capture });
    if (s.idl && !s.idlTouched && getIdl() == null) setIdl(s.idl);
    return true;
  };
  return {
    disarm: function () {
      if (s.armed || s.done) return;
      s.armed = true;
      try {
        Object.defineProperty(w, 'removeEventListener', {
          configurable: true, writable: true, enumerable: false, value: hookRemove
        });
      } catch (e) {}
      if (hookIdl) try { Object.defineProperty(w, 'onbeforeunload', hookIdl); } catch (e) {}
      try { add.call(w, 'pageshow', onShow); } catch (e) {}
      var cur = getIdl();
      if (typeof cur === 'function') { s.idl = cur; setIdl(null); }
      for (var j = 0; j < list.length; j++)
        remove.call(w, 'beforeunload', list[j].fn, { capture: list[j].capture });
    },
    restore: restore
  };
}`;

/** Takes the guard away; `this` is the controller `PREPARE_LEAVE_FN` made. */
export const DISARM_FN = 'function() { this.disarm(); }';

/** Gives back what the page did not remove itself; true if it ran now. */
export const REARM_FN = 'function() { return this.restore(); }';

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

/** What `disarmBeforeUnload` took away, for `rearmIfSameDocument`: the handle
 * of the in-page controller (`PREPARE_LEAVE_FN`), in `CALL_GROUP`, which
 * nothing frees while the call holds the tab. The page keeps its own
 * reference for the back/forward-cache path, so the handle's release later
 * costs that path nothing. */
export type Disarmed = {
  stateId: string;
  /** How many `beforeunload` registrations were taken (the IDL handler counts). */
  count: number;
  /** The document it happened in (null = the browser would not say). */
  loaderId: string | null;
};

/** Shared between `disarmBeforeUnload` and the work it races: `abandoned` is
 * set when the caller stops waiting, and from then on the work sends NOTHING
 * that changes the page — `raceDeadline` does not cancel it, and a removal
 * landing after the caller gave up (on a document a `#hash` navigate kept)
 * would leave a guard gone with no record of it. `sent` is set the moment the
 * one mutating command goes out, so a caller that stopped waiting still gets
 * the handle to restore with (CDP runs a session's Runtime commands in order,
 * so a restore sent after it lands after it). */
type DisarmToken = { abandoned: boolean; sent: Disarmed | null };

async function disarmInner(
  tabId: number,
  token: DisarmToken,
  startedAt?: number,
): Promise<Disarmed | null> {
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
  if (token.abandoned) return null;
  const prepared = await cdp<{ result?: { objectId?: string }; exceptionDetails?: unknown }>(
    tabId,
    'Runtime.callFunctionOn',
    {
      objectId: windowId,
      functionDeclaration: PREPARE_LEAVE_FN,
      arguments: handlers.flatMap((h) => [{ objectId: h.objectId }, { value: h.capture }]),
    },
  );
  const stateId = prepared.result?.objectId;
  if (!stateId || prepared.exceptionDetails) return null;
  if (token.abandoned) return null;
  const disarmed: Disarmed = { stateId, count: handlers.length, loaderId };
  token.sent = disarmed;
  await cdp(tabId, 'Runtime.callFunctionOn', { objectId: stateId, functionDeclaration: DISARM_FN });
  return disarmed;
}

/** Remove the main frame's `beforeunload` listeners so the navigation about to
 * be issued on `tabId` raises no prompt. Only for a tab `quietLeaveApproved`
 * approved; the caller has already attached. Never throws, bounded by
 * `DISARM_DEADLINE_MS` and by what the call has left: on any failure the
 * navigation simply goes ahead as it always did. Returns the handle to give it
 * back with (null = nothing was, or ever will be, removed), and the caller
 * MUST hand it to `rearmIfSameDocument` on every path out — success, a thrown
 * navigation, a cancelled one — in a `finally`.
 *
 * Main frame only — a CHILD frame's listener can still prompt (crossing into
 * frames would need per-frame contexts and OOPIF sessions). */
export async function disarmBeforeUnload(
  tabId: number,
  startedAt?: number,
): Promise<Disarmed | null> {
  const ms = Math.min(DISARM_DEADLINE_MS, budgetLeft(startedAt, Date.now()));
  if (ms <= 0) return null;
  const token: DisarmToken = { abandoned: false, sent: null };
  try {
    return await raceDeadline(
      disarmInner(tabId, token, startedAt),
      ms,
      () => new Error('disarm timed out'),
    );
  } catch {
    token.abandoned = true;
    return token.sent;
  }
}

/** How long `rearmIfSameDocument` waits for the loader id before restoring
 * anyway: an unanswered read must not be what strands a guard. */
const REARM_LOADER_PEEK_MS = 500;

/** After the navigation — on EVERY path, thrown and cancelled ones included:
 * if the tab is still on the SAME document (a `#hash`, a same-document history
 * hop, a navigation that never committed, a cancelled reload), give back what
 * `disarmBeforeUnload` removed, minus what the page removed itself meanwhile
 * (`PREPARE_LEAVE_FN`). A loader id that is known on both sides and differs
 * means the document is gone (or frozen in the back/forward cache, where its
 * own `pageshow` hook restores it) — nothing sent. An UNKNOWN one does not
 * stop the restore: the controller handle is bound to its document, so on a
 * new one the call simply fails, and on the same one it is what keeps the
 * guard from being lost.
 *
 * Not clamped to the call's budget: it is what puts back a page's own guard,
 * bounded by `DISARM_DEADLINE_MS`, and once sent it runs even if nobody waits.
 * Never throws. Returns whether it restored. */
export async function rearmIfSameDocument(
  tabId: number,
  disarmed: Disarmed | null,
): Promise<boolean> {
  if (!disarmed) return false;
  const work = async (): Promise<boolean> => {
    const now = await raceDeadline(
      mainFrameLoaderId(tabId),
      REARM_LOADER_PEEK_MS,
      () => new Error('loader id read timed out'),
    ).catch(() => null);
    if (now !== null && disarmed.loaderId !== null && now !== disarmed.loaderId) return false;
    const r = await cdp<{ result?: { value?: unknown } }>(tabId, 'Runtime.callFunctionOn', {
      objectId: disarmed.stateId,
      functionDeclaration: REARM_FN,
      returnByValue: true,
    });
    return r?.result?.value === true;
  };
  try {
    return await raceDeadline(work(), DISARM_DEADLINE_MS, () => new Error('rearm timed out'));
  } catch {
    return false;
  }
}

/** Is `to` a fragment navigation from `from` — same document, only the `#…`
 * differs? Chrome runs no `beforeunload` for one, so there is nothing to
 * disarm and the disarm/restore round trip would be pure risk. Conservative:
 * anything unparseable, or the very same URL (which Chrome may treat as a
 * reload), is not. Pure. */
export function isFragmentNavigation(from: string | undefined, to: string): boolean {
  if (!from || !to.includes('#') || from === to) return false;
  try {
    const a = new URL(from);
    const b = new URL(to);
    a.hash = '';
    b.hash = '';
    return a.href.replace(/#$/, '') === b.href.replace(/#$/, '');
  } catch {
    return false;
  }
}
