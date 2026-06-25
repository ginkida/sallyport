import { describe, expect, it } from 'vitest';

import {
  CONSOLE_MAX_ENTRIES,
  CONSOLE_MAX_TEXT,
  filterByAllowedOrigins,
  originFromStackUrl,
  parseConsoleLimit,
  pushCapped,
  shapeConsoleEntry,
  type ConsoleEntry,
} from '../src/tools/console-capture.js';

describe('originFromStackUrl', () => {
  it('extracts the origin from an http(s) script URL', () => {
    expect(originFromStackUrl('https://example.com/app/bundle.js?v=2')).toBe('https://example.com');
    expect(originFromStackUrl('http://localhost:3000/x.js')).toBe('http://localhost:3000');
  });

  it('returns null for empty / non-string / malformed input', () => {
    expect(originFromStackUrl('')).toBeNull();
    expect(originFromStackUrl(undefined)).toBeNull();
    expect(originFromStackUrl(42)).toBeNull();
    expect(originFromStackUrl('not a url')).toBeNull();
  });

  it('returns null for opaque (null-origin) schemes', () => {
    expect(originFromStackUrl('about:blank')).toBeNull();
    expect(originFromStackUrl('data:text/html,<p>x')).toBeNull();
  });
});

describe('shapeConsoleEntry', () => {
  it('maps a console.error with its producing origin', () => {
    const entry = shapeConsoleEntry(
      'Runtime.consoleAPICalled',
      {
        type: 'error',
        args: [{ value: 'submit failed:' }, { value: 42 }],
        stackTrace: { callFrames: [{ url: 'https://app.example.com/x.js' }] },
      },
      1000,
    );
    expect(entry).toEqual({
      ts: 1000,
      level: 'error',
      text: 'submit failed: 42',
      origin: 'https://app.example.com',
    });
  });

  it('keeps warnings as level=warning and assert as error', () => {
    expect(
      shapeConsoleEntry('Runtime.consoleAPICalled', { type: 'warning', args: [] }, 1)?.level,
    ).toBe('warning');
    expect(
      shapeConsoleEntry('Runtime.consoleAPICalled', { type: 'assert', args: [] }, 1)?.level,
    ).toBe('error');
  });

  it('drops console.log / info / debug (noise for failure diagnosis)', () => {
    expect(shapeConsoleEntry('Runtime.consoleAPICalled', { type: 'log', args: [] }, 1)).toBeNull();
    expect(shapeConsoleEntry('Runtime.consoleAPICalled', { type: 'info', args: [] }, 1)).toBeNull();
  });

  it('maps an uncaught exception to an error entry with the exception description', () => {
    const entry = shapeConsoleEntry(
      'Runtime.exceptionThrown',
      {
        exceptionDetails: {
          text: 'Uncaught',
          exception: {
            description: 'TypeError: x is not a function\n  at f (https://a.example/b.js:1:1)',
          },
          stackTrace: { callFrames: [{ url: 'https://a.example/b.js' }] },
        },
      },
      2000,
    );
    expect(entry?.level).toBe('error');
    expect(entry?.origin).toBe('https://a.example');
    expect(entry?.text).toContain('TypeError');
  });

  it('caps the text at CONSOLE_MAX_TEXT', () => {
    const entry = shapeConsoleEntry(
      'Runtime.consoleAPICalled',
      { type: 'error', args: [{ value: 'x'.repeat(5000) }] },
      1,
    );
    expect(entry?.text.length).toBe(CONSOLE_MAX_TEXT);
  });

  it('records a null origin when the stack has no usable URL', () => {
    const entry = shapeConsoleEntry('Runtime.consoleAPICalled', { type: 'error', args: [] }, 1);
    expect(entry?.origin).toBeNull();
  });

  it('ignores unrelated debugger events', () => {
    expect(shapeConsoleEntry('Network.requestWillBeSent', {}, 1)).toBeNull();
  });
});

describe('pushCapped', () => {
  it('appends and evicts the oldest beyond max', () => {
    const buf: number[] = [];
    for (let i = 0; i < CONSOLE_MAX_ENTRIES + 5; i++) pushCapped(buf, i, CONSOLE_MAX_ENTRIES);
    expect(buf).toHaveLength(CONSOLE_MAX_ENTRIES);
    expect(buf[0]).toBe(5); // first five evicted
    expect(buf[buf.length - 1]).toBe(CONSOLE_MAX_ENTRIES + 4);
  });
});

describe('filterByAllowedOrigins', () => {
  const entry = (origin: string | null): ConsoleEntry => ({
    ts: 1,
    level: 'error',
    text: 'e',
    origin,
  });
  const allowed = new Set(['https://ok.example']);
  const isAllowed = (o: string): boolean => allowed.has(o);

  it('keeps only allowed origins', () => {
    const out = filterByAllowedOrigins(
      [entry('https://ok.example'), entry('https://evil.example')],
      isAllowed,
    );
    expect(out).toHaveLength(1);
    expect(out[0].origin).toBe('https://ok.example');
  });

  it('drops null-origin entries fail-closed (never returned)', () => {
    expect(filterByAllowedOrigins([entry(null)], isAllowed)).toHaveLength(0);
    expect(filterByAllowedOrigins([entry(null)], () => true)).toHaveLength(0);
  });
});

describe('parseConsoleLimit', () => {
  it('defaults to the ring size and caps there', () => {
    expect(parseConsoleLimit(undefined)).toBe(50);
    expect(parseConsoleLimit(999)).toBe(CONSOLE_MAX_ENTRIES);
    expect(parseConsoleLimit(10)).toBe(10);
  });

  it('rejects zero, negatives and non-integers', () => {
    expect(() => parseConsoleLimit(0)).toThrowError(/limit must be a positive integer/);
    expect(() => parseConsoleLimit(-1)).toThrowError(/limit/);
    expect(() => parseConsoleLimit(2.5)).toThrowError(/limit/);
  });
});
