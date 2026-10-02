import { getSettings } from '../storage.js';
import { CALL_BUDGET_MS } from './budget.js';
import {
  clearConsole,
  ensureConsoleCapture,
  isConsoleCaptureActive,
  releaseConsoleCapture,
} from './console-capture.js';
import { clearDialogs, ensureDialogCapture, releaseDialogCapture } from './dialog-capture.js';
import { BridgeError } from './errors.js';
import { clearNetwork, ensureNetworkCapture, releaseNetworkCapture } from './network-capture.js';
import { clearRefsForTab, resetRefsForTab } from './refs.js';
import { onTab } from './tab-chain.js';

// How long the teardown path waits for a tab to give its viewport emulation
// back before detaching anyway. Generous for a healthy renderer, short enough
// that one wedged tab cannot hold up a whole session's hand-back.
const VIEWPORT_RELEASE_DEADLINE_MS = 2000;

// Cap on the chrome error text we echo back: a debugger attach failure can
// embed a chrome:// or page URL, so bound it the same way the daemon caps a
// handshake-rejection reason (reason[:200]) before it travels to the agent.
const MAX_ATTACH_MSG = 200;

/** Map a `chrome.debugger.attach` rejection to a STABLE BridgeError code so an
 * autonomous loop can branch (retry a transient conflict, skip a forbidden
 * page, give up on a closed tab) instead of looping blind on one opaque
 * string. Best-effort OVERLAY: every unmatched message still surfaces as
 * `attach_failed` carrying the (capped) original text — unknown errors are
 * classified-as-generic, never swallowed. Pure + chrome-free so it is
 * unit-testable; Chrome's wording is not a stable API, hence the always-present
 * fallback.
 *
 *  - `attach_forbidden_url`     restricted page the debugger may not touch
 *                               (chrome://, devtools://, the extension gallery)
 *  - `attach_debugger_conflict` another client holds the tab (DevTools open,
 *                               another extension, or a tab mid-drag) — retryable
 *  - `attach_target_closed`     the tab/target is gone — give up on this tabId
 *  - `attach_failed`            anything else, original message preserved
 */
export function classifyAttachError(msg: string): BridgeError {
  const raw = msg || '';
  const m = raw.toLowerCase();
  const detail = raw.slice(0, MAX_ATTACH_MSG);
  const has = (...needles: string[]): boolean => needles.some((n) => m.includes(n));

  let code = 'attach_failed';
  if (
    has(
      'cannot access a chrome',
      'cannot access contents',
      'extensions gallery',
      'chrome web store',
      'devtools://',
      'chrome-extension://',
      'cannot attach to extension',
      'cannot be debugged',
    )
  ) {
    code = 'attach_forbidden_url';
  } else if (
    has('already attached', 'another debugger', 'attached client', 'dragging a tab', 'be edited')
  ) {
    code = 'attach_debugger_conflict';
  } else if (
    has(
      'no tab with given id',
      'no target with given id',
      'no target',
      'cannot attach to this target',
      'target closed',
      'tab was closed',
    )
  ) {
    code = 'attach_target_closed';
  }
  return new BridgeError(code, `attach failed: ${detail}`);
}

function messageOf(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).toLowerCase();
}

/** Does this CDP rejection look like Chrome refusing a malformed CSS selector?
 *
 * `DOM.querySelector` rejects on bad syntax, and the model reaches for
 * Playwright-isms (`:has-text()`, `:contains()`, `text=`) often enough that
 * this is a routine failure, not an exotic one. It matters which way it is
 * classified: a syntax error is PERMANENT (`bad_args`, "don't retry") while
 * every other querySelector rejection — a document node that went away
 * mid-navigation, say — is transient. So this is deliberately narrow and the
 * unmatched case keeps whatever code it already had, exactly like
 * `classifyAttachError`'s always-present fallback. Pure / chrome-free. */
export function looksLikeSelectorSyntaxError(e: unknown): boolean {
  const msg = messageOf(e);
  return msg.includes('selector') || msg.includes('while querying') || msg.includes('dom error');
}

/** Does this CDP rejection mean "that node is not in the document any more"?
 *
 * The stale-`@eN` case: `DOM.resolveNode {backendNodeId}` rejects once the node
 * an earlier snapshot recorded has been destroyed by a re-render. Same
 * discipline as above — narrow match, unmatched rejections (a detached debugger,
 * a wedged renderer) keep their own classification rather than being mislabelled
 * as a stale ref. Pure / chrome-free. */
export function looksLikeMissingNodeError(e: unknown): boolean {
  const msg = messageOf(e);
  if (!msg.includes('node')) return false;
  return (
    msg.includes('no node') ||
    msg.includes('not found') ||
    msg.includes('could not find') ||
    msg.includes('does not belong')
  );
}

/** Does this CDP rejection mean "the document that owned that remote object is
 * gone"? A `RemoteObjectId` is bound to its execution context, so after a
 * main-frame navigation `Runtime.callFunctionOn` on a handle minted in the old
 * page rejects — the handle is dead, the tab is not. Same narrow discipline as
 * above: a detached debugger or a closed target stays unmatched and keeps its
 * own failure. Pure / chrome-free. */
export function looksLikeLostContextError(e: unknown): boolean {
  const msg = messageOf(e);
  return (
    msg.includes('cannot find context with specified id') ||
    msg.includes('could not find object with given id') ||
    msg.includes('execution context was destroyed') ||
    msg.includes('cannot find default execution context') ||
    msg.includes('inspected target navigated')
  );
}

/** One CDP attachment per tab. Detach happens when the tab closes or the
 * user clicks "Cancel" on the debugger banner — we listen for both so the
 * set stays accurate without polling. */
const attached = new Set<number>();

/** The device scale factor `set_viewport` is emulating on a tab, when it is.
 *
 * `screenshot` needs it: the returned image is sized by the EMULATED ratio,
 * while `Page.getLayoutMetrics` keeps reporting the real display one (Chrome
 * hands the compositor the real DSF to keep rasterisation sharp), so metrics
 * alone cannot bound a capture that we ourselves emulated. We applied the
 * emulation, so we are the authority — and a browser-owned number is what a
 * size bound must rest on, rather than asking the page (invariant #5's
 * reasoning, applied to geometry).
 *
 * tabId-keyed with synchronous mutation, like `attached` and `epochByTab`, so
 * overlapping calls cannot interleave inside it. Ephemeral: an MV3 worker
 * restart wipes it while the CDP emulation survives, so readers must treat a
 * miss as "unknown", never as "not emulated". */
const emulatedDsf = new Map<number, number>();

export function recordEmulatedDsf(tabId: number, deviceScaleFactor: number): void {
  emulatedDsf.set(tabId, deviceScaleFactor);
}

export function getEmulatedDsf(tabId: number): number | undefined {
  return emulatedDsf.get(tabId);
}

/** Reset in-memory attach state (test hook — vitest reuses this module across
 * every `it()` in a file, so a mock tabId that collides with one attached in
 * an earlier test would otherwise silently skip `chrome.debugger.attach` here
 * and desync from the mock's own call log). */
export function resetAttachedTabs(): void {
  attached.clear();
  emulatedDsf.clear();
  for (const tabId of [...hygiene.keys()]) dropHygiene(tabId);
  removedTabs.clear();
}

/** Decide what keep-awake should do for a tab on this attach: (re-)ENABLE the
 * focus emulation + lifecycle keep-alive when the setting is on (both CDP calls
 * are idempotent), or DISABLE (revoke) the focus emulation when it's off.
 *
 * The off-path fires UNCONDITIONALLY — deliberately NOT gated on "did we enable
 * it on this tab earlier". That knowledge could only live in ephemeral module
 * state, which an MV3 service-worker restart wipes while the tab-level CDP
 * override survives (the debugger stays attached across a SW restart) — so a
 * gated revoke would silently no-op and leave the tab reporting itself focused
 * (presence / read-receipt leak) after the user opted out. `enabled:false` is an
 * idempotent best-effort no-op on a tab that was never emulated, and since
 * keep-awake DEFAULTS ON the off-path only runs after a deliberate opt-out, so
 * this adds no CDP footprint to the default path. Pure / unit-tested — the test
 * pins "off ⇒ disable" so a future ephemeral gate can't silently reintroduce the
 * leak. */
export function keepAwakeAction(keepAwake: boolean): 'enable' | 'disable' {
  return keepAwake ? 'enable' : 'disable';
}

/** Revoke keep-awake on EVERY currently-attached tab.
 *
 * The per-tab `attach` path only reaches a tab the next time something drives
 * it, so unchecking the popup toggle used to leave every idle tab still
 * reporting itself focused — indefinitely, since a tab nobody drives again is
 * never re-attached. The popup calls this on the toggle so "off" means off now,
 * across the board. Best-effort per tab. */
export async function releaseKeepAwakeEverywhere(): Promise<void> {
  for (const tabId of [...attached]) {
    await releaseKeepAwake(tabId);
  }
}

// The MV3 service worker always has the full chrome.*; vitest imports this
// module transitively (tabs.ts/poll.ts pull pure helpers) where it doesn't
// exist at load time — guard the top-level registrations so importing never
// demands the API surface, only calling does.
//
// A tab's extension-side state dies in TWO halves, because the two ends of a
// debugger session are not the same event:
//  - `clearSessionState` — everything that belongs to the CDP session (the
//    attached flag, capture rings and flags, a dialog arm, the emulated dpr, the
//    hygiene timer). Gone with ANY detach.
//  - the `@eN` refs. Their map dies with the session too, but their COUNTER
//    only dies with the tab: a detach (the human's Cancel on the debugging bar,
//    an explicit `detach()`) leaves a LIVE page, and restarting at `e1` there would let the
//    next snapshot re-issue `@e5` while the agent still holds the old one — a
//    silent rebind (#7). So a detach RESETS (map wiped, counter kept); only
//    `tabs.onRemoved` CLEARS.
export function clearSessionState(tabId: number): void {
  attached.delete(tabId);
  clearConsole(tabId);
  clearNetwork(tabId);
  clearDialogs(tabId);
  emulatedDsf.delete(tabId);
  dropHygiene(tabId);
}

/** The tab is gone for good: session state AND the ref counter. */
export function onTabRemoved(tabId: number): void {
  rememberRemoved(tabId);
  clearSessionState(tabId);
  clearRefsForTab(tabId);
}

/** The session ended, the tab may well live on — whatever the reason Chrome
 * gives. `target_closed` is deliberately NOT read as proof that the TAB closed:
 * a closed tab's `tabs.onRemoved` restarts the counter anyway, and a reset that
 * lands after it leaves nothing behind (refs.ts), so keeping the counter here
 * costs nothing and is the safe answer on any path where the tab survives. */
export function onSessionDetached(tabId: number): void {
  clearSessionState(tabId);
  resetRefsForTab(tabId);
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener(onTabRemoved);
}

if (typeof chrome !== 'undefined' && chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) {
      onSessionDetached(source.tabId);
    }
  });
}

export async function attach(tabId: number): Promise<void> {
  if (!attached.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      attached.add(tabId);
    } catch (e) {
      const msg = (e as Error).message || String(e);
      // "already attached" is assumed to be OUR own prior attachment (the
      // common case after an MV3 worker restart drops the `attached` set) —
      // proceed. Everything else is a real failure: surface it with a stable,
      // classified code instead of the opaque chrome string.
      if (!msg.includes('already attached')) throw classifyAttachError(msg);
      attached.add(tabId);
    }
  }
  // Read settings once and drive the opt-in, best-effort features below.
  // Capture is gated here so Runtime.enable/Network.enable/Page.enable are
  // NEVER issued on the unconditional attach path — only when the user
  // turned the setting on.
  const settings = await getSettings();
  // The session ended while we read the settings (the tab closed, or the human
  // hit Cancel): there is nothing left to configure, and configuring anyway
  // would re-create per-tab state — capture revocation marks, hygiene records —
  // after `clearSessionState` had already dropped it, for a tab whose one
  // removal event has fired. The tool's own next command reports the loss.
  if (!attached.has(tabId)) return;
  switch (keepAwakeAction(settings.keepAwake)) {
    case 'enable':
      await keepAwake(tabId);
      break;
    case 'disable':
      // Keep-awake is OFF — revoke the sticky focus emulation so the tab stops
      // believing it is focused (the documented opt-out must actually take
      // effect, not just stop re-asserting). Unconditional + idempotent, so it
      // is correct even after an MV3 SW restart wiped any in-memory marker.
      await releaseKeepAwake(tabId);
      break;
  }
  // Off: revoke once per attachment (the release helpers remember it), so a
  // capture this worker never saw — a session that outlived a worker restart —
  // still gets Network.disable / the 'console' release + Runtime.disable. Not
  // awaited: nothing here depends on the answer, and those commands are
  // renderer-answered, so a wedged page must not hold up the tool call.
  if (settings.captureConsole) await ensureConsoleCapture(tabId);
  else void releaseConsoleCapture(tabId);
  if (settings.captureNetwork) await ensureNetworkCapture(tabId);
  else void releaseNetworkCapture(tabId);
  // Dialog handling ACTS on the page (unlike console/network, which only
  // observe), so unlike those two, turning it off must actively stop it —
  // same off-path shape as keep-awake's releaseKeepAwake below.
  if (settings.handleDialogs) {
    await ensureDialogCapture(tabId);
  } else {
    await releaseDialogCapture(tabId);
  }
}

/** Chrome freezes background tabs and (on macOS) fully-occluded windows:
 * JS stalls, pages stop loading, dispatched input sits in a dead queue —
 * automation grinds to a halt the moment the user looks at another window.
 * While the bridge drives a tab, keep it awake: unfreeze it and make it
 * believe it is focused, so SPA "I'm in background" logic stays off.
 *
 * Re-asserted on every tool call (attach() is called by every tool; the two
 * commands are cheap no-ops when already in effect). Both are experimental
 * CDP commands — same status as Accessibility.getFullAXTree, which we
 * already rely on — and strictly best-effort: failure degrades to the old
 * behaviour, never breaks the call. The effect ends at debugger detach.
 *
 * What focus emulation really does is more than "focused": Chrome implements
 * it by taking a VISIBLE capturer handle on the tab
 * (`EmulationHandler::SetFocusEmulationEnabled` → `IncrementCapturerCount`
 * with stay_hidden=false), and a tab with a visible capturer is computed as
 * visible. So while it is on, a background tab in an unfocused or occluded
 * agent window reports visibilityState 'visible' and hasFocus() true, renders
 * frames, runs rAF and is not timer-throttled — for the whole attachment,
 * idle time between calls included, at a CPU/GPU cost on animated pages. That
 * capturer is also what lets `screenshot` raster a background tab (see the
 * note in screenshot.ts); an occluded or minimised window can still stall a
 * capture (`tab_not_visible`). The handle is dropped by
 * `setFocusEmulationEnabled{false}` or at detach.
 *
 * Side effect worth knowing: a page that believes it is active behaves like
 * one (Telegram sends read receipts / presence) — the popup setting "Keep
 * automated tabs awake" turns this off, and the next tool call then actively
 * DISABLES the focus emulation on the driven tab (see `releaseKeepAwake`), not
 * merely stops re-asserting it. */
async function keepAwake(tabId: number): Promise<void> {
  try {
    await cdp(tabId, 'Page.setWebLifecycleState', { state: 'active' });
  } catch {
    // older Chrome / command unavailable — proceed without
  }
  try {
    await cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  } catch {
    // older Chrome / command unavailable — proceed without
  }
}

/** Undo `keepAwake`'s focus emulation when the user turns the setting off, so
 * the tab stops reporting itself focused (presence/read-receipt leak). Best
 * effort. `Page.setWebLifecycleState` has no clean inverse, but focus emulation
 * is the presence-relevant override, so disabling it is what stops the leak. */
async function releaseKeepAwake(tabId: number): Promise<void> {
  try {
    await cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false });
  } catch {
    // older Chrome / command unavailable — nothing to revoke
  }
}

/** Undo everything `set_viewport` can apply, in the order Chrome wants it.
 *
 * Lives here rather than in `viewport.ts` for the same reason `releaseKeepAwake`
 * does: this file owns the revoke paths for sticky per-session emulation, and
 * `detach` has to be able to call it without the tool module.
 *
 * It is NOT redundant with the debugger session ending. Detaching runs
 * `EmulationHandler::Disable()`, which is the one teardown path that never calls
 * `WebContentsImpl::ClearDeviceEmulationSize()` — so the browser-side view stays
 * sized to the emulated dimensions, `WebContents::GetSize()` keeps returning
 * them, and the renderer's idea of the "original" size may itself have been
 * overwritten with the emulated one. Only `Emulation.clearDeviceMetricsOverride`
 * restores the real size, and it has to happen while the session is still alive.
 * Skip it and the human inherits a tab that renders 393 px wide inside a full
 * window, with no way back short of closing it.
 *
 * The UA reset is `userAgent: ''` because there is no `clearUserAgentOverride`:
 * the empty string is the documented sentinel, and it must NOT be sent together
 * with `userAgentMetadata` (Chrome rejects that combination outright).
 *
 * `deadlineMs` bounds the whole sequence and exists only for `detach`. Every
 * command here is answered by the RENDERER (that is exactly what makes awaiting
 * `setDeviceMetricsOverride` a real barrier), and `chrome.debugger.sendCommand`
 * has no timeout of its own — so a tab whose main thread is wedged (an
 * unanswered `confirm()` with dialog handling off, a runaway script) would
 * never settle. `chrome.debugger.detach` is browser-side and always completes,
 * so before this it could not hang; `release.ts` walks a disconnected session's
 * tabs SEQUENTIALLY, and one such tab would strand every tab after it — no
 * detach, no hand-back, debugging bar left up. Giving up early costs little:
 * `clearDeviceMetricsOverride` does its browser-side `ClearDeviceEmulationSize`
 * — the part that actually restores the tab's real size — before the command is
 * forwarded at all. `set_viewport reset` passes no deadline, so a genuine
 * failure there still surfaces rather than being silently timed out. */
export async function releaseViewport(tabId: number, deadlineMs?: number): Promise<void> {
  // Forget the emulated ratio FIRST: whether or not the commands below get
  // through, this tab is no longer one we are knowingly emulating, and a stale
  // record would make `screenshot` size a capture against an emulation that is
  // being torn down.
  emulatedDsf.delete(tabId);
  const run = async (): Promise<void> => {
    try {
      await cdp(tabId, 'Emulation.setUserAgentOverride', { userAgent: '' });
    } catch {
      // never overridden / command unavailable — nothing to restore
    }
    try {
      await cdp(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: false });
    } catch {
      // never enabled / command unavailable — nothing to revoke
    }
    try {
      await cdp(tabId, 'Emulation.clearDeviceMetricsOverride');
    } catch (e) {
      // This one is load-bearing (see above), so it is the only step that
      // reports: `set_viewport reset` must not claim a tab is back to normal
      // when it isn't.
      throw new BridgeError(
        'viewport_failed',
        `could not clear the viewport override: ${((e as Error)?.message || String(e)).slice(0, 200)}`,
      );
    }
  };

  if (deadlineMs === undefined) return run();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
  });
  try {
    // Both promises get handlers attached here, so a rejection arriving after
    // the deadline won already has a home — no unhandled rejection.
    await Promise.race([run(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Stop driving a tab: detach the debugger if we hold it.
 *
 * Nothing used to call this — `attach` had no counterpart at all — so every tab
 * an agent ever touched kept a CDP session until it closed or the human clicked
 * Cancel on the debugger banner (which detaches EVERY tab at once and breaks
 * whatever else is running). That left things the human pays for long after the
 * agent that caused them is gone: Chrome's "started debugging this browser"
 * bar, a sticky `setFocusEmulationEnabled` keeping the page focused and
 * rendering as if visible (see `keepAwake`), whatever domains and state the
 * session still holds, and Chrome counting the tab as DevTools-open, which
 * keeps it out of memory-saver discards. Detaching ends all of it — every CDP
 * override ends with the session (except the viewport, below).
 *
 * Best-effort by construction: a tab that is already gone, or was never
 * attached, is simply not our problem. Explicit detach clears our state too:
 * Chrome does not emit onDetach for the extension's own detach call. */
export async function detach(tabId: number): Promise<void> {
  // Drop any viewport emulation FIRST, while there is still a session to send
  // it on. Unlike every other override, this one does not reliably end with the
  // session — see `releaseViewport`. Best-effort AND bounded: a tab that was
  // never emulated (or is already gone) throws, a tab whose renderer is wedged
  // would never answer, and neither is a reason to skip the detach below —
  // which is the step that always works.
  try {
    await releaseViewport(tabId, VIEWPORT_RELEASE_DEADLINE_MS);
  } catch {
    // never emulated, or the tab is already gone — nothing to restore
  }
  // UNCONDITIONAL, deliberately not gated on the in-memory `attached` set — the
  // same reasoning as keep-awake's off-path. That set is ephemeral module
  // state an MV3 service-worker restart wipes, while the underlying CDP session
  // survives it, so a gated detach would silently no-op for exactly the tabs
  // that have been attached longest. Detaching a tab we never held is a
  // harmless no-op that throws, which we swallow.
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // already detached, tab closed, or never ours — nothing to undo
  }
  onSessionDetached(tabId);
}

export async function cdp<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const sent = noteSend(tabId, method, true);
  try {
    return (await chrome.debugger.sendCommand({ tabId }, method, params)) as unknown as T;
  } finally {
    noteSettle(tabId, sent);
  }
}

/** Send a command to a flat child protocol session (notably an OOPIF target)
 * while retaining the root tab as the debuggee. Chrome exposes sessionId on
 * DebuggerSession for exactly this routing.
 *
 * Counts as activity on the tab (the idle flush must not land inside a call
 * that is walking a child frame) but sets no hygiene flags: the flush speaks to
 * the ROOT session, and a child session's agents die with its
 * `Target.detachFromTarget` — the caller pairs its own Accessibility state
 * before that (`releaseChildAx`). */
export async function cdpSession<T = unknown>(
  tabId: number,
  sessionId: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const sent = noteSend(tabId, method, false);
  try {
    return (await chrome.debugger.sendCommand(
      { tabId, sessionId },
      method,
      params,
    )) as unknown as T;
  } finally {
    noteSettle(tabId, sent);
  }
}

/** Free a child session's AXContext before it is detached.
 *
 * Same reason as the idle flush's pair: any Accessibility call leaves a
 * full-document AXContext behind, a bare `Accessibility.disable` is a no-op on
 * an agent that was never `enable`d, and a detached child session's context
 * otherwise lives until the renderer happens to garbage-collect it. Enable and
 * disable are SENT back to back without awaiting the enable — the pipe keeps
 * their order, and an awaited enable that then timed out would leave the agent
 * enabled, which is worse than what we started with. Best-effort and bounded:
 * a wedged child renderer must not hold the call. Never throws. */
export async function releaseChildAx(tabId: number, sessionId: string): Promise<void> {
  const pending = [
    cdpSession(tabId, sessionId, 'Accessibility.enable'),
    cdpSession(tabId, sessionId, 'Accessibility.disable'),
  ].map((p) => p.catch(() => undefined));
  await settleWithin(Promise.all(pending), CHILD_AX_RELEASE_DEADLINE_MS);
}

// --- idle hygiene -----------------------------------------------------------
//
// What a CDP session leaves enabled outlives the call that enabled it, for the
// whole attachment: any Accessibility.* call leaves a full-document AXContext
// (tens of MB on a big page, and every DOM mutation then pays to keep it
// current), any DOM.* call leaves the DOM agent streaming mutation events into
// this worker, remote objects in the per-call group pin whatever they point at
// (an unmounted SPA subtree included), and an opted-in console capture keeps
// every logged argument in the session's 'console' group. None of that is
// needed between calls.
//
// Released on IDLE, not per call: a per-call release turns every next call's
// first Accessibility query into a cold rebuild (fill on a 54k-node AX tree:
// 15 → 176 ms), and with `observe` that is nearly every call. A burst stays
// warm; the gap after it is freed.
//
// Idleness is CDP activity, not the tab chain alone: a tabId-less call (the
// standalone active-tab fallback, a create-own navigate) bypasses the chain,
// and the flush must never land inside it — so nothing fires while a command
// for the tab is in flight, or within HYGIENE_IDLE_MS of the last one sent or
// answered. The flush ALSO runs through the chain, so a queued call finishes
// first, and re-checks idleness there.
//
// The flush sends its commands with chrome.debugger.sendCommand directly, so
// they neither count as activity (it would re-arm itself forever) nor set
// flags. Its state is per tab and synchronously mutated, like `attached`.

/** Object group every remote object a single tool call mints belongs to, unless
 * the call manages its own group. Released by the idle flush — nothing may need
 * such an object after the call that minted it returns. */
export const CALL_GROUP = 'sallyport-call';

/** A tab with no CDP activity for this long gets its hygiene flush. */
export const HYGIENE_IDLE_MS = 10_000;

/** The whole flush stops waiting after this. Its commands are answered by the
 * renderer, and a wedged one (an unanswered dialog, a runaway script) must not
 * hold the tab chain. */
export const HYGIENE_FLUSH_DEADLINE_MS = 2_000;

/** Bound on the OOPIF child-session AX pair (`releaseChildAx`). */
const CHILD_AX_RELEASE_DEADLINE_MS = 1_000;

/** A command still unanswered this long after it was sent belongs to a call
 * the daemon has already given up on (it abandons a call at 60 s), so it no
 * longer holds the flush back. Without this cut-off ONE command Chrome never
 * answers — an `evaluate` of a promise that never settles, which the tool
 * abandons at its own deadline, a `Page.captureScreenshot` of a minimised
 * window, a child-session query after `Target.detachFromTarget` — kept the tab
 * "busy" for the rest of the attachment, and the flush never ran again. */
export const ABANDONED_COMMAND_MS = CALL_BUDGET_MS + HYGIENE_IDLE_MS;

/** How many closed tab ids `noteSend` remembers (see `removedTabs`). */
const REMOVED_TAB_MEMORY = 256;

interface TabHygiene {
  /** When a command for this tab was last sent or answered. */
  lastActivity: number;
  /** Send time of every command sent through cdp()/cdpSession() and not yet
   * answered, by token. Not a bare count: a command nobody will ever answer
   * must age out (`ABANDONED_COMMAND_MS`) rather than block the flush. */
  inFlight: Map<number, number>;
  /** An Accessibility query ran on the root session since the last flush. */
  ax: boolean;
  /** A DOM.* command ran on the root session since the last flush. */
  dom: boolean;
  /** Release the 'console' group even if this worker never saw capture on the
   * tab — set by the startup sweep, which cannot know. */
  console: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** When the armed `timer` fires. */
  timerDue: number;
  /** A flush is waiting on the tab chain. */
  queued: boolean;
  /** Created by the startup sweep for a session this worker has not proven to
   * be its own (`getTargets`' `attached` is true for a tab only DevTools holds
   * too). Its flush first sends one command and goes on only if that succeeds;
   * otherwise the record is dropped. A call's `attach()` proves it as well. */
  unproven: boolean;
}

const hygiene = new Map<number, TabHygiene>();

/** Tabs `tabs.onRemoved` reported closed. A call in flight when its tab closes
 * still sends commands afterwards (a `finally` releasing its object group, the
 * rest of `attach`), and each one used to re-create the tab's state after
 * `clearSessionState` had dropped it — an entry nothing would ever remove,
 * since the tab's one removal event had already fired. Chrome never reuses a
 * tab id within a browser session, so remembering the id is exact; bounded,
 * because the window it guards is one call long. */
const removedTabs = new Set<number>();

function rememberRemoved(tabId: number): void {
  removedTabs.delete(tabId);
  removedTabs.add(tabId);
  if (removedTabs.size > REMOVED_TAB_MEMORY) {
    const oldest = removedTabs.values().next().value;
    if (oldest !== undefined) removedTabs.delete(oldest);
  }
}

function newHygiene(): TabHygiene {
  return {
    lastActivity: 0,
    inFlight: new Map(),
    ax: false,
    dom: false,
    console: false,
    timer: undefined,
    timerDue: 0,
    queued: false,
    unproven: false,
  };
}

/** The tab's hygiene record, created only for a session that is OURS: a tab in
 * `attached` (a successful `attach()` put it there, and every detach takes it
 * out). `undefined` for anything else — a closed tab, or a tab whose session
 * ended (the human's Cancel, an explicit detach) while a call still had
 * commands in flight: such a tab is alive, so no removal event would ever drop
 * a record created for it, and its timer would keep firing flushes into a
 * session that is not there. The startup sweep's records are the one other
 * source, and they prove themselves before flushing (`TabHygiene.unproven`). */
function ownHygiene(tabId: number): TabHygiene | undefined {
  if (removedTabs.has(tabId)) return undefined;
  const existing = hygiene.get(tabId);
  if (existing) return existing;
  if (!attached.has(tabId)) return undefined;
  const st = newHygiene();
  hygiene.set(tabId, st);
  return st;
}

let nextToken = 0;

interface Sent {
  st: TabHygiene;
  token: number;
}

function noteSend(tabId: number, method: string, rootSession: boolean): Sent {
  const token = ++nextToken;
  // A tab whose session is not ours (closed, detached, never attached) gets a
  // throwaway record nothing tracks: `noteSettle` ignores state that is not
  // the tab's current entry, and no timer is armed for it.
  const st = ownHygiene(tabId);
  if (!st) return { st: newHygiene(), token };
  const now = Date.now();
  st.inFlight.set(token, now);
  st.lastActivity = now;
  if (rootSession) {
    if (
      method.startsWith('Accessibility.') &&
      method !== 'Accessibility.enable' &&
      method !== 'Accessibility.disable'
    ) {
      st.ax = true;
    } else if (method.startsWith('DOM.') && method !== 'DOM.disable') {
      st.dom = true;
    }
  }
  // Armed at SEND too, so a command that is never answered still leads to a
  // flush once it ages out — even if nothing else ever happens on the tab.
  scheduleHygiene(tabId, st);
  return { st, token };
}

function noteSettle(tabId: number, { st, token }: Sent): void {
  const sentAt = st.inFlight.get(token);
  st.inFlight.delete(token);
  // The tab's state was dropped (closed, detached) while this was in flight.
  if (hygiene.get(tabId) !== st) return;
  const now = Date.now();
  // The late answer to an abandoned command is not activity: no live call is
  // waiting for it.
  if (sentAt !== undefined && now - sentAt < ABANDONED_COMMAND_MS) st.lastActivity = now;
  scheduleHygiene(tabId, st);
}

/** Forget commands that have aged out as abandoned. Without this a command
 * Chrome never answers stayed in `inFlight` for the rest of the attachment —
 * ignored, but kept and iterated on every send and answer. Its late answer, if
 * one ever comes, finds no send time and is therefore not activity — the same
 * treatment it got while it was still listed. */
function pruneAbandoned(st: TabHygiene, now: number): void {
  for (const [token, sentAt] of st.inFlight) {
    if (now - sentAt >= ABANDONED_COMMAND_MS) st.inFlight.delete(token);
  }
}

/** The earliest moment the tab can be flushed: HYGIENE_IDLE_MS after its last
 * activity, and not before every command still in flight has either been
 * answered or aged out as abandoned. */
function flushDueAt(st: TabHygiene, now: number): number {
  let due = st.lastActivity + HYGIENE_IDLE_MS;
  for (const sentAt of st.inFlight.values()) {
    if (now - sentAt < ABANDONED_COMMAND_MS) due = Math.max(due, sentAt + ABANDONED_COMMAND_MS);
  }
  return due;
}

function isIdle(st: TabHygiene, now: number): boolean {
  return now >= flushDueAt(st, now);
}

/** Arm the tab's one timer for when it can next be flushed. A timer already
 * armed early enough is left alone — it re-checks when it fires; one armed
 * LATER (for a command that was then answered) is pulled in. */
function scheduleHygiene(tabId: number, st: TabHygiene): void {
  const now = Date.now();
  pruneAbandoned(st, now);
  if (st.queued) return;
  const due = flushDueAt(st, now);
  if (st.timer !== undefined) {
    if (st.timerDue <= due) return;
    clearTimeout(st.timer);
  }
  st.timerDue = due;
  st.timer = setTimeout(
    () => {
      st.timer = undefined;
      if (hygiene.get(tabId) !== st) return;
      if (!isIdle(st, Date.now())) {
        scheduleHygiene(tabId, st);
        return;
      }
      st.queued = true;
      void onTab(tabId, () => flushIfStillIdle(tabId, st));
    },
    Math.max(0, due - now),
  );
}

async function flushIfStillIdle(tabId: number, st: TabHygiene): Promise<void> {
  st.queued = false;
  if (hygiene.get(tabId) !== st) return;
  // A call queued ahead of us on the chain just ran: its burst is not over.
  if (!isIdle(st, Date.now())) {
    scheduleHygiene(tabId, st);
    return;
  }
  if (st.unproven && !attached.has(tabId)) {
    // A sweep record: the session may be DevTools', not ours. Its first command
    // is the proof — only an answer from our own session goes on to the rest.
    if (!(await answers(tabId, 'Runtime.releaseObjectGroup', { objectGroup: CALL_GROUP }))) {
      if (hygiene.get(tabId) === st) dropHygiene(tabId);
      return;
    }
    if (hygiene.get(tabId) !== st) return;
    st.unproven = false;
    await flushHygiene(tabId, st, false);
    return;
  }
  st.unproven = false;
  await flushHygiene(tabId, st);
}

/** Does our own session for the tab answer this command (within the flush
 * bound)? Sent like the flush's commands — not activity, sets no flag. */
async function answers(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<boolean> {
  let p: Promise<boolean>;
  try {
    p = Promise.resolve(chrome.debugger.sendCommand({ tabId }, method, params)).then(
      () => true,
      () => false,
    );
  } catch {
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), HYGIENE_FLUSH_DEADLINE_MS);
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Release what the idle tab no longer needs. Every command is SENT before
 * anything is awaited — one ordered burst on the pipe, so no command a later
 * call sends can land between them, and the Accessibility pair can never be
 * split (an enable whose disable was never sent leaves the agent enabled,
 * re-attaching a full AXContext to every new document of the tab). Best-effort
 * throughout: errors are swallowed, the wait is bounded, nothing throws. */
async function flushHygiene(tabId: number, st: TabHygiene, releaseCallGroup = true): Promise<void> {
  const releaseAx = st.ax;
  const disableDom = st.dom;
  const releaseConsole = st.console || isConsoleCaptureActive(tabId);
  st.ax = false;
  st.dom = false;
  st.console = false;

  const sent: Promise<unknown>[] = [];
  const send = (method: string, params?: Record<string, unknown>): void => {
    let p: Promise<unknown>;
    try {
      p = Promise.resolve(chrome.debugger.sendCommand({ tabId }, method, params));
    } catch (e) {
      p = Promise.reject(e);
    }
    sent.push(p.catch(() => undefined));
  };
  // Already sent (and answered) as a sweep record's proof of ownership.
  if (releaseCallGroup) send('Runtime.releaseObjectGroup', { objectGroup: CALL_GROUP });
  if (disableDom) send('DOM.disable');
  if (releaseAx) {
    // A bare disable is a no-op on an agent that was never enabled — and the
    // queries that built the context never enable it. Only the pair frees it.
    send('Accessibility.enable');
    send('Accessibility.disable');
  }
  // NOT Runtime.discardConsoleEntries: that wipes the browser-wide console
  // store, the human's own DevTools console included. Releasing the group is
  // scoped to this session.
  if (releaseConsole) send('Runtime.releaseObjectGroup', { objectGroup: 'console' });
  await settleWithin(Promise.all(sent), HYGIENE_FLUSH_DEADLINE_MS);
}

/** Test hook: whether the tab has a hygiene record, and how many of its
 * commands are still counted as in flight. */
export function hygieneStateForTest(tabId: number): { inFlight: number } | undefined {
  const st = hygiene.get(tabId);
  return st ? { inFlight: st.inFlight.size } : undefined;
}

function dropHygiene(tabId: number): void {
  const st = hygiene.get(tabId);
  if (st?.timer !== undefined) clearTimeout(st.timer);
  hygiene.delete(tabId);
}

/** Flush the tabs a previous worker left attached.
 *
 * An MV3 worker restart wipes every timer and flag above while the debugger
 * session — and the AXContext, DOM agent and object groups it holds — survives
 * it. On worker start, every tab `chrome.debugger.getTargets` reports attached
 * gets the full flush (all flags set, since nothing remembers which were used)
 * as soon as it is idle: at once for a tab nobody has driven since, through the
 * usual timer for one already in use again. `attached` there is also true for a
 * tab only DevTools holds, so a record for a tab this worker has not attached
 * starts UNPROVEN: its flush sends one command first and drops the record when
 * that fails (the debuggee is not ours) — no state and no timer outlive the
 * one attempt. Never throws. */
export async function sweepStrandedHygiene(): Promise<void> {
  try {
    const targets = await chrome.debugger.getTargets();
    for (const target of targets) {
      if (!target.attached || typeof target.tabId !== 'number') continue;
      const tabId = target.tabId;
      if (removedTabs.has(tabId)) continue;
      let st = hygiene.get(tabId);
      if (!st) {
        st = newHygiene();
        st.unproven = !attached.has(tabId);
        hygiene.set(tabId, st);
      }
      st.ax = true;
      st.dom = true;
      st.console = true;
      scheduleHygiene(tabId, st);
    }
  } catch {
    // No debugger API, or getTargets refused — nothing to sweep.
  }
}

/** Wait for `p` or `ms`, whichever is first; never rejects. The loser is not
 * cancelled — this bounds how long WE wait, not what Chrome does. */
async function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([
      p.then(
        () => undefined,
        () => undefined,
      ),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
