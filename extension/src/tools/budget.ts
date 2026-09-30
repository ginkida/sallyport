/** A call's time budget inside the extension. Leaf module: no imports.
 *
 * The daemon abandons a call at 60 s (bridge.py `request_timeout`) and answers
 * `extension_timeout` — "may still be running" — for work that may well have
 * finished; in broker mode a tab the call created is then never recorded as
 * owned, so its own agent cannot name it. Nothing in a call may therefore
 * spend a fresh allowance after a slow step: waits, the page-load watchdog and
 * an `observe` all spend what the call has LEFT, counted from when `runTool`
 * received it (`ToolContext.startedAt`), queueing on the tab included. */

/** Every wait in a call ends by here. The rest is for `observe` and the trip
 * home. */
export const CALL_BUDGET_MS = 50_000;

/** A wait that an `observe` follows ends this much earlier, so the snapshot
 * starts with at least 15 s before the daemon gives up. */
export const OBSERVE_RESERVE_MS = 5_000;

/** Floor for a page-load watchdog on an overdrawn call: fail fast with the
 * safe-to-retry `timeout`, not the ambiguous `extension_timeout`. */
export const MIN_LOAD_TIMEOUT_MS = 1_000;

/** Milliseconds left before `CALL_BUDGET_MS - reserveMs`, never negative;
 * `Infinity` for a call with no recorded start (a direct test call). Pure. */
export function budgetLeft(startedAt: number | undefined, now: number, reserveMs = 0): number {
  if (startedAt === undefined) return Infinity;
  return Math.max(0, CALL_BUDGET_MS - reserveMs - (now - startedAt));
}

/** The page-load watchdog for a call: its usual 30 s, or what is left if less,
 * but never under MIN_LOAD_TIMEOUT_MS. Pure. */
export function loadTimeoutMs(startedAt: number | undefined, now: number, usual = 30_000): number {
  return Math.max(MIN_LOAD_TIMEOUT_MS, Math.min(usual, budgetLeft(startedAt, now)));
}
