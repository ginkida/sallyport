/** Dedicated agent window for broker mode (focus-theft mitigation, decision #7).
 *
 * Every agent-created tab opens in ONE non-focused window kept out of the
 * human's windows, so automation never steals focus (`focused:false`,
 * `active:false`) and never clutters the human's workspace. Ownership never
 * keys on `windowId` — the human may drag a tab out — so this is pure
 * presentation; the daemon's `(clientId,tabId,epoch)` registry is unaffected.
 *
 * The window id is remembered in `chrome.storage.session` so it survives an MV3
 * service-worker eviction (otherwise each wake would spawn a fresh agent
 * window). If the human closed it, the next create lazily makes a new one.
 *
 * Chrome-bound, so it sits outside the vitest coverage gate; it is exercised by
 * the navigate tests' chrome mock and by manual `sallyport-daemon exec`. */

import { BridgeError } from './errors.js';

const WIN_KEY = 'sallyport_agent_window';
let agentWindowId: number | null = null;
let loaded = false;

async function loadWindowId(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const got = await chrome.storage.session.get(WIN_KEY);
    const v = (got as Record<string, unknown>)[WIN_KEY];
    agentWindowId = typeof v === 'number' ? v : null;
  } catch {
    agentWindowId = null;
  }
}

async function rememberWindowId(id: number | null): Promise<void> {
  agentWindowId = id;
  try {
    if (id === null) await chrome.storage.session.remove(WIN_KEY);
    else await chrome.storage.session.set({ [WIN_KEY]: id });
  } catch {
    // best-effort: a failed persist only risks an extra window next SW wake.
  }
}

/** Create a new agent-owned tab loading `url` in the dedicated, non-focused
 * agent window (created lazily the first time, reused after). The new tab is
 * never made active, so the human's focus is never stolen. */
export async function createAgentTab(url: string): Promise<chrome.tabs.Tab> {
  await loadWindowId();
  if (agentWindowId !== null) {
    try {
      await chrome.windows.get(agentWindowId); // throws if the human closed it
      return await chrome.tabs.create({ windowId: agentWindowId, url, active: false });
    } catch {
      await rememberWindowId(null); // stale — fall through and recreate
    }
  }
  const win = await chrome.windows.create({ url, focused: false });
  if (!win) {
    // @types/chrome now models windows.create as possibly resolving undefined.
    // Presentation-only (invariant #13 keys on tabId, never windowId), so surface
    // the rare failure explicitly instead of crashing on win.tabs/win.id below.
    throw new BridgeError('window_create_failed', 'could not create the agent window');
  }
  await rememberWindowId(win.id ?? null);
  const tab = win.tabs?.[0];
  if (tab) return tab;
  // Defensive: some Chrome builds omit `tabs` on the create result — look it up.
  const [t] = await chrome.tabs.query({ windowId: win.id });
  return t;
}

/** Reset in-memory window state (test hook; also a clean slate on unpair). */
export function resetAgentWindow(): void {
  agentWindowId = null;
  loaded = false;
}
