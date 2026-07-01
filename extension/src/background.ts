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
import { dropEpoch, setBrokerMode } from './tools/ownership.js';
import { loadEpochs, persistEpochs, reconcileWithLiveTabs } from './tools/ownership-store.js';

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
  alarms: {
    create: (name, options) => chrome.alarms.create(name, options),
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
  | { type: 'LIST_TOOLS' };

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
        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: (e as Error).message });
    }
  })();
  return true; // async
});
