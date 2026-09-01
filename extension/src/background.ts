import {
  ALARM_KEEPALIVE,
  ALARM_RECONNECT,
  BridgeConnection,
  type StatusSnapshot,
  type ToolHandlerResult,
} from './bridge-connection.js';
import { BridgeError, runTool, TOOL_NAMES } from './tools.js';
import { isTrustedPopupSender } from './ipc.js';
import {
  clearSecret,
  getAllowlist,
  getSecret,
  getSettings,
  setAllowlist,
  setSecret,
  setSettings,
} from './storage.js';
import { badgeFromStatus } from './badge.js';
import { extractHostname } from './format.js';
import {
  adoptOpenedTab,
  agentTabIds,
  dropEpoch,
  getEpoch,
  markHumanTab,
  setBrokerMode,
  tabIsOrphaned,
} from './tools/ownership.js';
import { loadEpochs, persistEpochs, reconcileWithLiveTabs } from './tools/ownership-store.js';
import { sessionOfWindow, wasJustCreated } from './tools/agent-window.js';
import { releaseKeepAwakeEverywhere } from './tools/cdp.js';

async function updateBadge(snapshot: StatusSnapshot): Promise<void> {
  const { paused } = await getSettings();
  const badge = badgeFromStatus(snapshot, paused);
  try {
    await chrome.action.setBadgeBackgroundColor({ color: badge.color });
    await chrome.action.setBadgeText({ text: badge.text });
  } catch {
    // chrome.action may be unavailable in some test harnesses — ignore.
  }
}

/** Adapter from our `getSettings/setSettings` to the shape BridgeConnection
 * expects (it only needs `serverUrl` + `paused`). */
async function getSettingsForConnection(): Promise<{ serverUrl: string; paused: boolean }> {
  return await getSettings();
}

async function setSettingsForConnection(
  patch: Partial<{ serverUrl: string; paused: boolean }>,
): Promise<void> {
  await setSettings(patch);
}

const bridge = new BridgeConnection({
  storage: {
    getSecret,
    setSecret,
    clearSecret,
    getSettings: getSettingsForConnection,
    setSettings: setSettingsForConnection,
  },
  replayCache: {
    async load(): Promise<unknown> {
      const key = 'sallyport_seen_nonces';
      return (await chrome.storage.session.get(key))[key];
    },
    async save(snapshot): Promise<void> {
      await chrome.storage.session.set({ sallyport_seen_nonces: snapshot });
    },
    async clear(): Promise<void> {
      await chrome.storage.session.remove('sallyport_seen_nonces');
    },
  },
  alarms: {
    // The state machine's two call sites each pass exactly one of
    // delayInMinutes/periodInMinutes, so `options` is always a valid
    // AlarmCreateInfo; the cast bridges that to @types/chrome's discriminated
    // union, which the deliberately-loose port type can't prove structurally.
    // Wiring-shim adaptation only — no behaviour change to the reconnect logic.
    create: (name, options) => chrome.alarms.create(name, options as chrome.alarms.AlarmCreateInfo),
    clear: (name) => {
      chrome.alarms.clear(name);
    },
  },
  onStatus: (snapshot: StatusSnapshot) => {
    void updateBadge(snapshot);
    chrome.runtime.sendMessage({ type: 'STATUS', status: snapshot }).catch(() => {
      // popup not open — fine.
    });
  },
  // The daemon reports broker vs standalone in the hello_ack; the tool layer
  // reads ownership.isBrokerMode() to gate owner-scoped list_tabs + focus
  // mitigation. Re-signalled on every (re)connect, so it survives SW eviction.
  onBrokerMode: (broker: boolean) => setBrokerMode(broker),
  runTool: async (name, args): Promise<ToolHandlerResult> => {
    try {
      const data = await runTool(name, args);
      return { ok: true, data };
    } catch (e) {
      const code = e instanceof BridgeError ? e.code : 'error';
      // Forward a tool's structured failure detail (currently select_option's
      // not_found) on the error body. Additive optional key — the daemon reads
      // it only when present.
      const detail = e instanceof BridgeError ? e.detail : undefined;
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        code,
        ...(detail !== undefined ? { detail } : {}),
      };
    }
  },
  extensionVersion: chrome.runtime.getManifest().version,
  WebSocket,
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_RECONNECT) void bridge.onAlarm();
  else if (alarm.name === ALARM_KEEPALIVE) void bridge.onKeepaliveAlarm();
});

async function bootBridge(): Promise<void> {
  // Rehydrate tab-ownership epochs from session storage (survives SW eviction)
  // and prune any whose tab is gone, BEFORE the connection can carry a tool
  // call that relies on them. Best-effort; the daemon stays the authority.
  await loadEpochs();
  await reconcileWithLiveTabs();
  await bridge.start();
  // start() sets the initial state internally but only some paths call
  // pushStatus — make sure the toolbar badge is in sync on every wake-up.
  await updateBadge(bridge.status());
}

// A closed tab loses its ownership: drop its epoch so its id can't later be
// confirmed against a recycled tab, and persist the smaller map. Only persist
// when an owned tab actually went away — in standalone the map is always empty,
// so this stays a no-op for the 100% of users who never run a broker.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (dropEpoch(tabId)) void persistEpochs();
});

// A tab the PAGE opened — a target="_blank" link, a window.open, an OAuth
// popup. The browser makes it, so it has no epoch of ours, and without this it
// was a stranger to everything: owner-scoped `list_tabs` filtered it out, the
// daemon answered `tab_not_owned`, the popup's "Agent tabs" sweep never listed
// it and the reaper never counted it. A tab spawned BY a tab the caller owns is
// theirs — the call that spawned it had already passed the ownership gate on
// the opener — so it is adopted here and reported in that call's result.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined) return;
  if (adoptOpenedTab(tab.id, tab.openerTabId)) void persistEpochs();
});

// -------------------------------------------------------------------------
// "The human looked at this one" — the tab reaper's stop sign.
//
// `maxAgentTabs` lets the reaper close agent tabs to keep the browser from
// filling up (ownership.ts:planEviction). The one thing it must never do is
// close a tab a person is actually using, and the browser already tells us
// which those are: a tab the human ACTIVATED in a window they have in front of
// them, or one they dragged into a window of their own. The mark is one-way —
// nothing ever clears it — because "I looked at this once" is a permanent fact
// about that tab, and being wrong in this direction only costs one tab.
//
// The focused-window condition is what makes this usable rather than noise:
// `screenshot` makes an agent tab active INSIDE its own unfocused window (that
// is why it costs no focus), which fires exactly the same event. Without the
// check, the agent would immortalise its own tabs by screenshotting them.
// -------------------------------------------------------------------------

/** How long after we create an agent window a focus event on it is discounted
 * (see agent-window.ts:wasJustCreated). */
const HUMAN_FOCUS_GRACE_MS = 2000;

function noteHumanInterest(tabId: number | undefined): void {
  if (typeof tabId !== 'number') return;
  if (markHumanTab(tabId)) void persistEpochs();
}

async function windowIsFocused(windowId: number): Promise<boolean> {
  try {
    return (await chrome.windows.get(windowId))?.focused === true;
  } catch {
    return false; // window gone — nothing to conclude
  }
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  // Cheap synchronous bail FIRST. This fires on every tab switch the human
  // makes, all day, and in standalone the owned set is always empty — asking
  // the browser about the window before asking our own map would put a chrome
  // round-trip on a hot path that answers "not ours" essentially every time.
  if (getEpoch(tabId) === undefined) return;
  void (async () => {
    if (await windowIsFocused(windowId)) noteHumanInterest(tabId);
  })();
});

// Dragged out of the agent window into one of the human's own — an unambiguous
// "this is mine now", and the reason ownership never keys on windowId.
chrome.tabs.onAttached.addListener((tabId) => noteHumanInterest(tabId));

chrome.windows?.onFocusChanged.addListener((windowId) => {
  // WINDOW_ID_NONE: focus left Chrome entirely.
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  if (agentTabIds().size === 0) return; // nothing of ours to mark (standalone)
  if (wasJustCreated(windowId, HUMAN_FOCUS_GRACE_MS)) return;
  void (async () => {
    try {
      const [active] = await chrome.tabs.query({ active: true, windowId });
      noteHumanInterest(active?.id);
    } catch {
      // window/tab gone between the event and the query
    }
  })();
});

chrome.runtime.onStartup.addListener(() => void bootBridge());
chrome.runtime.onInstalled.addListener(() => void bootBridge());
// Service worker wakes on demand — kick off immediately on first script load.
void bootBridge();

// -------------------------------------------------------------------------
// Right-click → "Add this site to Sallyport allowlist"
//
// Skips opening the popup for the very common case of "I'm reading this
// page and I want the agent to operate here." The menu only shows on
// http(s) pages — chrome:// and friends can't be allowlisted anyway.
// -------------------------------------------------------------------------

const CTX_ADD_HOST = 'sallyport_add_current_host';

function registerContextMenu(): void {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: CTX_ADD_HOST,
        title: 'Add this site to Sallyport allowlist',
        contexts: ['page', 'link', 'frame'],
        documentUrlPatterns: ['http://*/*', 'https://*/*'],
      });
    });
  } catch {
    // contextMenus may be unavailable (test harness) — ignore.
  }
}

chrome.runtime.onInstalled.addListener(registerContextMenu);
chrome.runtime.onStartup.addListener(registerContextMenu);
registerContextMenu();

async function addHostFromContext(url: string | undefined): Promise<void> {
  const host = extractHostname(url);
  if (!host) return;
  const list = await getAllowlist();
  if (list.some((e) => e.pattern === host)) return;
  list.push({ pattern: host, allowEvaluate: false, addedAt: Date.now() });
  await setAllowlist(list);
}

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CTX_ADD_HOST) return;
  // `linkUrl` (right-click on a link) wins over `pageUrl` so the menu
  // does the obvious thing for both contexts.
  const url = info.linkUrl || info.pageUrl || tab?.url;
  void addHostFromContext(url);
});

// -------------------------------------------------------------------------
// Popup messaging
// -------------------------------------------------------------------------

type PopupMessage =
  | { type: 'GET_STATUS' }
  | { type: 'PAIR'; secret: string; serverUrl?: string }
  | { type: 'UNPAIR' }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'RECONNECT' }
  | { type: 'LIST_TOOLS' }
  | { type: 'AGENT_TABS' }
  | { type: 'CLOSE_AGENT_TABS' }
  | { type: 'KEEP_AWAKE_OFF' };

export type AgentTabRow = {
  tabId: number;
  title: string;
  url: string;
  session?: string;
  /** Its session has ended — nothing will drive this tab again. The popup
   * says so, because "which of these is still in use" is the only question a
   * human sweeping this list actually has. */
  orphaned: boolean;
};

/** The tabs agents currently own, for the popup's "Agent tabs" list.
 *
 * Read from the extension's own epoch map rather than by scanning windows: a
 * tab the human dragged out of an agent window is still an agent tab, and a
 * tab they dragged IN is still theirs. Runs in the worker because the popup has
 * no access to that state. */
async function listAgentTabs(): Promise<AgentTabRow[]> {
  const owned = agentTabIds();
  if (owned.size === 0) return [];
  const rows: AgentTabRow[] = [];
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id === undefined || !owned.has(tab.id)) continue;
    rows.push({
      tabId: tab.id,
      title: tab.title ?? '',
      url: tab.url ?? '',
      session: await sessionOfWindow(tab.windowId),
      orphaned: tabIsOrphaned(tab.id),
    });
  }
  return rows;
}

/** Close every agent-owned tab. The human's own tabs are never touched: the
 * set comes from the epoch map, which only ever holds tabs an agent created. */
async function closeAgentTabs(): Promise<number> {
  const rows = await listAgentTabs();
  for (const row of rows) {
    try {
      await chrome.tabs.remove(row.tabId);
    } catch {
      // already gone — nothing to close
    }
  }
  return rows.length;
}

chrome.runtime.onMessage.addListener((msg: PopupMessage, sender, sendResponse) => {
  // Fail-closed: only the extension's own popup may drive PAIR/UNPAIR/PAUSE/etc.
  // (defence-in-depth against a future content script / externally_connectable —
  // see ipc.ts). Reject synchronously so no message port is kept open.
  if (!isTrustedPopupSender(sender, chrome.runtime.id)) {
    sendResponse({ ok: false, error: 'untrusted sender' });
    return;
  }
  (async () => {
    try {
      switch (msg.type) {
        case 'GET_STATUS':
          sendResponse({ ok: true, status: bridge.status() });
          break;
        case 'PAIR':
          await bridge.pair(msg.secret, msg.serverUrl);
          sendResponse({ ok: true, status: bridge.status() });
          break;
        case 'UNPAIR':
          await bridge.unpair();
          sendResponse({ ok: true });
          break;
        case 'PAUSE':
          await bridge.pause();
          sendResponse({ ok: true });
          break;
        case 'RESUME':
          await bridge.resume();
          sendResponse({ ok: true });
          break;
        case 'RECONNECT':
          await bridge.reconnectNow();
          sendResponse({ ok: true, status: bridge.status() });
          break;
        case 'LIST_TOOLS':
          sendResponse({ ok: true, tools: TOOL_NAMES });
          break;
        case 'AGENT_TABS':
          sendResponse({ ok: true, tabs: await listAgentTabs() });
          break;
        case 'CLOSE_AGENT_TABS':
          sendResponse({ ok: true, closed: await closeAgentTabs() });
          break;
        case 'KEEP_AWAKE_OFF':
          // The per-tab attach path only reaches a tab the next time something
          // drives it, so without this sweep unchecking the toggle left every
          // idle tab still reporting itself focused — forever, for a tab nobody
          // drives again.
          await releaseKeepAwakeEverywhere();
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: (e as Error).message });
    }
  })();
  return true; // async
});
