/** Dedicated agent windows for broker mode (focus-theft mitigation, decision #7).
 *
 * Agent-created tabs open in a non-focused window kept out of the human's own
 * windows, so automation never steals focus (`focused:false`, `active:false`)
 * and never clutters their workspace. Ownership never keys on `windowId` — the
 * human may drag a tab out — so this is pure presentation; the daemon's
 * `(clientId,tabId,epoch)` registry is unaffected.
 *
 * ONE WINDOW PER SESSION, keyed by the session's cosmetic label. With several
 * agents driving one browser, a single shared window interleaves everyone's
 * tabs into an unreadable strip; per-session windows make "what is this agent
 * doing" and "close everything that session left behind" answerable at a
 * glance. Sessions without a label (or standalone) share one unlabelled window,
 * which is exactly the previous behaviour.
 *
 * These windows are ORDINARY windows in the human's own profile — same cookie
 * jar, same logins, same everything. An agent working on a site the human is
 * signed into is signed in too. Nothing here uses `incognito` or a separate
 * profile, and nothing should: the separation this project provides is about
 * WHO MAY DRIVE WHICH TAB, not about identity.
 *
 * Window ids are remembered in `chrome.storage.session` so they survive an MV3
 * service-worker eviction (otherwise each wake would spawn fresh windows). If
 * the human closed one, the next create lazily makes another.
 *
 * Chrome-bound, so it sits outside the vitest coverage gate; it is exercised by
 * the navigate tests' chrome mock and by manual `sallyport-daemon exec`. */

import { BridgeError } from './errors.js';

const WIN_KEY = 'sallyport_agent_windows';
/** Session label → window id. The empty string is the unlabelled/shared slot. */
let windowBySession = new Map<string, number>();
/** Window id → when we created it. Memory-only and deliberately so: it exists
 * to discount a focus event caused by our OWN create, and after a service
 * worker restart no window is newly created any more. */
const createdAt = new Map<number, number>();
/** How long a creation timestamp is worth keeping. Comfortably longer than the
 * grace any caller asks `wasJustCreated` for. */
const CREATED_AT_TTL_MS = 60_000;
/** In-flight load of the persisted map, memoised. A boolean `loaded` flag set
 * BEFORE its own await would let a second concurrent caller skip the load and
 * read an empty map — which, with concurrent calls, means two windows. */
let loading: Promise<void> | null = null;
/** In-flight window creation per session, memoised for the same reason: two
 * concurrent create-own navigates would otherwise each pass the null check and
 * each create a window, permanently orphaning one of them. */
const creating = new Map<string, Promise<chrome.windows.Window>>();

function slot(session?: string): string {
  return session ?? '';
}

async function loadWindows(): Promise<void> {
  loading ??= (async () => {
    try {
      const got = await chrome.storage.session.get(WIN_KEY);
      const raw = (got as Record<string, unknown>)[WIN_KEY];
      const next = new Map<string, number>();
      if (raw && typeof raw === 'object') {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof value === 'number') next.set(key, value);
        }
      }
      windowBySession = next;
    } catch {
      windowBySession = new Map();
    }
  })();
  await loading;
}

async function persistWindows(): Promise<void> {
  try {
    await chrome.storage.session.set({ [WIN_KEY]: Object.fromEntries(windowBySession) });
  } catch {
    // best-effort: a failed persist only risks an extra window next SW wake.
  }
}

/** Create the session's agent window, restoring the human's focus afterwards.
 *
 * `focused:false` is the primary mitigation, but it is a request to the window
 * manager rather than a guarantee (macOS in particular has a long history of
 * activating new windows anyway). Re-focusing whatever window the human had is
 * a cheap belt on a platform-dependent flag: if `focused:false` was honoured
 * this is a no-op, and if it wasn't, the human keeps their place. */
async function createWindowFor(session: string, url: string): Promise<chrome.windows.Window> {
  let previous: number | undefined;
  try {
    previous = (await chrome.windows.getLastFocused())?.id;
  } catch {
    previous = undefined;
  }
  const win = await chrome.windows.create({ url, focused: false });
  if (!win) {
    // @types/chrome models windows.create as possibly resolving undefined.
    // Presentation-only (invariant #13 keys on tabId, never windowId), so
    // surface the rare failure explicitly instead of crashing below.
    throw new BridgeError('window_create_failed', 'could not create the agent window');
  }
  if (previous !== undefined && win.id !== previous) {
    try {
      const focused = await chrome.windows.getLastFocused();
      if (focused?.id === win.id) await chrome.windows.update(previous, { focused: true });
    } catch {
      // window gone / API unavailable — nothing to restore
    }
  }
  if (win.id !== undefined) {
    windowBySession.set(session, win.id);
    // Prune first: entries are only consulted for a couple of seconds after a
    // create (`wasJustCreated`), so anything older is dead weight in a worker
    // that may run for hours.
    const now = Date.now();
    for (const [id, at] of createdAt) if (now - at > CREATED_AT_TTL_MS) createdAt.delete(id);
    createdAt.set(win.id, now);
    await persistWindows();
  }
  return win;
}

/** Add a tab to an existing agent window. */
async function tabInWindow(windowId: number, url: string): Promise<chrome.tabs.Tab> {
  return await chrome.tabs.create({ windowId, url, active: false });
}

/** Mute an agent tab: an agent has no use for audio, and a page autoplaying
 * from a window nobody is looking at is a genuinely hard thing for the human to
 * track down. A courtesy, never a reason to fail the navigate. */
async function muteQuietly(tab: chrome.tabs.Tab | undefined): Promise<void> {
  if (tab?.id === undefined) return;
  try {
    await chrome.tabs.update(tab.id, { muted: true });
  } catch {
    // tab vanished / API unavailable
  }
}

/** Create a new agent-owned tab loading `url` in the calling session's
 * dedicated, non-focused agent window. The tab is never made active, so the
 * human's focus is never stolen. */
export async function createAgentTab(url: string, session?: string): Promise<chrome.tabs.Tab> {
  const key = slot(session);
  await loadWindows();

  const known = windowBySession.get(key);
  if (known !== undefined) {
    try {
      await chrome.windows.get(known); // throws if the human closed it
    } catch {
      windowBySession.delete(key);
      await persistWindows();
    }
    if (windowBySession.has(key)) {
      const tab = await tabInWindow(known, url);
      await muteQuietly(tab);
      return tab;
    }
  }

  // Memoise the creation itself: two concurrent create-own navigates for the
  // same session would otherwise each pass the check above and each create a
  // window, permanently orphaning one of them.
  let pending = creating.get(key);
  const isCreator = pending === undefined;
  if (pending === undefined) {
    pending = createWindowFor(key, url);
    creating.set(key, pending);
    void pending.catch(() => undefined).then(() => creating.delete(key));
  }
  const win = await pending;

  if (!isCreator) {
    // Someone else's create made the window (and consumed its first tab for
    // their own url) — take a second tab in it.
    const tab = await tabInWindow(win.id ?? -1, url);
    await muteQuietly(tab);
    return tab;
  }
  // A fresh window is created WITH the url, so its first tab already IS the
  // requested page — no blank tab to navigate afterwards.
  const first = win.tabs?.[0] ?? (await chrome.tabs.query({ windowId: win.id }))[0];
  await muteQuietly(first);
  return first;
}

/** The set of window ids currently used for agent tabs — the popup lists them
 * so the human can see (and close) what the agents left behind. */
export async function agentWindowIds(): Promise<Set<number>> {
  await loadWindows();
  return new Set(windowBySession.values());
}

/** Which session a given agent window belongs to (''/undefined for the shared
 * unlabelled one). Used by the popup to group what it lists. */
export async function sessionOfWindow(windowId: number | undefined): Promise<string | undefined> {
  if (typeof windowId !== 'number') return undefined;
  await loadWindows();
  for (const [session, id] of windowBySession) {
    if (id === windowId) return session || undefined;
  }
  return undefined;
}

/** Did WE create this window in the last `graceMs`?
 *
 * `chrome.windows.create({focused:false})` is a request, not a guarantee —
 * macOS in particular has a history of activating a new window anyway, which is
 * why `createWindowFor` restores the human's window afterwards. That brief
 * flash still fires `windows.onFocusChanged` for the agent window, and the
 * listener that reads focus as "the human is looking at this tab" would take it
 * at face value and make the session's first tab permanently un-reapable. A
 * window the human deliberately raised is never one we made a moment ago. */
export function wasJustCreated(windowId: number, graceMs: number): boolean {
  const at = createdAt.get(windowId);
  return at !== undefined && Date.now() - at < graceMs;
}

/** Whether `windowId` is one of ours. `screenshot` uses this to decide whether
 * activating a tab is free: making a tab active inside a window that is NOT
 * focused costs the human nothing, but doing it in one of THEIR windows would
 * yank the tab they were reading. */
export async function isAgentWindow(windowId: number | undefined): Promise<boolean> {
  if (typeof windowId !== 'number') return false;
  return (await agentWindowIds()).has(windowId);
}

/** Reset in-memory window state (test hook; also a clean slate on unpair). */
export function resetAgentWindow(): void {
  windowBySession = new Map();
  loading = null;
  creating.clear();
  createdAt.clear();
}
