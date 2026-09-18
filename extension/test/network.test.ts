import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetworkEntry } from '../src/tools/network-capture.js';

const state = vi.hoisted(() => ({ enabled: true, entries: [] as NetworkEntry[] }));
vi.mock('../src/tools/cdp.js', () => ({ attach: vi.fn() }));
vi.mock('../src/tools/gates.js', () => ({ ensureAllowed: vi.fn() }));
vi.mock('../src/tools/tabs.js', () => ({
  resolveTab: vi.fn(async () => ({ id: 1, url: 'https://example.com' })),
}));
vi.mock('../src/storage.js', () => ({
  getSettings: async () => ({ captureNetwork: state.enabled }),
  getAllowlist: async () => [{ pattern: 'example.com', allowEvaluate: false, addedAt: 0 }],
}));
vi.mock('../src/tools/network-capture.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/tools/network-capture.js')>()),
  readNetwork: () => state.entries,
}));

import { networkTail } from '../src/tools/network.js';

describe('network_tail capture status', () => {
  beforeEach(() => {
    state.enabled = true;
    state.entries = [
      {
        ts: 1,
        method: 'GET',
        url: 'https://example.com/data',
        origin: 'https://example.com',
        status: 200,
        type: 'fetch',
        contentType: 'application/json',
        size: 2,
      },
    ];
  });

  it.each(['capture_busy', 'cache_limit'])(
    'reports %s as truncated while preserving metadata and the reason',
    async (reason) => {
      Object.assign(state.entries[0], { bodyOmitted: true, bodyOmissionReason: reason });
      const result = await networkTail({});
      expect(result.data).toEqual({ enabled: true, entries: state.entries, truncated: true });
    },
  );

  it('distinguishes a pending body from a body permanently omitted due to pressure', async () => {
    state.entries[0].bodyPending = true;
    expect((await networkTail({})).data).toEqual({ enabled: true, entries: state.entries });
  });

  it('does not expose pressure on an origin excluded by the allowlist', async () => {
    Object.assign(state.entries[0], {
      origin: 'https://private.invalid',
      bodyOmitted: true,
      bodyOmissionReason: 'capture_busy',
    });
    expect((await networkTail({})).data).toEqual({ enabled: true, entries: [] });
  });

  it('returns no captured data after opt-out', async () => {
    state.enabled = false;
    expect((await networkTail({})).data).toEqual({ enabled: false, entries: [] });
  });
});
