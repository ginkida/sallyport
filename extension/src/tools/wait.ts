import { attach } from './cdp.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { parseTimeoutMs, pollFor } from './poll.js';
import { resolveTab } from './tabs.js';
import { budgetLeft } from './budget.js';
import type { Tool } from './types.js';

/** Wait until a selector is visible and/or the page text contains a
 * substring — the built-in replacement for blind sleeps between actions.
 * `absent: true` inverts both conditions (wait until the spinner/modal is
 * GONE). A timeout is NOT an error: returns {found:false, elapsedMs} so the
 * agent can decide what to do next without an isError round.
 *
 * The polling machinery lives in poll.ts, shared with the embedded
 * `waitFor` parameter of navigate/click/mouse_click/fill. */
export const waitFor: Tool = async (args, ctx) => {
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : null;
  const text = typeof args.text === 'string' && args.text !== '' ? args.text : null;
  if (!selector && !text) {
    throw new BridgeError('bad_args', 'wait_for: selector and/or text required');
  }
  const asked = parseTimeoutMs(args.timeoutMs, 'wait_for');
  const absent = args.absent === true;

  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  // What the CALL has left (budget.ts), not a fresh allowance — measured after
  // attach, whose time is the call's too.
  const timeoutMs = Math.min(asked, budgetLeft(ctx?.startedAt, Date.now()));

  // The url the LAST tick read: a wait that outlived a same-site navigation
  // ended somewhere else, and the result and audit row should say where.
  const seen: { url?: string } = {};
  const outcome = await pollFor(tab.id!, { selector, text, timeoutMs, absent }, seen);
  const data = timeoutMs < asked ? { ...outcome, budgetLimited: true as const } : outcome;
  return { tabId: tab.id, url: seen.url ?? tab.url, data };
};
