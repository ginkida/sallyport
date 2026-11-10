import { beforeEach, describe, expect, it } from 'vitest';
import {
  ALARM_DISCONNECT_RELEASE,
  DISCONNECT_RELEASE_MS,
  createDisconnectRelease,
  type DisconnectRelease,
} from '../src/disconnect-release.js';

type World = {
  now: number;
  connected: boolean;
  attached: number[];
  detached: number[];
  alarms: Array<{ name: string; delayInMinutes: number }>;
  cleared: number;
  store: Map<string, unknown>;
  storageFails: boolean;
  /** Runs inside each detach — lets a test reconnect mid-release. */
  onDetach?: (tabId: number) => void;
  release: DisconnectRelease;
};

function makeWorld(): World {
  const w = {
    now: 1_000_000,
    connected: true,
    attached: [] as number[],
    detached: [] as number[],
    alarms: [] as Array<{ name: string; delayInMinutes: number }>,
    cleared: 0,
    store: new Map<string, unknown>(),
    storageFails: false,
  } as World;
  w.release = createDisconnectRelease({
    now: () => w.now,
    storage: {
      async get(key) {
        if (w.storageFails) throw new Error('no storage');
        return w.store.has(key) ? { [key]: w.store.get(key) } : {};
      },
      async set(items) {
        if (w.storageFails) throw new Error('no storage');
        for (const [k, v] of Object.entries(items)) w.store.set(k, v);
      },
      async remove(key) {
        w.store.delete(key);
      },
    },
    alarms: {
      create: (name, info) => w.alarms.push({ name, ...info }),
      clear: () => {
        w.cleared++;
      },
    },
    isConnected: () => w.connected,
    attachedTabs: async () => [...w.attached],
    detachTab: async (tabId) => {
      w.detached.push(tabId);
      w.onDetach?.(tabId);
    },
  });
  return w;
}

describe('disconnect release — a daemon that is gone drives nothing', () => {
  let w: World;
  beforeEach(() => {
    w = makeWorld();
    w.attached = [11, 12];
  });

  it('arms one alarm when the connection drops, and detaches nothing yet', async () => {
    w.connected = false;
    await w.release.onStatus();
    await w.release.onStatus(); // the reconnect loop pushes status over and over
    await w.release.onStatus();

    expect(w.alarms).toEqual([{ name: ALARM_DISCONNECT_RELEASE, delayInMinutes: 1 }]);
    expect(w.detached).toEqual([]);
  });

  it('detaches every attached tab once the outage has lasted the full window', async () => {
    w.connected = false;
    await w.release.onStatus();
    w.now += DISCONNECT_RELEASE_MS;

    expect(await w.release.onAlarm()).toBe(2);
    expect(w.detached).toEqual([11, 12]);
  });

  it('releases once per outage, not on every later wake-up', async () => {
    w.connected = false;
    await w.release.onStatus();
    w.now += DISCONNECT_RELEASE_MS;
    await w.release.onAlarm();
    w.detached.length = 0;

    w.now += DISCONNECT_RELEASE_MS;
    await w.release.onStatus();
    expect(await w.release.onAlarm()).toBe(0);
    expect(w.detached).toEqual([]);
    expect(w.alarms.length).toBe(1);
  });

  it('does nothing when the connection came back in time, and forgets the outage', async () => {
    w.connected = false;
    await w.release.onStatus();
    w.connected = true;
    await w.release.onStatus();
    w.now += DISCONNECT_RELEASE_MS * 2;

    expect(await w.release.onAlarm()).toBe(0);
    expect(w.detached).toEqual([]);
    expect(w.cleared).toBe(1);

    // A NEW outage gets the full window again, measured from its own start.
    w.connected = false;
    await w.release.onStatus();
    w.now += DISCONNECT_RELEASE_MS - 1;
    expect(await w.release.onAlarm()).toBe(0);
    expect(w.detached).toEqual([]);
    w.now += 1;
    expect(await w.release.onAlarm()).toBe(2);
  });

  it('an alarm that fires early re-arms for the remainder instead of releasing', async () => {
    w.connected = false;
    await w.release.onStatus();
    w.now += DISCONNECT_RELEASE_MS / 2;

    expect(await w.release.onAlarm()).toBe(0);
    expect(w.detached).toEqual([]);
    expect(w.alarms.at(-1)).toEqual({ name: ALARM_DISCONNECT_RELEASE, delayInMinutes: 0.5 });
  });

  it('does not start detaching when the bridge came back while it listed the tabs', async () => {
    w.connected = false;
    await w.release.onStatus();
    w.now += DISCONNECT_RELEASE_MS;
    const world = w;
    const list = world.attached;
    Object.defineProperty(world, 'attached', {
      get() {
        world.connected = true; // reconnects during the lookup
        return list;
      },
    });

    expect(await w.release.onAlarm()).toBe(0);
    expect(w.detached).toEqual([]);
  });

  it('one tab that never finishes detaching does not hold up the others', async () => {
    w.connected = false;
    await w.release.onStatus();
    w.now += DISCONNECT_RELEASE_MS;
    const hung = createDisconnectRelease({
      now: () => w.now,
      storage: {
        get: async (key) => (w.store.has(key) ? { [key]: w.store.get(key) } : {}),
        set: async (items) => {
          for (const [k, v] of Object.entries(items)) w.store.set(k, v);
        },
        remove: async (key) => void w.store.delete(key),
      },
      alarms: { create: () => undefined, clear: () => undefined },
      isConnected: () => false,
      attachedTabs: async () => [11, 12, 13],
      detachTab: (tabId) => {
        if (tabId === 11) return new Promise<void>(() => undefined); // wedged
        w.detached.push(tabId);
        return Promise.resolve();
      },
    });

    void hung.onAlarm();
    await new Promise((r) => setTimeout(r, 0));

    expect(w.detached).toEqual([12, 13]);
  });

  it('survives a worker restart: the outage start is read back from storage', async () => {
    w.connected = false;
    await w.release.onStatus();
    const store = w.store;
    const fresh = makeWorld(); // new worker, same session storage
    fresh.store = store;
    for (const [k, v] of store) fresh.store.set(k, v);
    fresh.connected = false;
    fresh.attached = [11];
    fresh.now = w.now + DISCONNECT_RELEASE_MS;
    await fresh.release.onStatus(); // boot pushes a status; must not restart the clock

    expect(await fresh.release.onAlarm()).toBe(1);
    expect(fresh.alarms).toEqual([]);
  });

  it('never throws when storage is unavailable', async () => {
    w.connected = false;
    w.storageFails = true;
    await expect(w.release.onStatus()).resolves.toBeUndefined();
    await expect(w.release.onAlarm()).resolves.toBe(0);
    expect(w.detached).toEqual([]);
  });
});
