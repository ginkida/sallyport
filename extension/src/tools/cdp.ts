import { getSettings } from '../storage.js';
import { clearConsole, ensureConsoleCapture } from './console-capture.js';
import { clearDialogs, ensureDialogCapture, releaseDialogCapture } from './dialog-capture.js';
import { BridgeError } from './errors.js';
import { clearNetwork, ensureNetworkCapture } from './network-capture.js';
import { clearRefsForTab } from './refs.js';

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
if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
    clearRefsForTab(tabId);
    clearConsole(tabId);
    clearNetwork(tabId);
    clearDialogs(tabId);
    emulatedDsf.delete(tabId);
  });
}

if (typeof chrome !== 'undefined' && chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) {
      attached.delete(source.tabId);
      clearRefsForTab(source.tabId);
      clearConsole(source.tabId);
      clearNetwork(source.tabId);
      clearDialogs(source.tabId);
      // The emulation dies with the session — and so must our record of it, or
      // a later capture would size itself against an emulation that is gone.
      emulatedDsf.delete(source.tabId);
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
  if (settings.captureNetwork) await ensureNetworkCapture(tabId);
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
 * attached, is simply not our problem. `chrome.debugger.onDetach` does the
 * bookkeeping (attached set, refs, capture rings). */
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
  attached.delete(tabId);
}

export async function cdp<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as unknown as T;
}

/** Send a command to a flat child protocol session (notably an OOPIF target)
 * while retaining the root tab as the debuggee. Chrome exposes sessionId on
 * DebuggerSession for exactly this routing. */
export async function cdpSession<T = unknown>(
  tabId: number,
  sessionId: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return (await chrome.debugger.sendCommand({ tabId, sessionId }, method, params)) as unknown as T;
}
