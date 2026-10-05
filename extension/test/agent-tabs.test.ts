import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeAgentTabs, listAgentTabs } from '../src/agent-tabs.js';
import {
  clearAllEpochs,
  dropEpoch,
  markHumanTab,
  markOrphanedTab,
  mintEpoch,
} from '../src/tools/ownership.js';

const remove = vi.fn();
const query = vi.fn();
beforeEach(() => {
  clearAllEpochs();
  remove.mockReset().mockResolvedValue(undefined);
  query.mockReset().mockResolvedValue([]);
  vi.stubGlobal('chrome', { tabs: { remove, query } });
});
afterEach(() => vi.unstubAllGlobals());

describe('agent tab management', () => {
  it('lists only owned tabs and keeps the creating session when windows change', async () => {
    mintEpoch(1, 'research');
    markOrphanedTab(1);
    markHumanTab(1);
    query.mockResolvedValue([
      { id: 1, windowId: 99, title: 'Report', url: 'https://example.com' },
      { id: 2, title: 'Personal tab' },
    ]);
    expect(await listAgentTabs()).toEqual([
      {
        tabId: 1,
        title: 'Report',
        url: 'https://example.com',
        session: 'research',
        orphaned: true,
        human: true,
      },
    ]);
  });

  it('does not report stale ownership removed while Chrome was queried', async () => {
    mintEpoch(1);
    query.mockImplementation(async () => {
      dropEpoch(1);
      return [{ id: 1 }];
    });
    expect(await listAgentTabs()).toEqual([]);
  });

  it('finished cleanup preserves active sessions and human-viewed tabs', async () => {
    for (const id of [1, 2, 3]) mintEpoch(id);
    markOrphanedTab(1);
    markOrphanedTab(2);
    markHumanTab(2);
    expect(await closeAgentTabs('finished')).toEqual({ closed: 1, failed: 0, skipped: 0 });
    expect(remove.mock.calls).toEqual([[1]]);
  });

  it('counts successful removals and reports partial failures while continuing the batch', async () => {
    for (const id of [1, 2, 3]) mintEpoch(id);
    remove.mockRejectedValueOnce(new Error('Chrome refused'));
    expect(await closeAgentTabs('all')).toEqual({ closed: 2, failed: 1, skipped: 0 });
    expect(remove.mock.calls).toEqual([[1], [2], [3]]);
  });

  it('skips a recycled ID and newly human-viewed tab during a batch', async () => {
    for (const id of [1, 2, 3]) {
      mintEpoch(id);
      markOrphanedTab(id);
    }
    remove.mockImplementationOnce(async () => {
      mintEpoch(2, 'new owner');
      markHumanTab(3);
    });
    expect(await closeAgentTabs('finished')).toEqual({ closed: 1, failed: 0, skipped: 2 });
    expect(remove.mock.calls).toEqual([[1]]);
  });

  it('all remains an explicit action covering active and viewed agent tabs', async () => {
    mintEpoch(1);
    markHumanTab(1);
    mintEpoch(2);
    expect(await closeAgentTabs('all')).toEqual({ closed: 2, failed: 0, skipped: 0 });
  });
});

describe('sweep closes agent-only tabs without the beforeunload prompt', () => {
  // A sweep of N tabs with a dirty form each used to raise N "Close site?"
  // prompts, each one activating its tab and focusing its window.
  function quietDebugger(closed: number[]) {
    const listeners = new Set<(id: number) => void>();
    vi.stubGlobal('chrome', {
      tabs: {
        remove,
        query,
        async get(id: number) {
          if (closed.includes(id)) throw new Error(`No tab with id: ${id}.`);
          return { id };
        },
        onRemoved: {
          addListener: (fn: (id: number) => void) => listeners.add(fn),
          removeListener: (fn: (id: number) => void) => listeners.delete(fn),
        },
      },
      debugger: {
        getTargets: async () => [1, 2].map((tabId) => ({ id: `T${tabId}`, tabId, type: 'page' })),
        attach: async () => undefined,
        detach: async () => undefined,
        sendCommand: async (target: { tabId: number }, method: string) => {
          if (method !== 'Target.closeTarget') return {};
          closed.push(target.tabId);
          for (const fn of [...listeners]) fn(target.tabId);
          return { success: true };
        },
      },
    });
  }

  it('uses Target.closeTarget for an agent-only tab and tabs.remove for a human-engaged one', async () => {
    const closed: number[] = [];
    quietDebugger(closed);
    mintEpoch(1);
    mintEpoch(2);
    markHumanTab(2);
    expect(await closeAgentTabs('all')).toEqual({ closed: 2, failed: 0, skipped: 0 });
    expect(closed).toEqual([1]);
    expect(remove.mock.calls).toEqual([[2]]);
  });
});
