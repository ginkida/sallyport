/** `network_tail` — read the XHR/fetch responses captured for a tab
 * (network-capture.ts): the DATA behind canvas dashboards and network-driven
 * SPAs. A canvas chart has no readable DOM, but the numbers it draws arrived as
 * JSON on the wire — this surfaces those response bodies so an agent pulls exact
 * figures instead of screenshotting + guessing.
 *
 * Allowlist-gated like every page-touching tool, and additionally
 * ORIGIN-FILTERED at read time: only entries whose response origin is in the
 * allowlist are returned (fail-closed on an unknown origin) — so a dashboard
 * whose data API is on another host requires THAT host allowlisted too. Capture
 * is opt-in: when the popup setting is off the tool returns
 * {enabled:false, entries:[]} so an empty result isn't misread as "no traffic".
 */

import { matchAllowlist } from '../allowlist.js';
import { getAllowlist, getSettings } from '../storage.js';
import { attach } from './cdp.js';
import { ensureAllowed } from './gates.js';
import { filterNetworkEntries, parseNetworkArgs, readNetwork } from './network-capture.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

export const networkTail: Tool = async (args) => {
  const { limit, filter } = parseNetworkArgs(args);
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  // attach() lazily enables capture when the setting is on, so the first call
  // also starts capture going forward (no history replay).
  await attach(tab.id!);

  const settings = await getSettings();
  if (!settings.captureNetwork) {
    return { tabId: tab.id, url: tab.url, data: { enabled: false, entries: [] } };
  }

  const list = await getAllowlist();
  const isAllowed = (origin: string): boolean => matchAllowlist(origin, list).matched;
  const { entries, total } = filterNetworkEntries(readNetwork(tab.id!), isAllowed, {
    filter,
    limit,
  });
  return {
    tabId: tab.id,
    url: tab.url,
    data: {
      enabled: true,
      entries,
      ...(total > entries.length ? { truncated: true } : {}),
    },
  };
};
