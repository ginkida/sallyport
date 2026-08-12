import { BridgeError } from './errors.js';
import { matchAllowlist } from '../allowlist.js';
import { getAllowlist } from '../storage.js';
import { attach } from './cdp.js';
import { clearArmedDialog } from './dialog-capture.js';
import { ensureAllowed, hostnameOf } from './gates.js';
import { parseWaitFor, runEmbeddedWait } from './poll.js';
import { clearRefsForTab } from './refs.js';
import { agentTabIds, filterTabsToOwned, getEpoch, isBrokerMode, mintEpoch } from './ownership.js';
import { persistEpochs } from './ownership-store.js';
import { createAgentTab } from './agent-window.js';
import type { Tool } from './types.js';

/** Open a fresh tab loading `url`. In broker mode it goes into the calling
 * session's dedicated, non-focused agent window (no focus theft, kept out of
 * the human's windows, one window per session so it stays legible with several
 * agents running); standalone opens it active in the current window, as today. */
async function openTab(url: string, session?: string): Promise<chrome.tabs.Tab> {
  return isBrokerMode() ? createAgentTab(url, session) : chrome.tabs.create({ url, active: true });
}

/** `chrome.tabs.get`, but a vanished tab — closed, crashed, or its id recycled
 * out from under us — fails fast with a classified `tab_gone` the agent can
 * branch on ("open a fresh tab") instead of the raw "No tab with id: N", which
 * would reach the daemon as an opaque code:'error' the agent can't act on.
 * Broker mode already catches a vanished OWNED tab via the epoch confirm
 * (tools.ts:runTool); this closes the standalone path and any explicit tabId
 * that raced a tab close. Exported for history.ts's own post-hop tab lookup —
 * any `chrome.tabs.get` call on a tabId we don't already trust as live should
 * go through this, not the raw API. */
export async function getTabOrGone(tabId: number): Promise<chrome.tabs.Tab> {
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

/** `attach()`, but a failure (most commonly `attach_debugger_conflict` — the
 * human has DevTools open on this exact tab) never propagates. Capture
 * (dialog/console/network) and keep-awake are a CONVENIENCE layered on top of
 * the navigation, not a requirement for it — `chrome.tabs.update`/`.create`/
 * `.reload` work with or without a debugger attached, and navigate/reload
 * must keep working even when CDP can't get a foothold on the tab (a routine
 * situation given this project's own usage model: an agent driving the
 * user's own live Chrome profile, where the user may have DevTools open on
 * the very tab being automated). */
async function bestEffortAttach(tabId: number): Promise<void> {
  try {
    await attach(tabId);
  } catch {
    // best-effort — see doc comment. A tool that genuinely NEEDS CDP (e.g.
    // an embedded waitFor's polling) will surface its own error from the
    // debugger calls it makes, same as if attach() were never called at all.
  }
}

/** Where the tab is NOW, best-effort.
 *
 * Deliberately non-throwing, unlike `getTabOrGone`: this runs at the very end of
 * a navigate/reload that has already succeeded, purely to report where the tab
 * actually ended up. A tab closed in that last instant is not a reason to turn a
 * completed navigation into an error — the caller falls back to the URL it
 * asked for, which is what it used to report unconditionally. */
async function currentUrl(tabId: number): Promise<string | undefined> {
  try {
    return (await chrome.tabs.get(tabId)).url;
  } catch {
    return undefined;
  }
}

/** Did the tab end up somewhere other than where it was sent?
 *
 * Compares PARSED urls, so the browser's own normalisation — adding the empty
 * path to `https://example.com`, lower-casing the host — does not read as a
 * redirect and cry wolf on every second navigate. Unparseable input (which
 * `navigate` rejects up front anyway) falls back to a string compare rather
 * than claiming no redirect happened. Pure, so the normalisation is testable
 * without chrome. */
export function landedElsewhere(requested: string, landed: string | undefined): boolean {
  if (!landed) return false;
  try {
    return new URL(requested).href !== new URL(landed).href;
  } catch {
    return requested !== landed;
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

/** `toolName` names the message on a watchdog timeout — navigate/reload/
 * history_go all share this watchdog, and the error text must name whichever
 * one the agent actually called so a loop keying on the message (not just the
 * `timeout` code) retries the right tool. */
export function waitForLoad(tabId: number, toolName: string, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new BridgeError('timeout', `${toolName}: page load timeout`));
    }, timeoutMs);
    const ready = (tab: chrome.tabs.Tab) =>
      tab.status === 'complete' && !!tab.url && tab.url !== 'about:blank';
    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
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

export const navigate: Tool = async (args, ctx) => {
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
    tab = await openTab(url, ctx?.client);
    created = true;
    // Attach right away so any capture opted into (console/network/dialog)
    // is live for the page's OWN load, not just from the next tool call —
    // matters most for dialog handling: a dialog on first load would
    // otherwise freeze the page with no one listening. Inherent race for a
    // brand-new tab (it starts loading `url` at creation, before this
    // resolves) — best effort, strictly better than not attaching until
    // whatever tool call happens to come next. Best-effort so an attach
    // failure can't abort the call before the epoch mint below runs (which
    // would otherwise orphan the just-created tab: created but unowned).
    await bestEffortAttach(tab.id!);
  } else {
    tab = await resolveTab(args);
    const current = tab.url ?? '';
    if (current.startsWith('chrome://') || current.startsWith('edge://')) {
      // Browser-internal page: can't navigate it in place, and there is no
      // user content to lose — open the target in a fresh tab instead.
      tab = await openTab(url, ctx?.client);
      created = true;
      await bestEffortAttach(tab.id!);
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
      // Attach BEFORE issuing the navigation (not after) — an EXISTING tab
      // lets us close the race entirely: Page.enable lands before the new
      // document can start executing scripts, so a dialog on load is never
      // missed. Best-effort: a failed attach (e.g. DevTools already open on
      // this tab) must not block the navigate the agent actually asked for.
      await bestEffortAttach(tab.id!);
      await chrome.tabs.update(tab.id!, { url });
    }
  }
  await waitForLoad(tab.id!, 'navigate');
  // Navigation invalidates any refs we held for this tab, and any pending
  // dialog arm — a one-shot is scoped to the page it was set on, not a
  // standing grant that should still apply once the tab has moved on.
  // (dialog-capture.ts's own Page.frameNavigated listener already clears it
  // the moment the new document commits; this is belt-and-suspenders.)
  clearRefsForTab(tab.id!);
  clearArmedDialog(tab.id!);
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
    // saving the follow-up wait_for round-trip. attach() already ran above
    // (best-effort) — no need to call it again: if it succeeded this is a
    // no-op either way, and if it failed, runEmbeddedWait's own CDP calls
    // will surface that on their own (same as if attach() had never run).
    wait = await runEmbeddedWait(tab.id!, waitSpec);
  }
  // Report where the tab ACTUALLY is, not the URL we were handed. An SSO bounce,
  // a consent wall, a shortener or an expired session all land somewhere else,
  // and echoing the request made that invisible until some later call surprised
  // the agent — and wrote the wrong URL into the audit row. Read after the
  // embedded wait so the answer describes the tab as the call returns it.
  const landed = await currentUrl(tab.id!);
  const finalUrl = landed ?? url;
  return {
    tabId: tab.id,
    url: finalUrl,
    data: {
      tabId: tab.id,
      url: finalUrl,
      ...(landedElsewhere(url, landed) ? { redirectedFrom: url } : {}),
      ...(epoch ? { epoch } : {}),
      ...(wait ? { wait } : {}),
    },
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
  //
  // ONE exception, and it is strictly stronger rather than weaker: a tab this
  // agent CREATED, in broker mode. The daemon already proved the caller owns
  // the tabId before the call reached us (invariant #13), and ownership is a
  // stronger answer to "may I destroy this tab" than the allowlist is. Without
  // the exception an agent tab that followed a redirect off the allowlist (an
  // SSO bounce, a shortener, an error page) could never be closed by its own
  // owner, so agent tabs would accumulate until the human swept them up.
  // Fail-closed: no recorded epoch (standalone, or a tab we did not create)
  // keeps the allowlist check verbatim.
  const tab = await getTabOrGone(tabId);
  const ownAgentTab = isBrokerMode() && getEpoch(tabId) !== undefined;
  if (!ownAgentTab) await ensureAllowed(tab.url);
  await chrome.tabs.remove(tabId);
  return { tabId, url: tab.url, data: { closed: tabId } };
};

export const reload: Tool = async (args) => {
  const waitSpec = parseWaitFor(args.waitFor, 'reload');
  const tab = await resolveTab(args);
  // Allowlist gate: reloading the page exposes whatever it loads to our
  // subsequent tools, so apply the same domain check as snapshot/read_text.
  await ensureAllowed(tab.url);
  const bypassCache = args.bypassCache === true;
  const before = tab.url ?? '';
  // Attach BEFORE reloading (not lazily on some later call) so any opted-in
  // capture — dialog handling above all, since an unhandled dialog freezes
  // the reloaded page — is live before the reloaded page's scripts run.
  // Best-effort: a failed attach (e.g. DevTools already open on this tab)
  // must not block the reload the agent actually asked for.
  await bestEffortAttach(tab.id!);
  await chrome.tabs.reload(tab.id!, { bypassCache });
  await waitForLoad(tab.id!, 'reload');
  // A reload invalidates any refs we may have built for this tab, and any
  // pending dialog arm (see the identical note in navigate).
  clearRefsForTab(tab.id!);
  clearArmedDialog(tab.id!);
  // Same reason navigate carries one: "reloaded" rarely means "rendered" on an
  // SPA, and reload's own contract says the previous snapshot's refs are dead —
  // so a reload was ALWAYS followed by a wait and/or a re-snapshot. Folding the
  // wait in removes that second call. Errors inside it stay non-fatal
  // (runEmbeddedWait), so a bad selector can't retroactively fail the reload.
  const wait = waitSpec ? await runEmbeddedWait(tab.id!, waitSpec) : null;
  const landed = await currentUrl(tab.id!);
  const finalUrl = landed ?? before;
  return {
    tabId: tab.id,
    url: finalUrl,
    data: {
      tabId: tab.id,
      url: finalUrl,
      bypassCache,
      // A reload that lands elsewhere is the expired-session tell (the page
      // bounces to /login). Previously invisible: the pre-reload URL was
      // reported back as though nothing had moved.
      ...(landedElsewhere(before, landed) ? { redirectedFrom: before } : {}),
      ...(wait ? { wait } : {}),
    },
  };
};
