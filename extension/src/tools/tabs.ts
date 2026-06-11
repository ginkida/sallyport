import { BridgeError } from './errors.js';
import { matchAllowlist } from '../allowlist.js';
import { getAllowlist } from '../storage.js';
import { ensureAllowed, hostnameOf } from './gates.js';
import { clearRefsForTab } from './refs.js';
import type { Tool } from './types.js';

/** Resolve which tab a tool should operate on.
 *
 * Stateless across calls — no "last touched tab" memo. Callers must either
 * pass `tabId` explicitly (preferred for scripted use) or accept "active
 * tab in current window" (preferred for one-off interactive commands). */
export async function resolveTab(args: Record<string, unknown>): Promise<chrome.tabs.Tab> {
  const explicit = typeof args.tabId === 'number' ? (args.tabId as number) : null;
  if (explicit !== null) {
    return await chrome.tabs.get(explicit);
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active || active.id === undefined) {
    throw new BridgeError('no_active_tab', 'no active tab in current window');
  }
  return active;
}

export function waitForLoad(tabId: number, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new BridgeError('timeout', 'navigate: page load timeout'));
    }, timeoutMs);
    const ready = (tab: chrome.tabs.Tab) =>
      tab.status === 'complete' && !!tab.url && tab.url !== 'about:blank';
    const listener = (id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (id === tabId && info.status === 'complete' && ready(tab)) {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.get(tabId, (tab) => {
      if (ready(tab)) {
        clearTimeout(t);
        resolve();
      } else {
        chrome.tabs.onUpdated.addListener(listener);
      }
    });
  });
}

export const listTabs: Tool = async () => {
  const all = await chrome.tabs.query({});
  return {
    data: {
      tabs: all.map((t) => ({
        tabId: t.id,
        url: t.url ?? '',
        title: t.title ?? '',
        active: t.active,
        windowId: t.windowId,
      })),
    },
  };
};

/** A tab that holds no user content, so navigating over it discards nothing
 * and needs no allowlist check on the page being replaced. Browser-internal
 * pages (chrome://, edge://) are handled separately — opened in a fresh tab —
 * so they are intentionally not listed here. */
export function isBlankTarget(url: string | undefined): boolean {
  if (!url) return true;
  return url === 'about:blank' || url === 'about:newtab';
}

export const navigate: Tool = async (args) => {
  const url = String(args.url || '');
  if (!url) throw new BridgeError('bad_args', 'navigate: url required');
  try {
    new URL(url);
  } catch {
    throw new BridgeError('bad_args', 'navigate: url is not a valid URL');
  }
  const list = await getAllowlist();
  if (!matchAllowlist(url, list).matched) {
    throw new BridgeError('domain_not_allowed', `${hostnameOf(url)} is not in the allowlist`);
  }
  const newTab = !!args.newTab;
  let tab: chrome.tabs.Tab;
  if (newTab) {
    tab = await chrome.tabs.create({ url, active: true });
  } else {
    tab = await resolveTab(args);
    const current = tab.url ?? '';
    if (current.startsWith('chrome://') || current.startsWith('edge://')) {
      // Browser-internal page: can't navigate it in place, and there is no
      // user content to lose — open the target in a fresh tab instead.
      tab = await chrome.tabs.create({ url, active: true });
    } else {
      // Reusing an existing tab DESTROYS whatever it currently holds. If that
      // page is real content that isn't itself allowlisted, refuse — otherwise
      // an agent could enumerate tabs via `list_tabs` and clobber a banking /
      // email tab or an in-progress form by navigating it to an allowlisted
      // URL, the exact loss `close_tab` is gated against (invariant #12).
      // Blank tabs (about:blank / new-tab) hold nothing, so they pass.
      if (!isBlankTarget(current) && !matchAllowlist(current, list).matched) {
        throw new BridgeError(
          'domain_not_allowed',
          `navigate: refusing to replace non-allowlisted tab ${hostnameOf(current)} — ` +
            `pass newTab=true to open ${hostnameOf(url)} in a new tab instead`,
        );
      }
      await chrome.tabs.update(tab.id!, { url });
    }
  }
  await waitForLoad(tab.id!);
  // Navigation invalidates any refs we held for this tab.
  clearRefsForTab(tab.id!);
  return { tabId: tab.id, url, data: { tabId: tab.id, url } };
};

export const closeTab: Tool = async (args) => {
  const tabId = typeof args.tabId === 'number' ? args.tabId : null;
  if (tabId === null) {
    throw new BridgeError('bad_args', 'close_tab: tabId required');
  }
  // Allowlist-gated like every other DOM-touching tool. Without this an
  // agent could enumerate tabs via list_tabs and selectively close any
  // non-allowlisted ones (banking, email, in-progress forms), losing user
  // work behind the allowlist's back.
  const tab = await chrome.tabs.get(tabId);
  await ensureAllowed(tab.url);
  await chrome.tabs.remove(tabId);
  return { tabId, url: tab.url, data: { closed: tabId } };
};

export const reload: Tool = async (args) => {
  const tab = await resolveTab(args);
  // Allowlist gate: reloading the page exposes whatever it loads to our
  // subsequent tools, so apply the same domain check as snapshot/read_text.
  await ensureAllowed(tab.url);
  const bypassCache = args.bypassCache === true;
  await chrome.tabs.reload(tab.id!, { bypassCache });
  await waitForLoad(tab.id!);
  // A reload invalidates any refs we may have built for this tab.
  clearRefsForTab(tab.id!);
  return {
    tabId: tab.id,
    url: tab.url,
    data: { tabId: tab.id, url: tab.url, bypassCache },
  };
};
