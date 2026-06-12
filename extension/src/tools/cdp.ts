import { getSettings } from '../storage.js';
import { clearRefsForTab } from './refs.js';

/** One CDP attachment per tab. Detach happens when the tab closes or the
 * user clicks "Cancel" on the debugger banner — we listen for both so the
 * set stays accurate without polling. */
const attached = new Set<number>();

// The MV3 service worker always has the full chrome.*; vitest imports this
// module transitively (tabs.ts/poll.ts pull pure helpers) where it doesn't
// exist at load time — guard the top-level registrations so importing never
// demands the API surface, only calling does.
if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
    clearRefsForTab(tabId);
  });
}

if (typeof chrome !== 'undefined' && chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) {
      attached.delete(source.tabId);
      clearRefsForTab(source.tabId);
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
      if (!msg.includes('already attached')) throw e;
      attached.add(tabId);
    }
  }
  await keepAwake(tabId);
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
 * turns this off. */
async function keepAwake(tabId: number): Promise<void> {
  const settings = await getSettings();
  if (!settings.keepAwake) return;
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

export async function cdp<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as unknown as T;
}
