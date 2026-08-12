/**
 * `fetch_in_page`'s payload ceiling and its `saveAs` interaction.
 *
 * Why the ceiling is not politeness: an oversize tool_result trips the daemon's
 * 16 MiB frame cap, and that is a 1009 close of the SHARED extension leg. It
 * fails not just the caller's call but every OTHER session's in-flight call,
 * and `not_connected` is retryable — so a well-behaved agent reconnects and
 * tears the leg down again. `print_to_pdf` and `screenshot` already self-police
 * for exactly this reason; this is the third.
 */

import { beforeAll, describe, expect, it } from 'vitest';

let FETCH_MAX_BYTES: number;
let FETCH_MAX_WIRE_BYTES: number;
let wireBytes: (data: string) => number;
let checkFetchSize: (data: string, saveAs: boolean) => void;
let fetchTooLarge: (bytes: number, saveAs: boolean) => { code: string; message: string };

beforeAll(async () => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: { onRemoved: { addListener() {} } },
    debugger: { onDetach: { addListener() {} } },
  };
  ({ FETCH_MAX_BYTES, FETCH_MAX_WIRE_BYTES, wireBytes, checkFetchSize, fetchTooLarge } =
    (await import('../src/tools/fetch.js')) as unknown as {
      FETCH_MAX_BYTES: number;
      FETCH_MAX_WIRE_BYTES: number;
      wireBytes: typeof wireBytes;
      checkFetchSize: typeof checkFetchSize;
      fetchTooLarge: typeof fetchTooLarge;
    });
});

describe('fetch_in_page size ceiling', () => {
  it('leaves headroom under the 16 MiB frame cap for the envelope and MAC', () => {
    const FRAME_CAP = 16 * 1024 * 1024;
    expect(FETCH_MAX_WIRE_BYTES).toBe(12 * 1024 * 1024);
    expect(FETCH_MAX_WIRE_BYTES).toBeLessThan(FRAME_CAP);
    // The in-page early-out is sized so a base64 body under it also lands under
    // the wire cap: 9 MiB of binary → exactly 12 MiB of base64.
    expect(Math.ceil(FETCH_MAX_BYTES / 3) * 4).toBeLessThanOrEqual(FETCH_MAX_WIRE_BYTES);
  });

  it('is a stable, non-retryable code that names the limit it actually enforces', () => {
    const err = fetchTooLarge(20_000_000, false);
    expect(err.code).toBe('fetch_too_large');
    expect(err.message).toContain('20000000');
    expect(err.message).toContain(String(FETCH_MAX_WIRE_BYTES));
  });

  it('tells a saveAs caller that saveAs is NOT the workaround', () => {
    // The tempting wrong inference: "it is going to disk, so the cap does not
    // apply". It does — the body crosses the bridge before the daemon writes it.
    const err = fetchTooLarge(20_000_000, true);
    expect(err.message).toContain('saveAs does not help');
    const plain = fetchTooLarge(20_000_000, false);
    expect(plain.message).not.toContain('saveAs');
  });

  it('points at a recovery that can actually work', () => {
    expect(fetchTooLarge(20_000_000, false).message).toMatch(/Range/);
  });
});

/**
 * The gate that actually protects the shared leg. The in-page check is an
 * early-out only: it runs in the page's MAIN world, where TextEncoder and
 * friends are page-owned, so nothing load-bearing may rest on what it says
 * (invariant #4). This one measures the string the EXTENSION holds, and it
 * measures what the wire carries rather than what the body decodes to.
 */
describe('checkFetchSize (the trusted-side gate)', () => {
  it('measures JSON-escaped UTF-8, not the decoded length', () => {
    // Base64 is pure ASCII with nothing to escape: 2 quote chars of overhead.
    expect(wireBytes('abcd')).toBe(6);
    // A quote doubles; a C0 control becomes \u00XX — six bytes for one.
    expect(wireBytes('"')).toBe(4);
    expect(wireBytes('\u0001')).toBe(8);
    // Non-ASCII passes through unescaped but costs multiple UTF-8 bytes.
    expect(wireBytes('т')).toBe(4);
  });

  it('rejects a body whose ESCAPED form blows the cap though its raw length does not', () => {
    // This is the case the in-page byte check cannot see: well under the
    // decoded-byte ceiling, far over it once serialised.
    const controls = '\u0001'.repeat(Math.ceil(FETCH_MAX_WIRE_BYTES / 6) + 10);
    expect(controls.length).toBeLessThan(FETCH_MAX_BYTES);
    expect(() => checkFetchSize(controls, false)).toThrowError(/fetch_too_large|serialises/);
  });

  it('passes an ordinary body of the same raw length', () => {
    expect(() => checkFetchSize('a'.repeat(1_000_000), false)).not.toThrow();
  });

  it('throws the saveAs-aware wording so the caller does not think saveAs exempts it', () => {
    const big = '\u0001'.repeat(Math.ceil(FETCH_MAX_WIRE_BYTES / 6) + 10);
    let msg = '';
    try {
      checkFetchSize(big, true);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('saveAs does not help');
  });
});

describe('the serialised page expression', () => {
  it('parses as standalone JS with the constant interpolated', async () => {
    // The fetch body is built as a template literal with our OWN constant
    // interpolated (never agent input). If it stopped parsing, every
    // fetch_in_page call would fail at runtime with an opaque page error.
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/tools/fetch.ts', import.meta.url), 'utf8');
    const m = src.match(/const expr = `([\s\S]*?)`;/);
    expect(m).not.toBeNull();
    const body = m![1]
      .replace(/\$\{JSON\.stringify\([^)]*\)\}/g, '"x"')
      .replace(/\$\{bodyJson\}/g, 'undefined')
      .replace(/\$\{FETCH_MAX_BYTES\}/g, String(FETCH_MAX_BYTES));
    expect(() => new Function('return ' + body)).not.toThrow();
  });

  it('checks the size on BOTH the binary and the text path', async () => {
    // The text path is the easy one to forget, and it is the one where UTF-16
    // length lies about byte count — 9M characters of Cyrillic is 18 MB.
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/tools/fetch.ts', import.meta.url), 'utf8');
    expect(src).toContain('new TextEncoder().encode(text).length');
    expect(src.match(/tooLargeBytes/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
