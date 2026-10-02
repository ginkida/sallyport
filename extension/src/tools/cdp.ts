import { getSettings } from '../storage.js';
import { clearConsole, ensureConsoleCapture, isConsoleCaptureActive } from './console-capture.js';
import { clearDialogs, ensureDialogCapture, releaseDialogCapture } from './dialog-capture.js';
import { BridgeError } from './errors.js';
import { clearNetwork, ensureNetworkCapture } from './network-capture.js';
import { clearRefsForTab } from './refs.js';
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
function clearTabState(tabId: number): void {
  attached.delete(tabId);
  clearRefsForTab(tabId);
  clearConsole(tabId);
  clearNetwork(tabId);
  clearDialogs(tabId);
  emulatedDsf.delete(tabId);
  dropHygiene(tabId);
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener(clearTabState);
}

if (typeof chrome !== 'undefined' && chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) {
      clearTabState(source.tabId);
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
  if (settings.captureConsole) await ensureConsoleCapture(tabId);
  else clearConsole(tabId);
  if (settings.captureNetwork) await ensureNetworkCapture(tabId);
  else clearNetwork(tabId);
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
 * Deliberately NOT covered: paint. visibilityState stays 'hidden' and no
 * frames render, so `screenshot` still needs the tab actually visible
 * (`tab_not_visible` / bringToFront). Side effect worth knowing: a page
 * that believes it is active behaves like one (Telegram sends read
 * receipts / presence) — the popup setting "Keep automated tabs awake"
 * turns this off, and the next tool call then actively DISABLES the focus
 * emulation on the driven tab (see `releaseKeepAwake`), not merely stops
 * re-asserting it. */
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
 * whatever else is running). That left three things the human sees, long after
 * the agent that caused them is gone: Chrome's "started debugging this browser"
 * bar, a disabled back/forward cache on that tab, and a sticky
 * `setFocusEmulationEnabled` making the page believe it is focused. Detaching
 * clears all three — every CDP override ends with the session.
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
  clearTabState(tabId);
}

export async function cdp<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const st = noteSend(tabId, method, true);
  try {
    return (await chrome.debugger.sendCommand({ tabId }, method, params)) as unknown as T;
  } finally {
    noteSettle(tabId, st);
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
  const st = noteSend(tabId, method, false);
  try {
    return (await chrome.debugger.sendCommand(
      { tabId, sessionId },
      method,
      params,
    )) as unknown as T;
  } finally {
    noteSettle(tabId, st);
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

interface TabHygiene {
  /** When a command for this tab was last sent or answered. */
  lastActivity: number;
  /** Commands sent through cdp()/cdpSession() and not yet answered. */
  inFlight: number;
  /** An Accessibility query ran on the root session since the last flush. */
  ax: boolean;
  /** A DOM.* command ran on the root session since the last flush. */
  dom: boolean;
  /** Release the 'console' group even if this worker never saw capture on the
   * tab — set by the startup sweep, which cannot know. */
  console: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** A flush is waiting on the tab chain. */
  queued: boolean;
}

const hygiene = new Map<number, TabHygiene>();

function hygieneFor(tabId: number): TabHygiene {
  let st = hygiene.get(tabId);
  if (!st) {
    st = {
      lastActivity: 0,
      inFlight: 0,
      ax: false,
      dom: false,
      console: false,
      timer: undefined,
      queued: false,
    };
    hygiene.set(tabId, st);
  }
  return st;
}

function noteSend(tabId: number, method: string, rootSession: boolean): TabHygiene {
  const st = hygieneFor(tabId);
  st.inFlight += 1;
  st.lastActivity = Date.now();
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
  return st;
}

function noteSettle(tabId: number, st: TabHygiene): void {
  st.inFlight = Math.max(0, st.inFlight - 1);
  // The tab's state was dropped (closed, detached) while this was in flight.
  if (hygiene.get(tabId) !== st) return;
  st.lastActivity = Date.now();
  if (st.inFlight === 0) scheduleHygiene(tabId, st);
}

function isIdle(st: TabHygiene, now: number): boolean {
  return st.inFlight === 0 && now - st.lastActivity >= HYGIENE_IDLE_MS;
}

/** Arm the tab's one timer for when it will have been idle long enough. A
 * timer already armed is left alone — it re-checks when it fires. */
function scheduleHygiene(tabId: number, st: TabHygiene): void {
  if (st.timer !== undefined || st.queued) return;
  const wait = Math.max(0, st.lastActivity + HYGIENE_IDLE_MS - Date.now());
  st.timer = setTimeout(() => {
    st.timer = undefined;
    if (hygiene.get(tabId) !== st) return;
    // A command in flight re-arms the timer when it is answered.
    if (st.inFlight > 0) return;
    if (!isIdle(st, Date.now())) {
      scheduleHygiene(tabId, st);
      return;
    }
    st.queued = true;
    void onTab(tabId, () => flushIfStillIdle(tabId, st));
  }, wait);
}

async function flushIfStillIdle(tabId: number, st: TabHygiene): Promise<void> {
  st.queued = false;
  if (hygiene.get(tabId) !== st || st.inFlight > 0) return;
  // A call queued ahead of us on the chain just ran: its burst is not over.
  if (!isIdle(st, Date.now())) {
    scheduleHygiene(tabId, st);
    return;
  }
  await flushHygiene(tabId, st);
}

/** Release what the idle tab no longer needs. Every command is SENT before
 * anything is awaited — one ordered burst on the pipe, so no command a later
 * call sends can land between them, and the Accessibility pair can never be
 * split (an enable whose disable was never sent leaves the agent enabled,
 * re-attaching a full AXContext to every new document of the tab). Best-effort
 * throughout: errors are swallowed, the wait is bounded, nothing throws. */
async function flushHygiene(tabId: number, st: TabHygiene): Promise<void> {
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
  send('Runtime.releaseObjectGroup', { objectGroup: CALL_GROUP });
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
 * tab only DevTools holds — the commands then simply fail, since the debuggee
 * is not ours. Never throws. */
export async function sweepStrandedHygiene(): Promise<void> {
  try {
    const targets = await chrome.debugger.getTargets();
    for (const target of targets) {
      if (!target.attached || typeof target.tabId !== 'number') continue;
      const st = hygieneFor(target.tabId);
      st.ax = true;
      st.dom = true;
      st.console = true;
      scheduleHygiene(target.tabId, st);
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
