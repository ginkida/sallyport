import { describe, expect, it } from 'vitest';
import { NetworkBodyCache } from '../src/tools/network-body-cache.js';
import { shapeNetworkEntry } from '../src/tools/network-capture.js';

const entry = () =>
  shapeNetworkEntry(
    {
      ts: 1,
      method: 'GET',
      url: 'https://example.com/api',
      status: 200,
      type: 'fetch',
      contentType: 'application/json',
      size: 10,
    },
    null,
  );

describe('network body retention budget', () => {
  it('replaces older bodies within the same tab while keeping their metadata', () => {
    const cache = new NetworkBodyCache(12, 24);
    const older = entry(),
      newer = entry();
    cache.retain(1, older, '123456', []);
    cache.retain(1, newer, 'abcdef', [older]);
    expect(cache.bytes).toBe(12);
    expect(older.body).toBeUndefined();
    expect(older.bodyOmissionReason).toBe('cache_limit');
    expect(older.status).toBe(200);
    expect(newer.body).toBe('abcdef');
  });

  it('cannot evict another tab when the global budget is full', () => {
    const cache = new NetworkBodyCache(12, 12);
    const other = entry(),
      current = entry();
    cache.retain(1, other, '123456', []);
    cache.retain(2, current, 'a', [other]);
    expect(other.body).toBe('123456');
    expect(current.bodyOmissionReason).toBe('cache_limit');
    expect(cache.bytes).toBe(12);
    cache.release(other);
    cache.retain(2, current, 'a', []);
    expect(current.body).toBe('a');
    expect(current.bodyOmitted).toBeUndefined();
    expect(cache.bytes).toBe(2);
  });

  it('a late old response cannot evict newer responses', () => {
    const cache = new NetworkBodyCache(12, 12);
    const older = entry(),
      newer = entry();
    cache.retain(1, newer, '123456', []);
    cache.retain(1, older, 'a', []);
    expect(newer.body).toBe('123456');
    expect(older.bodyOmitted).toBe(true);
  });

  it('counts UTF-16 payload bytes, including astral characters', () => {
    const cache = new NetworkBodyCache(4, 4);
    const item = entry();
    cache.retain(1, item, '😀', []);
    expect(cache.bytes).toBe(4);
    cache.release(item);
    cache.release(item);
    expect(cache.bytes).toBe(0);
  });

  it('does not discard existing data for a body too large to ever fit', () => {
    const cache = new NetworkBodyCache(4, 4);
    const older = entry(),
      oversized = entry();
    cache.retain(1, older, 'ok', []);
    cache.retain(1, oversized, 'large', [older]);
    expect(older.body).toBe('ok');
    expect(oversized.bodyOmitted).toBe(true);
    expect(cache.bytes).toBe(4);
  });

  it('stays within both limits during sustained multi-tab churn and frees all accounting', () => {
    const cache = new NetworkBodyCache(32, 128);
    const rings = Array.from({ length: 20 }, () => [] as ReturnType<typeof entry>[]);
    for (let i = 0; i < 2000; i++) {
      const tab = i % rings.length;
      const ring = rings[tab];
      if (ring.length === 5) cache.release(ring.shift()!);
      const next = entry();
      cache.retain(tab, next, '😀'.repeat(1 + (i % 8)), ring);
      ring.push(next);
      const tabBytes = ring.reduce((sum, e) => sum + (e.body?.length ?? 0) * 2, 0);
      expect(tabBytes).toBeLessThanOrEqual(32);
      const allBytes = rings.flat().reduce((sum, e) => sum + (e.body?.length ?? 0) * 2, 0);
      expect(cache.bytes).toBe(allBytes);
      expect(cache.bytes).toBeLessThanOrEqual(128);
    }
    for (const e of rings.flat()) cache.release(e);
    expect(cache.bytes).toBe(0);
  });
});
