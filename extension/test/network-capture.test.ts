import { describe, expect, it } from 'vitest';

import {
  applyResponseBudget,
  bodyWireBytes,
  clipBody,
  clipUrl,
  entryWireBytes,
  filterNetworkEntries,
  isDataContentType,
  NETWORK_MAX_BODY,
  NETWORK_MAX_ENTRIES,
  NETWORK_MAX_META_FIELD,
  NETWORK_MAX_URL,
  NETWORK_RESPONSE_BUDGET,
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

  it('clips a pathologically long url but keeps origin from the FULL url (#3, Finding 2)', () => {
    const longUrl = 'https://api.example.com/x?q=' + 'a'.repeat(900_000);
    const e = shapeNetworkEntry(meta({ url: longUrl }), null);
    expect(e.url.length).toBe(NETWORK_MAX_URL);
    expect(e.urlTruncated).toBe(true);
    // origin taken before clipping, so the fail-closed allowlist filter is intact.
    expect(e.origin).toBe('https://api.example.com');
  });

  it('leaves a normal url untruncated', () => {
    const e = shapeNetworkEntry(meta(), '{}');
    expect(e.urlTruncated).toBeUndefined();
    expect(e.url).toBe('https://api.example.com/stat?id=1');
  });

  it('caps the sibling controllable metadata fields method + contentType (round-4)', () => {
    // A pathological fetch(url,{method:'X'.repeat(...)}) or a server emitting a
    // giant Content-Type must not blow the frame cap via the metadata path the
    // url cap doesn't cover.
    const e = shapeNetworkEntry(
      meta({
        method: 'M'.repeat(200_000),
        contentType: 'application/json' + ';x='.repeat(100_000),
      }),
      null,
    );
    expect(e.method.length).toBe(NETWORK_MAX_META_FIELD);
    expect(e.contentType.length).toBe(NETWORK_MAX_META_FIELD);
  });

  it('leaves normal method + contentType untouched (never truncates real values)', () => {
    const e = shapeNetworkEntry(meta({ method: 'POST', contentType: 'application/json' }), '{}');
    expect(e.method).toBe('POST');
    expect(e.contentType).toBe('application/json');
  });

  it('length-bounds origin in code but never truncates a real origin (allowlist intact)', () => {
    // A real (allowlist-passing) origin is DNS-bounded well under the cap, so it is
    // returned verbatim — the fail-closed allowlist filter matches on the full value.
    const real = shapeNetworkEntry(meta({ url: 'https://api.example.com/x' }), '{}');
    expect(real.origin).toBe('https://api.example.com');
    // A pathological host string (only reachable in isolation, never a returned
    // entry) is still bounded in code, not left to the external DNS limit.
    const huge = shapeNetworkEntry(
      meta({ url: 'https://' + 'a'.repeat(5000) + '.example.com/y' }),
      null,
    );
    expect(huge.origin).not.toBeNull();
    expect(huge.origin!.length).toBe(NETWORK_MAX_URL);
  });
});

describe('clipUrl', () => {
  it('leaves a normal url untouched', () => {
    const { url, truncated } = clipUrl('https://api.example.com/stat?id=1');
    expect(truncated).toBe(false);
    expect(url).toBe('https://api.example.com/stat?id=1');
  });

  it('clips an oversized url to NETWORK_MAX_URL and flags truncation', () => {
    const { url, truncated } = clipUrl('https://x/' + 'a'.repeat(NETWORK_MAX_URL));
    expect(truncated).toBe(true);
    expect(url.length).toBe(NETWORK_MAX_URL);
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

describe('applyResponseBudget', () => {
  const withBody = (id: number, bodyLen: number): NetworkEntry => ({
    ts: id,
    method: 'GET',
    url: `https://api.example.com/r${id}`,
    status: 200,
    type: 'xhr',
    contentType: 'application/json',
    size: bodyLen,
    origin: 'https://api.example.com',
    body: 'x'.repeat(bodyLen),
  });

  it('keeps every body when under budget', () => {
    const { entries, omitted } = applyResponseBudget([withBody(1, 100), withBody(2, 100)], 1000);
    expect(omitted).toBe(0);
    expect(entries.map((e) => e.body?.length)).toEqual([100, 100]);
    expect(entries.some((e) => e.bodyOmitted)).toBe(false);
  });

  it('keeps the NEWEST entries whole within budget and drops older bodies to metadata', () => {
    // oldest→newest. Budget = room for the two newest WHOLE entries (metadata +
    // body) but not the third's body — computed from entryWireBytes so the test
    // tracks the real accounting, not a hand-counted body-only figure.
    const e1 = withBody(1, 100);
    const e2 = withBody(2, 100);
    const e3 = withBody(3, 100);
    const budget = entryWireBytes(e2) + entryWireBytes(e3) + 5;
    const { entries, omitted } = applyResponseBudget([e1, e2, e3], budget);
    expect(omitted).toBe(1);
    expect(entries[0].body).toBeUndefined();
    expect(entries[0].bodyOmitted).toBe(true);
    expect(entries[0].size).toBe(100); // metadata retained
    expect(entries[1].body?.length).toBe(100);
    expect(entries[2].body?.length).toBe(100);
  });

  it('counts per-entry METADATA, not just the body, against the budget (Finding 2)', () => {
    // An entry whose body alone fits the budget but whose WHOLE serialised form
    // (metadata + body) does not. Body-only accounting kept it — and an uncapped
    // url could then blow the 16 MiB frame cap; whole-entry accounting drops it.
    const e = withBody(1, 100);
    const bodyOnly = bodyWireBytes(e.body!);
    expect(entryWireBytes(e)).toBeGreaterThan(bodyOnly + 50); // metadata is significant
    const { entries, omitted } = applyResponseBudget([e], bodyOnly + 10);
    expect(omitted).toBe(1);
    expect(entries[0].body).toBeUndefined();
    expect(entries[0].bodyOmitted).toBe(true);
  });

  it('counts WIRE bytes not code units — a control-char body that fits by .length is omitted', () => {
    // 10x U+0001: .length === 10, but each escapes to \uXXXX (6 bytes) so the
    // wire cost is ~62 bytes. A code-unit budget of 30 would keep it; the
    // wire-byte budget must omit it. Regression for the 16 MiB frame-cap bug.
    const ctrl: NetworkEntry = {
      ts: 1,
      method: 'GET',
      url: 'https://api.example.com/x',
      status: 200,
      type: 'xhr',
      contentType: 'application/json',
      size: 10,
      origin: 'https://api.example.com',
      body: '\u0001'.repeat(10),
    };
    expect(ctrl.body!.length).toBe(10); // fits a naive code-unit budget of 30
    expect(bodyWireBytes(ctrl.body!)).toBeGreaterThan(30); // but not the wire budget
    const { entries, omitted } = applyResponseBudget([ctrl], 30);
    expect(omitted).toBe(1);
    expect(entries[0].body).toBeUndefined();
    expect(entries[0].bodyOmitted).toBe(true);
  });

  it('does not mutate the input entries (the ring buffer stays intact)', () => {
    const input = [withBody(1, 100), withBody(2, 100)];
    applyResponseBudget(input, 100); // forces one omit
    expect(input[0].body?.length).toBe(100);
    expect(input[0].bodyOmitted).toBeUndefined();
  });

  it('passes through entries that have no body', () => {
    const noBody: NetworkEntry = {
      ts: 1,
      method: 'GET',
      url: 'https://api.example.com/x',
      status: 204,
      type: 'fetch',
      contentType: 'application/json',
      size: 0,
      origin: 'https://api.example.com',
    };
    const { entries, omitted } = applyResponseBudget([noBody], 10);
    expect(omitted).toBe(0);
    expect(entries[0].bodyOmitted).toBeUndefined();
  });

  it('keeps the default budget safely under the 16 MiB frame cap', () => {
    // The budget is now wire bytes, so it directly bounds body cost; keep ample
    // headroom for the envelope, per-entry metadata, and HMAC framing.
    const FRAME_CAP = 16 * 1024 * 1024;
    expect(NETWORK_RESPONSE_BUDGET).toBeLessThanOrEqual(12 * 1024 * 1024);
    expect(FRAME_CAP - NETWORK_RESPONSE_BUDGET).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  });
});
