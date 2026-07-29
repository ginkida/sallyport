/** `_release_tabs` — hand a disconnected session's tabs back to the human.
 *
 * DAEMON-INITIATED, never agent-callable: it is deliberately absent from the
 * public `tools` registry (and therefore from `TOOL_NAMES` and the MCP
 * catalogue). The broker calls it when an MCP client disconnects, passing the
 * tab ids that client owned.
 *
 * The tabs stay OPEN — closing an agent's half-finished work is exactly the
 * loss invariant #12 exists to prevent, and the human may well want what's on
 * them. What we stop is the DRIVING: the debugger session goes away (with it
 * Chrome's "started debugging this browser" bar, the disabled back/forward
 * cache and the sticky focus emulation that makes the page report itself
 * visible), the ownership epoch is dropped so the id can never be confirmed
 * against a recycled tab, and the tab is unmuted since the human owns it now.
 *
 * Every step is best-effort per tab: this runs on a disconnect path, so one
 * vanished tab must not stop the rest from being released.
 */

import { getSettings } from '../storage.js';
import { detach } from './cdp.js';
import { dropEpoch, getEpoch } from './ownership.js';
import { persistEpochs } from './ownership-store.js';
import type { Tool } from './types.js';

/** What to do with a disconnected session's tab.
 *
 * `hand-back` is the default and the conservative one: stop DRIVING the tab but
 * leave it open, because closing an agent's half-finished work is precisely the
 * loss invariant #12 gates `close_tab` against, and for an interactive session
 * those tabs are usually the result you wanted to see.
 *
 * `close` is opt-in, for EPHEMERAL agents. A dispatched one-shot run is a new
 * MCP session every time, so each run's tabs are orphaned on exit and no later
 * session can reach them — tabs are owner-scoped and the epoch is dropped here —
 * which means they accumulate until a human sweeps them from the popup. Pure so
 * the policy is unit-tested rather than inferred from the chrome calls. */
export function releaseAction(closeOnDisconnect: boolean): 'close' | 'hand-back' {
  return closeOnDisconnect ? 'close' : 'hand-back';
}

export const releaseTabs: Tool = async (args) => {
  const raw = args.tabIds;
  const tabIds = Array.isArray(raw) ? raw.filter((id): id is number => typeof id === 'number') : [];
  const { closeAgentTabsOnDisconnect } = await getSettings();
  const action = releaseAction(closeAgentTabsOnDisconnect);
  let released = 0;
  let closed = 0;
  let dropped = false;
  for (const tabId of tabIds) {
    // Defence in depth: only ever touch a tab WE created. The daemon refuses
    // this tool by name for any MCP client (bridge.INTERNAL_TOOLS) precisely
    // because `tabIds` is an array the ownership gate never inspects; if that
    // gate were ever bypassed, an arbitrary id list must still be inert here.
    // Only agent-created tabs have a recorded epoch, so this is exactly the
    // right filter — and it is fail-closed.
    if (getEpoch(tabId) === undefined) continue;
    await detach(tabId);
    if (action === 'close') {
      try {
        await chrome.tabs.remove(tabId);
        closed++;
      } catch {
        // already gone — nothing to close
      }
    } else {
      try {
        // The human owns it now; a tab that keeps agent-imposed mute would be a
        // confusing thing to inherit.
        await chrome.tabs.update(tabId, { muted: false });
      } catch {
        // tab already closed — nothing to hand back
      }
    }
    if (dropEpoch(tabId)) dropped = true;
    released++;
  }
  if (dropped) await persistEpochs();
  return { data: { released, closed } };
};
