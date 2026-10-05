import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HUMAN_FOCUS_GRACE_MS,
  MINT_WAIT_STEP_MS,
  installHumanInterestListeners,
  onWindowFocusChanged,
} from '../src/human-interest.js';
import {
  createAgentTab,
  onAgentWindowCreated,
  resetAgentWindow,
} from '../src/tools/agent-window.js';
import { agentTabRecord, clearAllEpochs, mintEpoch } from '../src/tools/ownership.js';

const WIN = 50;
const TAB = 51;
const HUMAN_WIN = 1;

/** A browser with one human window. `windows.create` makes WIN holding TAB and
 * — like macOS ignoring `focused:false` — reports focus on it straight away,
 * BEFORE the create answers (the event the old listener read first). */
function stubBrowser(opts: { focusedAtCreate?: boolean } = {}) {
  let focused = HUMAN_WIN;
  const focusListeners: Array<(id: number) => void> = [];
  const queries: unknown[] = [];
  const setFocus = (id: number) => {
    focused = id;
    for (const fn of focusListeners) fn(id);
  };
  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: async () => ({}),
        set: async () => {},
      },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: { addListener: (fn: (id: number) => void) => focusListeners.push(fn) },
      async getLastFocused() {
        return { id: focused };
      },
      async create() {
        if (opts.focusedAtCreate !== false) setFocus(WIN);
        return { id: WIN, tabs: [{ id: TAB, windowId: WIN, active: true }] };
      },
      async get(id: number) {
        // The activation landed after this read: no focus restore runs.
        return { id, focused: id === focused };
      },
      async update() {},
    },
    tabs: {
      onActivated: { addListener() {} },
      onAttached: { addListener() {} },
      async update() {},
      async query(q: { windowId: number }) {
        queries.push(q);
        return q.windowId === WIN ? [{ id: TAB, windowId: WIN, active: true }] : [];
      },
    },
  });
  return { setFocus, queries };
}

beforeEach(() => {
  vi.useFakeTimers();
  clearAllEpochs();
  resetAgentWindow();
});
afterEach(() => {
  onAgentWindowCreated(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a new agent window that keeps focus past the grace', () => {
  it("marks its first tab human even when the browser had no agent tab yet (the session's first window)", async () => {
    stubBrowser();
    installHumanInterestListeners();
    const tab = await createAgentTab('https://allowed.example/');
    // navigate mints only after its create (and attach) return
    mintEpoch(tab.id!, 'agent');
    expect(agentTabRecord(TAB)?.human).toBe(false); // inside the grace: discounted
    await vi.advanceTimersByTimeAsync(HUMAN_FOCUS_GRACE_MS + 100);
    expect(agentTabRecord(TAB)?.human).toBe(true);
  });

  it('…and when the epoch arrives only after the grace (a slow attach)', async () => {
    stubBrowser();
    installHumanInterestListeners();
    await createAgentTab('https://allowed.example/');
    await vi.advanceTimersByTimeAsync(HUMAN_FOCUS_GRACE_MS + 100);
    mintEpoch(TAB, 'agent');
    await vi.advanceTimersByTimeAsync(MINT_WAIT_STEP_MS + 10);
    expect(agentTabRecord(TAB)?.human).toBe(true);
  });

  it('a focus event handled before the window is known as ours does not use up the re-check', async () => {
    // Focus lands, and is handled, before the create answers: not inside any
    // grace yet, and the tab has no epoch — nothing to mark. The creation's
    // own re-check still comes.
    const browser = stubBrowser({ focusedAtCreate: false });
    installHumanInterestListeners();
    const created = createAgentTab('https://allowed.example/');
    browser.setFocus(WIN);
    await created;
    mintEpoch(TAB, 'agent');
    await vi.advanceTimersByTimeAsync(HUMAN_FOCUS_GRACE_MS + 100);
    expect(agentTabRecord(TAB)?.human).toBe(true);
  });

  it('a window that gave focus back within the grace is not the human’s', async () => {
    const browser = stubBrowser();
    installHumanInterestListeners();
    await createAgentTab('https://allowed.example/');
    mintEpoch(TAB, 'agent');
    browser.setFocus(HUMAN_WIN);
    await vi.advanceTimersByTimeAsync(HUMAN_FOCUS_GRACE_MS + 10 * MINT_WAIT_STEP_MS);
    expect(agentTabRecord(TAB)?.human).toBe(false);
  });

  it('a later, deliberate focus on an agent window marks its active tab at once', async () => {
    const browser = stubBrowser({ focusedAtCreate: false });
    installHumanInterestListeners();
    await createAgentTab('https://allowed.example/');
    mintEpoch(TAB, 'agent');
    await vi.advanceTimersByTimeAsync(HUMAN_FOCUS_GRACE_MS + 100);
    expect(agentTabRecord(TAB)?.human).toBe(false);
    browser.setFocus(WIN);
    await vi.advanceTimersByTimeAsync(0);
    expect(agentTabRecord(TAB)?.human).toBe(true);
  });

  it('standalone: a focus change costs no tabs.query when nothing is ours', async () => {
    const browser = stubBrowser();
    onWindowFocusChanged(HUMAN_WIN);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.queries).toEqual([]);
  });
});
