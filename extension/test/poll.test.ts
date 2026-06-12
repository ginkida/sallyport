import { describe, expect, it } from 'vitest';

import { parseTimeoutMs, parseWaitFor } from '../src/tools/poll.js';

describe('parseTimeoutMs', () => {
  it('defaults when undefined', () => {
    expect(parseTimeoutMs(undefined, 't')).toBe(10_000);
  });

  it('accepts zero and plain numbers', () => {
    expect(parseTimeoutMs(0, 't')).toBe(0);
    expect(parseTimeoutMs(5000, 't')).toBe(5000);
  });

  it('caps at 30 s (stays under the daemon wire timeout)', () => {
    expect(parseTimeoutMs(120_000, 't')).toBe(30_000);
  });

  it('rejects negatives and non-numbers with the tool name in the message', () => {
    expect(() => parseTimeoutMs(-1, 'click')).toThrowError(/click.*timeoutMs/);
    expect(() => parseTimeoutMs('soon', 'click')).toThrowError(/timeoutMs/);
  });
});

describe('parseWaitFor', () => {
  it('returns null when absent', () => {
    expect(parseWaitFor(undefined, 't')).toBeNull();
    expect(parseWaitFor(null, 't')).toBeNull();
  });

  it('parses a full spec', () => {
    expect(
      parseWaitFor({ selector: '.chat', text: 'Sent', timeoutMs: 5000, absent: true }, 't'),
    ).toEqual({
      selector: '.chat',
      text: 'Sent',
      timeoutMs: 5000,
      absent: true,
    });
  });

  it('defaults timeout and absent', () => {
    expect(parseWaitFor({ selector: '#x' }, 't')).toEqual({
      selector: '#x',
      text: null,
      timeoutMs: 10_000,
      absent: false,
    });
  });

  it('treats empty strings as missing', () => {
    expect(parseWaitFor({ selector: '', text: 'ok' }, 't')?.selector).toBeNull();
  });

  it('rejects non-objects loudly (typos must not skip the wait silently)', () => {
    expect(() => parseWaitFor('.selector', 't')).toThrowError(/waitFor must be an object/);
    expect(() => parseWaitFor(['.a'], 't')).toThrowError(/waitFor must be an object/);
  });

  it('rejects a spec with neither selector nor text', () => {
    expect(() => parseWaitFor({ timeoutMs: 100 }, 'fill')).toThrowError(
      /fill.*selector and\/or text/,
    );
  });
});
