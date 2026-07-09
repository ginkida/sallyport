/** `handle_dialog` — see and steer native JS dialogs on a tab
 * (dialog-capture.ts): read what dialogs opened and how they were answered,
 * and ARM the answer for the next one (accept a confirm(), put text into a
 * prompt(), let a beforeunload navigation proceed).
 *
 * Allowlist-gated like every page-touching tool, and additionally
 * ORIGIN-FILTERED at read time: only entries whose frame origin is in the
 * allowlist are returned (fail-closed on an unknown origin). An arm is itself
 * bound to the origin it was just allowlist-checked against here — it cannot
 * be hijacked by a dialog from a different origin (invariant #3). Handling is
 * opt-in: when the popup setting is off the tool returns {enabled:false} so
 * "no dialogs recorded" isn't misread as "no dialogs happened" — with the
 * setting off (including turned off mid-session), dialogs behave natively and
 * block automation until a human clicks them.
 */

import { matchAllowlist } from '../allowlist.js';
import { getAllowlist, getSettings } from '../storage.js';
import { attach } from './cdp.js';
import { filterByAllowedOrigins, originFromStackUrl } from './console-capture.js';
import {
  armDialog,
  describeArmed,
  getArmedDialog,
  parseDialogArgs,
  readDialogs,
} from './dialog-capture.js';
import { ensureAllowed } from './gates.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

export const handleDialog: Tool = async (args) => {
  const { action, promptText, limit } = parseDialogArgs(args);
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  // attach() lazily issues Page.enable when the setting is on, so the first
  // call also starts handling going forward (no retroactive handling of a
  // dialog that is already open).
  await attach(tab.id!);

  const settings = await getSettings();
  if (!settings.handleDialogs) {
    return { tabId: tab.id, url: tab.url, data: { enabled: false, armed: null, recent: [] } };
  }

  if (action !== undefined) {
    // Bind the arm to the origin it was just allowlist-checked against
    // (tab.url, above) — decideDialogResponse refuses to apply it to a
    // dialog from any other origin (invariant #3).
    armDialog(
      tab.id!,
      { accept: action === 'accept', ...(promptText !== undefined ? { promptText } : {}) },
      originFromStackUrl(tab.url),
    );
  }

  const list = await getAllowlist();
  const isAllowed = (origin: string): boolean => matchAllowlist(origin, list).matched;
  const allowed = filterByAllowedOrigins(readDialogs(tab.id!), isAllowed);
  const recent = allowed.slice(-limit);
  return {
    tabId: tab.id,
    url: tab.url,
    data: {
      enabled: true,
      armed: describeArmed(getArmedDialog(tab.id!)),
      recent,
      ...(allowed.length > recent.length ? { truncated: true } : {}),
    },
  };
};
