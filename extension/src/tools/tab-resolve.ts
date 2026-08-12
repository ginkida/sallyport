/** Which tab a tool operates on, and whether it is still there.
 *
 * A leaf module: `chrome.tabs` + `BridgeError`, nothing else. It sits here
 * rather than in `tabs.ts` because `snapshot.ts` needs `resolveTab`, and
 * `tabs.ts` imports `observe.ts`, which imports `snapshot.ts` — leaving the
 * resolver in `tabs.ts` closes that loop. Same reasoning as `resolve.ts` and
 * `poll.ts`; `tabs.ts` re-exports both names so no other tool has to care.
 */

import { BridgeError } from './errors.js';

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
