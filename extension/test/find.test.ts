/**
 * `find`'s argument surface.
 *
 * The batch exists because locating several controls is ONE intention — "the
 * composer, the send button, and the row I am replying to" — that used to cost
 * three model turns AND three full accessibility-tree walks for the same
 * answer. The matcher is pure and extension-side, so the extra predicates cost
 * microseconds and not one extra CDP command.
 */

import { beforeAll, describe, expect, it } from 'vitest';

let parseQueries: typeof import('../src/tools/find.js').parseQueries;
let parseFindTimeout: typeof import('../src/tools/find.js').parseFindTimeout;

beforeAll(async () => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: { onRemoved: { addListener() {} } },
    debugger: { onDetach: { addListener() {} } },
  };
  ({ parseQueries, parseFindTimeout } = await import('../src/tools/find.js'));
});

describe('parseQueries', () => {
  it('keeps the single-predicate form, and marks it NOT a batch', () => {
    const out = parseQueries({ role: 'button', name: 'Send' });
    expect(out.batch).toBe(false);
    expect(out.queries).toHaveLength(1);
    expect(out.queries[0].pred).toMatchObject({ role: ['button'], name: 'Send' });
    expect(out.queries[0].limit).toBe(10);
  });

  it('accepts a batch and validates each entry exactly as a scalar find would', () => {
    const out = parseQueries({
      queries: [{ role: 'textbox' }, { role: ['button', 'link'], name: 'Send', limit: 3 }],
    });
    expect(out.batch).toBe(true);
    expect(out.queries).toHaveLength(2);
    expect(out.queries[1].pred).toMatchObject({ role: ['button', 'link'], name: 'Send' });
    expect(out.queries[1].limit).toBe(3);
  });

  it('lets a batch entry inherit the call-level limit but override it', () => {
    const out = parseQueries({
      limit: 5,
      queries: [{ role: 'button' }, { role: 'link', limit: 1 }],
    });
    expect(out.queries[0].limit).toBe(5);
    expect(out.queries[1].limit).toBe(1);
  });

  it('names the offending index so a typo in one of ten is findable', () => {
    expect(() => parseQueries({ queries: [{ role: 'button' }, { name: 42 }] })).toThrowError(
      /queries\[1\]/,
    );
    // …and applies the same "need at least one field" rule per entry.
    expect(() => parseQueries({ queries: [{ role: 'button' }, {}] })).toThrowError(/queries\[1\]/);
  });

  it('rejects a malformed or oversized batch', () => {
    expect(() => parseQueries({ queries: [] })).toThrowError(/must not be empty/);
    expect(() => parseQueries({ queries: 'button' })).toThrowError(/must be an array/);
    expect(() => parseQueries({ queries: [{ role: 'a' }, 'b'] })).toThrowError(/queries\[1\]/);
    const eleven = Array.from({ length: 11 }, () => ({ role: 'button' }));
    expect(() => parseQueries({ queries: eleven })).toThrowError(/at most 10.*got 11/);
  });

  it('still refuses a predicate-less call — that is just a snapshot', () => {
    expect(() => parseQueries({})).toThrowError(/at least one of role, name, value/);
  });

  it('refuses queries together with a top-level predicate instead of half-honouring it', () => {
    // `limit` used to fall through from the call level while role/name/value
    // silently did not, so this quietly ignored half of what was asked.
    for (const extra of [
      { role: 'button' },
      { name: 'Send' },
      { nameExact: true },
      { value: 'x' },
    ]) {
      expect(() => parseQueries({ ...extra, queries: [{ role: 'link' }] })).toThrowError(
        /either queries or a single predicate/,
      );
    }
  });
});

describe('parseFindTimeout', () => {
  it('defaults to no waiting — one snapshot, the historical behaviour', () => {
    expect(parseFindTimeout(undefined)).toBe(0);
    expect(parseFindTimeout(null)).toBe(0);
    expect(parseFindTimeout(0)).toBe(0);
  });

  it('accepts a deadline and caps it', () => {
    expect(parseFindTimeout(2000)).toBe(2000);
    expect(parseFindTimeout(999_999)).toBe(30_000);
  });

  it('rejects nonsense rather than coercing it to "no wait"', () => {
    expect(() => parseFindTimeout(-1)).toThrowError(/timeoutMs/);
    expect(() => parseFindTimeout(1.5)).toThrowError(/timeoutMs/);
    expect(() => parseFindTimeout('soon')).toThrowError(/timeoutMs/);
  });
});
