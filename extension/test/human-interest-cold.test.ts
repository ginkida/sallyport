import { afterEach, describe, expect, it, vi } from 'vitest';

/** The human clicks into an agent tab while no daemon is connected: the MV3
 * worker is asleep, the click WAKES it, and the event is delivered before the
 * epoch map has been rehydrated. An "is this an agent tab?" asked of the empty
 * map dropped the one event that says a person is looking at the tab — and the
 * next release then closed it under them. */
describe('human interest on a cold worker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function coldWorker(focusedWindow: number) {
    // A previous worker's snapshot, as it sits in chrome.storage.session.
    const before = await import('../src/tools/ownership.js');
    before.mintEpoch(7, 'session-a');
    const snapshot = before.serializeEpochs();
    vi.resetModules();

    const session = new Map<string, unknown>([['sallyport_epochs', snapshot]]);
    vi.stubGlobal('chrome', {
      storage: {
        session: {
          get: async (k: string) => (session.has(k) ? { [k]: session.get(k) } : {}),
          set: async (o: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(o)) session.set(k, v);
          },
        },
      },
      windows: {
        WINDOW_ID_NONE: -1,
        get: async (id: number) => ({ id, focused: id === focusedWindow }),
      },
      tabs: {
        query: async (q: { windowId: number }) =>
          q.windowId === 3 ? [{ id: 7, windowId: 3, active: true }] : [],
      },
    });
    return {
      interest: await import('../src/human-interest.js'),
      store: await import('../src/tools/ownership-store.js'),
      ownership: await import('../src/tools/ownership.js'),
    };
  }

  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('an activation that arrives before hydration still marks the tab', async () => {
    const { interest, store, ownership } = await coldWorker(3);
    expect(store.epochsLoaded()).toBe(false);

    interest.onTabActivated({ tabId: 7, windowId: 3 });
    await settle();
    expect(ownership.agentTabRecord(7)).toBeUndefined(); // nothing loaded yet

    await store.loadEpochs();
    await settle();
    expect(ownership.agentTabRecord(7)?.human).toBe(true);
  });

  it('so does a window focus change, and a drag into another window', async () => {
    const a = await coldWorker(3);
    a.interest.onWindowFocusChanged(3);
    await a.store.loadEpochs();
    await settle();
    expect(a.ownership.agentTabRecord(7)?.human).toBe(true);

    vi.unstubAllGlobals();
    vi.resetModules();
    const b = await coldWorker(1);
    b.interest.onTabAttached(7);
    await b.store.loadEpochs();
    await settle();
    expect(b.ownership.agentTabRecord(7)?.human).toBe(true);
  });

  it('a tab that is not ours stays unmarked, and an unfocused window proves nothing', async () => {
    const { interest, store, ownership } = await coldWorker(1); // human is elsewhere
    interest.onTabActivated({ tabId: 7, windowId: 3 });
    interest.onTabActivated({ tabId: 99, windowId: 3 });
    await store.loadEpochs();
    await settle();
    expect(ownership.agentTabRecord(7)?.human).toBe(false);
    expect(ownership.agentTabRecord(99)).toBeUndefined();
  });
});
