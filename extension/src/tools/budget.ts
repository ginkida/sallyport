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

/** Below this, a page step is not even sent: a call whose budget queueing and
 * attach already spent would otherwise dispatch a POST (or arbitrary code) and
 * then report the side effect it caused as a timeout. */
export const MIN_STEP_MS = 1_000;

/** How long a single page-awaited step (fetch_in_page, evaluate) may take: what
 * the call has left, never more than the whole budget. Pure. */
export function stepDeadlineMs(startedAt: number | undefined, now: number): number {
  return Math.max(0, Math.min(CALL_BUDGET_MS, budgetLeft(startedAt, now)));
}

/** Settle `p`, or reject with `onTimeout()` after `ms`. The losing promise is
 * NOT cancelled — this is what frees the tab's call queue (tools.ts onTab) from
 * a page promise that never settles, not a way to stop the page. */
export async function raceDeadline<T>(
  p: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Ceiling on one accessibility query of a typing gate (fill's guard,
 * key_type/send_keys's per-frame focus walk). Those queries are answered by the
 * RENDERER, so a page that is busy or hung leaves them pending forever, and the
 * gate then holds the tab's call queue until the daemon gives up — reporting
 * `extension_timeout`, "may still be running", for a call that typed nothing.
 * Past the deadline the gate fails CLOSED (`focus_probe_failed`) before any
 * text is sent. */
export const FOCUS_PROBE_DEADLINE_MS = 5_000;

/** How long the next focus-probe query may take: FOCUS_PROBE_DEADLINE_MS, or
 * what the call has left if less — never more. 0 means the call has nothing
 * left, and the query is not worth sending. Pure. */
export function focusProbeDeadlineMs(startedAt: number | undefined, now: number): number {
  return Math.min(FOCUS_PROBE_DEADLINE_MS, budgetLeft(startedAt, now));
}

/** Run one focus-probe query under `focusProbeDeadlineMs`. `send` is only
 * called when there is time left to wait for it, so an overdrawn call sends
 * nothing. A late answer resolves into nothing: the caller has already thrown
 * `onTimeout()` and left the gate. */
export function boundedProbe<T>(
  send: () => Promise<T>,
  startedAt: number | undefined,
  onTimeout: () => Error,
): Promise<T> {
  const ms = focusProbeDeadlineMs(startedAt, Date.now());
  if (ms <= 0) return Promise.reject(onTimeout());
  return raceDeadline(send(), ms, onTimeout);
}
