/** Stop driving every tab once the daemon has been gone for a while.
 *
 * A debugger session is only useful while something can send it commands, and
 * commands come from the daemon. When the WebSocket drops and stays down — the
 * daemon crashed or was stopped, the bridge is paused, the secret was cleared —
 * nothing could detach the tabs it had been driving: `_release_tabs` is sent BY
 * the daemon. They kept Chrome's "started debugging this browser" bar, their
 * CDP domains, and the DevTools-open status that keeps a tab out of Memory
 * Saver, for as long as the browser ran.
 *
 * So after `DISCONNECT_RELEASE_MS` without a connection every tab we hold is
 * detached. Detached, not closed: the same daemon may come back with its
 * sessions intact (a network blip, a laptop waking up), and its agents then
 * simply re-attach on their next call — the cost of having waited is the one a
 * detach always has (`@eN` refs reset, a `set_viewport` emulation cleared).
 * Tabs whose daemon is really gone are closed later, when a DIFFERENT daemon
 * answers (`release.ts:releaseStrandedTabs`).
 *
 * The trigger is a `chrome.alarms` alarm, not a timer: with no socket open the
 * MV3 worker is evicted within seconds, and an alarm is what survives that. The
 * outage start lives in `chrome.storage.session` for the same reason.
 *
 * Dependency-injected so the policy is unit-tested without `chrome.*`. */

export const ALARM_DISCONNECT_RELEASE = 'sallyport_disconnect_release';
export const DISCONNECT_RELEASE_MS = 60_000;

const SINCE_KEY = 'sallyport_disconnected_since';

export type DisconnectReleaseDeps = {
  now(): number;
  /** `chrome.storage.session`-shaped: outlives a worker eviction. */
  storage: {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(key: string): Promise<void>;
  };
  alarms: {
    create(name: string, info: { delayInMinutes: number }): void;
    clear(name: string): void;
  };
  /** Is the bridge connected RIGHT NOW (re-read at every step). */
  isConnected(): boolean;
  /** Tab ids Chrome reports a debugger attached to — ours or not. */
  attachedTabs(): Promise<number[]>;
  /** Detach OUR session from the tab, serialised with tool calls on it; a tab
   * we do not hold is a no-op. Must not throw. */
  detachTab(tabId: number): Promise<void>;
};

export type DisconnectRelease = {
  /** Call on every connection status change. */
  onStatus(): Promise<void>;
  /** Call when `ALARM_DISCONNECT_RELEASE` fires. */
  onAlarm(): Promise<number>;
};

export function createDisconnectRelease(deps: DisconnectReleaseDeps): DisconnectRelease {
  // One step at a time: status changes arrive in bursts during a reconnect
  // loop, and two interleaved read-modify-writes of the outage start would let
  // a stale "disconnected" overwrite a newer "connected".
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = chain.then(run, run);
    chain = next.catch(() => undefined);
    return next;
  };

  /** When the current outage began, or undefined once it was handled. */
  async function readSince(): Promise<unknown> {
    return (await deps.storage.get(SINCE_KEY))[SINCE_KEY];
  }

  async function releaseIfDue(): Promise<number> {
    if (deps.isConnected()) return 0;
    const since = await readSince();
    if (typeof since !== 'number') return 0; // no outage on record, or already released
    const waited = deps.now() - since;
    if (waited < DISCONNECT_RELEASE_MS) {
      // Woken early (or the clock moved): come back when it is due.
      deps.alarms.create(ALARM_DISCONNECT_RELEASE, {
        delayInMinutes: Math.max(0.5, (DISCONNECT_RELEASE_MS - waited) / 60_000),
      });
      return 0;
    }
    // Mark the outage handled BEFORE detaching, so a status change landing
    // mid-release does not start a second pass.
    await deps.storage.set({ [SINCE_KEY]: 'released' });
    let released = 0;
    for (const tabId of await deps.attachedTabs()) {
      // Reconnected while we were at it: whatever is still attached is about
      // to be driven again.
      if (deps.isConnected()) break;
      await deps.detachTab(tabId);
      released++;
    }
    return released;
  }

  return {
    onStatus: () =>
      serial(async () => {
        try {
          if (deps.isConnected()) {
            deps.alarms.clear(ALARM_DISCONNECT_RELEASE);
            await deps.storage.remove(SINCE_KEY);
            return;
          }
          if ((await readSince()) !== undefined) return; // outage already on record
          await deps.storage.set({ [SINCE_KEY]: deps.now() });
          deps.alarms.create(ALARM_DISCONNECT_RELEASE, {
            delayInMinutes: DISCONNECT_RELEASE_MS / 60_000,
          });
        } catch {
          // storage/alarms unavailable — housekeeping never breaks the bridge
        }
      }),
    onAlarm: () =>
      serial(async () => {
        try {
          return await releaseIfDue();
        } catch {
          return 0;
        }
      }),
  };
}
