/** `console_tail` — read the page console errors/warnings + uncaught
 * exceptions captured for a tab (console-capture.ts).
 *
 * Allowlist-gated like every page-touching tool, and additionally
 * ORIGIN-FILTERED at read time: only entries whose producing-script origin is
 * in the allowlist are returned (fail-closed on an unknown origin) — so a tab
 * that navigated cross-origin while buffering can't leak a non-allowlisted
 * origin's console through this tool (#3). Capture is opt-in: when the popup
 * setting is off the tool returns {enabled:false, entries:[]} so an empty
 * result isn't misread as "no errors".
 */

import { matchAllowlist } from '../allowlist.js';
import { getAllowlist, getSettings } from '../storage.js';
import { attach } from './cdp.js';
import { filterByAllowedOrigins, parseConsoleLimit, readConsole } from './console-capture.js';
import { ensureAllowed } from './gates.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

export const consoleTail: Tool = async (args) => {
  const limit = parseConsoleLimit(args.limit);
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  // attach() lazily enables capture when the setting is on, so the first call
  // also starts capture going forward (no history replay).
  await attach(tab.id!);

  const settings = await getSettings();
  if (!settings.captureConsole) {
    return { tabId: tab.id, url: tab.url, data: { enabled: false, entries: [] } };
  }

  const list = await getAllowlist();
  const isAllowed = (origin: string): boolean => matchAllowlist(origin, list).matched;
  const allowed = filterByAllowedOrigins(readConsole(tab.id!), isAllowed);
  const entries = allowed.slice(-limit);
  return {
    tabId: tab.id,
    url: tab.url,
    data: {
      enabled: true,
      entries,
      ...(allowed.length > entries.length ? { truncated: true } : {}),
    },
  };
};
