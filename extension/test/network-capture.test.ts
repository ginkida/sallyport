import { describe, expect, it } from 'vitest';

import {
  clipBody,
  filterNetworkEntries,
  isDataContentType,
  NETWORK_MAX_BODY,
  NETWORK_MAX_ENTRIES,
  originFromUrl,
  parseNetworkArgs,
  shapeNetworkEntry,
  type NetworkEntry,
  type NetworkMeta,
} from '../src/tools/network-capture.js';

const meta = (over: Partial<NetworkMeta> = {}): NetworkMeta => ({
  ts: 1000,
  method: 'GET',
  url: 'https://api.example.com/stat?id=1',
  status: 200,
  type: 'xhr',
  contentType: 'application/json',
  size: 512,
  ...over,
});

describe('originFromUrl', () => {
  it('extracts the origin from an http(s) URL', () => {
    expect(originFromUrl('https://api.example.com/stat?id=1')).toBe('https://api.example.com');
    expect(originFromUrl('http://localhost:3000/x')).toBe('http://localhost:3000');
  });

  it('returns null for empty / non-string / malformed / opaque input', () => {
    expect(originFromUrl('')).toBeNull();
    expect(originFromUrl(undefined)).toBeNull();
    expect(originFromUrl(42)).toBeNull();
    expect(originFromUrl('not a url')).toBeNull();
    expect(originFromUrl('data:application/json,{}')).toBeNull();
    expect(originFromUrl('about:blank')).toBeNull();
  });
});

describe('isDataContentType', () => {
  it('accepts textual data content-types', () => {
    for (const m of [
      'application/json',
      'application/json; charset=utf-8',
      'text/plain',
      'text/html',
      'application/xml',
      'text/csv',
      'application/x-ndjson',
      'application/graphql-response+json',
      'application/javascript',
    ]) {
      expect(isDataContentType(m)).toBe(true);
    }
  });

  it('rejects binary / media / empty / non-string content-types', () => {
    for (const m of ['image/png', 'font/woff2', 'video/mp4', 'application/octet-stream', '', 42]) {
      expect(isDataContentType(m as unknown)).toBe(false);
    }
  });
});

describe('clipBody', () => {
  it('leaves a short body intact', () => {
    expect(clipBody('hello')).toEqual({ body: 'hello', truncated: false });
  });

  it('clips an oversized body and flags truncation', () => {
    const big = 'x'.repeat(NETWORK_MAX_BODY + 10);
    const out = clipBody(big);
    expect(out.truncated).toBe(true);
    expect(out.body.length).toBe(NETWORK_MAX_BODY);
  });

  it('honours a custom cap', () => {
    expect(clipBody('abcdef', 3)).toEqual({ body: 'abc', truncated: true });
  });
});

describe('shapeNetworkEntry', () => {
  it('attaches a body and derives the origin', () => {
    const e = shapeNetworkEntry(meta(), '{"visits":42}');
    expect(e).toMatchObject({
      ts: 1000,
      method: 'GET',
      url: 'https://api.example.com/stat?id=1',
      status: 200,
      type: 'xhr',
      contentType: 'application/json',
      size: 512,
      origin: 'https://api.example.com',
      body: '{"visits":42}',
    });
    expect(e.bodyTruncated).toBeUndefined();
  });

  it('omits the body when none was captured (binary/unavailable)', () => {
    const e = shapeNetworkEntry(meta({ contentType: 'image/png' }), null);
    expect(e.body).toBeUndefined();
    expect(e.bodyTruncated).toBeUndefined();
  });

  it('flags bodyTruncated for an oversized body', () => {
    const e = shapeNetworkEntry(meta(), 'y'.repeat(NETWORK_MAX_BODY + 1));
    expect(e.bodyTruncated).toBe(true);
    expect(e.body?.length).toBe(NETWORK_MAX_BODY);
  });

  it('sets origin null for an opaque URL (dropped at read time)', () => {
    const e = shapeNetworkEntry(meta({ url: 'data:application/json,{}' }), '{}');
    expect(e.origin).toBeNull();
  });
});

describe('filterNetworkEntries', () => {
  const mk = (over: Partial<NetworkEntry>): NetworkEntry => ({
    ts: 0,
    method: 'GET',
    url: 'https://api.example.com/stat',
    status: 200,
    type: 'xhr',
    contentType: 'application/json',
    size: 0,
    origin: 'https://api.example.com',
    ...over,
  });
  const allowAll = () => true;

  it('drops entries whose origin is not allowed (and null origins, fail-closed)', () => {
    const entries = [
      mk({ url: 'https://api.example.com/a', origin: 'https://api.example.com' }),
      mk({ url: 'https://evil.test/b', origin: 'https://evil.test' }),
      mk({ url: 'data:application/json,{}', origin: null }),
    ];
    const isAllowed = (o: string) => o === 'https://api.example.com';
    const { entries: out, total } = filterNetworkEntries(entries, isAllowed, { limit: 50 });
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://api.example.com/a');
    expect(total).toBe(1);
  });

  it('applies a case-insensitive URL substring filter', () => {
    const entries = [
      mk({ url: 'https://api.example.com/STAT/v1' }),
      mk({ url: 'https://api.example.com/assets/logo' }),
    ];
    const { entries: out, total } = filterNetworkEntries(entries, allowAll, {
      filter: 'stat',
      limit: 50,
    });
    expect(out).toHaveLength(1);
    expect(out[0].url).toContain('STAT');
    expect(total).toBe(1);
  });

  it('slices to the newest limit and reports the pre-slice total', () => {
    const entries = [1, 2, 3, 4, 5].map((n) => mk({ url: `https://api.example.com/r${n}`, ts: n }));
    const { entries: out, total } = filterNetworkEntries(entries, allowAll, { limit: 2 });
    expect(total).toBe(5);
    expect(out.map((e) => e.ts)).toEqual([4, 5]); // newest two, oldest→newest
  });
});

describe('parseNetworkArgs', () => {
  it('defaults limit to 20 with no filter', () => {
    expect(parseNetworkArgs({})).toEqual({ limit: 20 });
  });

  it('accepts and caps a positive integer limit', () => {
    expect(parseNetworkArgs({ limit: 5 })).toEqual({ limit: 5 });
    expect(parseNetworkArgs({ limit: 9999 })).toEqual({ limit: NETWORK_MAX_ENTRIES });
  });

  it('rejects a non-positive / non-integer limit', () => {
    expect(() => parseNetworkArgs({ limit: 0 })).toThrow(/positive integer/);
    expect(() => parseNetworkArgs({ limit: -3 })).toThrow(/positive integer/);
    expect(() => parseNetworkArgs({ limit: 1.5 })).toThrow(/positive integer/);
  });

  it('passes through a string filter and rejects a non-string one', () => {
    expect(parseNetworkArgs({ filter: 'api' })).toEqual({ limit: 20, filter: 'api' });
    expect(() => parseNetworkArgs({ filter: 42 })).toThrow(/filter must be a string/);
  });
});
