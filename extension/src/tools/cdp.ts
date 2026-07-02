import { getSettings } from '../storage.js';
import { clearConsole, ensureConsoleCapture } from './console-capture.js';
import { BridgeError } from './errors.js';
import { clearNetwork, ensureNetworkCapture } from './network-capture.js';
import { clearRefsForTab } from './refs.js';

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

/** Tabs on which we've enabled focus emulation (keep-awake). Tracked so that
 * turning the setting OFF actively REVOKES emulation on the next tool call —
 * `setFocusEmulationEnabled({enabled:true})` is sticky, so without this the
 * documented opt-out would silently leave the tab believing it's focused
 * (Telegram-style presence / read receipts) until detach. */
const focusEmulated = new Set<number>();

/** Decide what keep-awake should do for a tab this attach: (re-)ENABLE when the
 * setting is on (the CDP calls are idempotent), DISABLE when it's off but we
 * previously emulated this tab (revoke the sticky focus emulation), else NONE —
 * so the disable command is never issued on a tab we never emulated (keeps the
 * off-path CDP footprint minimal). Pure / unit-tested. */
export function keepAwakeAction(
  keepAwake: boolean,
  wasEmulated: boolean,
): 'enable' | 'disable' | 'none' {
  if (keepAwake) return 'enable';
  return wasEmulated ? 'disable' : 'none';
}

// The MV3 service worker always has the full chrome.*; vitest imports this
// module transitively (tabs.ts/poll.ts pull pure helpers) where it doesn't
// exist at load time — guard the top-level registrations so importing never
// demands the API surface, only calling does.
if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
    focusEmulated.delete(tabId);
    clearRefsForTab(tabId);
    clearConsole(tabId);
    clearNetwork(tabId);
  });
}

if (typeof chrome !== 'undefined' && chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) {
      attached.delete(source.tabId);
      focusEmulated.delete(source.tabId);
      clearRefsForTab(source.tabId);
      clearConsole(source.tabId);
      clearNetwork(source.tabId);
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
  // Read settings once and drive the two opt-in, best-effort features. Console
  // capture is gated here so Runtime.enable is NEVER issued on the
  // unconditional attach path — only when the user turned the setting on.
  const settings = await getSettings();
  switch (keepAwakeAction(settings.keepAwake, focusEmulated.has(tabId))) {
    case 'enable':
      await keepAwake(tabId);
      break;
    case 'disable':
      // The user turned keep-awake OFF — revoke the sticky focus emulation we
      // applied, so the tab stops believing it is focused (invariant: the
      // documented opt-out must actually take effect, not just stop re-asserting).
      await releaseKeepAwake(tabId);
      break;
  }
  if (settings.captureConsole) await ensureConsoleCapture(tabId);
  if (settings.captureNetwork) await ensureNetworkCapture(tabId);
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
    focusEmulated.add(tabId);
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
  focusEmulated.delete(tabId);
}

export async function cdp<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as unknown as T;
}
