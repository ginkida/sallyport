import { BridgeError } from './errors.js';
import { matchAllowlist } from '../allowlist.js';
import { getAllowlist } from '../storage.js';
import { attach } from './cdp.js';
import { ensureAllowed, hostnameOf } from './gates.js';
import { parseWaitFor, runEmbeddedWait } from './poll.js';
import { clearRefsForTab } from './refs.js';
import { agentTabIds, filterTabsToOwned, getEpoch, isBrokerMode, mintEpoch } from './ownership.js';
import { persistEpochs } from './ownership-store.js';
import { createAgentTab } from './agent-window.js';
import type { Tool } from './types.js';

/** Open a fresh tab loading `url`. In broker mode it goes into the dedicated,
 * non-focused agent window (no focus theft, kept out of the human's windows);
 * standalone opens it active in the current window, as today. */
async function openTab(url: string): Promise<chrome.tabs.Tab> {
  return isBrokerMode() ? createAgentTab(url) : chrome.tabs.create({ url, active: true });
}

/** `chrome.tabs.get`, but a vanished tab — closed, crashed, or its id recycled
 * out from under us — fails fast with a classified `tab_gone` the agent can
 * branch on ("open a fresh tab") instead of the raw "No tab with id: N", which
 * would reach the daemon as an opaque code:'error' the agent can't act on.
 * Broker mode already catches a vanished OWNED tab via the epoch confirm
 * (tools.ts:runTool); this closes the standalone path and any explicit tabId
 * that raced a tab close. */
async function getTabOrGone(tabId: number): Promise<chrome.tabs.Tab> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new BridgeError(
      'tab_gone',
      `tab ${tabId} is gone (closed, or its id was recycled) — ` +
        `open a fresh one with navigate(newTab:true)`,
    );
  }
}

/** Resolve which tab a tool should operate on.
 *
 * Stateless across calls — no "last touched tab" memo. Callers must either
 * pass `tabId` explicitly (preferred for scripted use) or accept "active
 * tab in current window" (preferred for one-off interactive commands). */
export async function resolveTab(args: Record<string, unknown>): Promise<chrome.tabs.Tab> {
  const explicit = typeof args.tabId === 'number' ? (args.tabId as number) : null;
  if (explicit !== null) {
    return await getTabOrGone(explicit);
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
      // A tab closed/recycled in the gap between create/update and this get makes
      // Chrome call back with `tab === undefined` + runtime.lastError (reading it
      // clears the "Unchecked runtime.lastError" warning). Without this guard
      // `ready(undefined)` throws inside the callback, Chrome swallows it, the
      // promise never settles, and the call hangs to the full timeout with a
      // misleading code:'timeout'. Fail fast with the same tab_gone getTabOrGone uses.
      if (chrome.runtime?.lastError || !tab) {
        clearTimeout(t);
        reject(
          new BridgeError(
            'tab_gone',
            `tab ${tabId} is gone (closed, or its id was recycled) — ` +
              `open a fresh one with navigate(newTab:true)`,
          ),
        );
        return;
      }
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
  const tabs = all.map((t) => ({
    tabId: t.id,
    url: t.url ?? '',
    title: t.title ?? '',
    active: t.active,
    windowId: t.windowId,
  }));
  // Owner-scope in broker mode: only the agent-created tabs leave the browser,
  // so the human's tab metadata never crosses the wire. The daemon scopes again
  // per-client (fail-closed). Standalone returns the whole profile as before.
  return {
    data: { tabs: isBrokerMode() ? filterTabsToOwned(tabs, agentTabIds()) : tabs },
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
  const waitSpec = parseWaitFor(args.waitFor, 'navigate');
  const list = await getAllowlist();
  if (!matchAllowlist(url, list).matched) {
    throw new BridgeError('domain_not_allowed', `${hostnameOf(url)} is not in the allowlist`);
  }
  const newTab = !!args.newTab;
  // Broker mode has no active-tab fallback (invariant #13): a navigate with no
  // explicit tabId is a CREATE-OWN (a fresh owned tab), never a clobber of
  // whatever tab the human happens to have focused. Standalone keeps today's
  // resolveTab behaviour (explicit tabId, else active tab).
  const createOwn = newTab || (isBrokerMode() && typeof args.tabId !== 'number');
  let tab: chrome.tabs.Tab;
  let created = false;
  if (createOwn) {
    tab = await openTab(url);
    created = true;
  } else {
    tab = await resolveTab(args);
    const current = tab.url ?? '';
    if (current.startsWith('chrome://') || current.startsWith('edge://')) {
      // Browser-internal page: can't navigate it in place, and there is no
      // user content to lose — open the target in a fresh tab instead.
      tab = await openTab(url);
      created = true;
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
  // Ownership epoch (broker mode only): a created tab mints a fresh epoch (the
  // daemon records ownership from it); an in-place navigate echoes the existing
  // one. The daemon ignores `epoch` in standalone, so we don't mint there.
  let epoch: string | undefined;
  if (isBrokerMode()) {
    epoch = created ? mintEpoch(tab.id!) : getEpoch(tab.id!);
    if (created) await persistEpochs();
  }
  let wait = null;
  if (waitSpec) {
    // "Loaded" (tab status complete) rarely means "rendered" on SPAs — the
    // embedded wait covers the gap to the element/text actually appearing,
    // saving the follow-up wait_for round-trip. Needs CDP, so attach here
    // (navigate alone doesn't).
    await attach(tab.id!);
    wait = await runEmbeddedWait(tab.id!, waitSpec);
  }
  return {
    tabId: tab.id,
    url,
    data: { tabId: tab.id, url, ...(epoch ? { epoch } : {}), ...(wait ? { wait } : {}) },
  };
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
  const tab = await getTabOrGone(tabId);
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
