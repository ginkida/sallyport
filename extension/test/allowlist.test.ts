import { describe, expect, it } from 'vitest';
import { matchAllowlist, normalizePattern, validatePattern } from '../src/allowlist.js';
import type { AllowEntry } from '../src/storage.js';

function entry(pattern: string, allowEvaluate = false): AllowEntry {
  return { pattern, allowEvaluate, addedAt: 0 };
}

describe('matchAllowlist — host patterns', () => {
  it('matches exact host', () => {
    expect(matchAllowlist('https://example.com/', [entry('example.com')]).matched).toBe(true);
  });

  it('exact host does NOT match subdomain', () => {
    expect(matchAllowlist('https://api.example.com/', [entry('example.com')]).matched).toBe(false);
  });

  it('wildcard *.example.com matches subdomain', () => {
    expect(matchAllowlist('https://api.example.com/', [entry('*.example.com')]).matched).toBe(true);
  });

  it('wildcard *.example.com also matches the apex', () => {
    expect(matchAllowlist('https://example.com/', [entry('*.example.com')]).matched).toBe(true);
  });

  it('wildcard *.example.com does NOT match unrelated suffix', () => {
    expect(matchAllowlist('https://notexample.com/', [entry('*.example.com')]).matched).toBe(false);
  });

  it('wildcard does not match across separate domains', () => {
    expect(matchAllowlist('https://evil.com/example.com', [entry('*.example.com')]).matched).toBe(
      false,
    );
  });

  it('is case-insensitive on host', () => {
    expect(matchAllowlist('https://Example.COM/', [entry('example.com')]).matched).toBe(true);
  });
});

describe('matchAllowlist — URL patterns', () => {
  it('matches exact URL prefix', () => {
    expect(matchAllowlist('https://x.com/path/foo', [entry('https://x.com/path/*')]).matched).toBe(
      true,
    );
  });

  it('URL pattern enforces protocol', () => {
    expect(matchAllowlist('http://x.com/path/foo', [entry('https://x.com/path/*')]).matched).toBe(
      false,
    );
  });

  it('URL pattern enforces path prefix', () => {
    expect(matchAllowlist('https://x.com/other/foo', [entry('https://x.com/path/*')]).matched).toBe(
      false,
    );
  });

  it('URL pattern without trailing * is exact-path', () => {
    expect(matchAllowlist('https://x.com/path', [entry('https://x.com/path')]).matched).toBe(true);
    expect(matchAllowlist('https://x.com/path/sub', [entry('https://x.com/path')]).matched).toBe(
      false,
    );
  });
});

describe('matchAllowlist — rejection paths', () => {
  it('returns matched=false for invalid URLs', () => {
    expect(matchAllowlist('not-a-url', [entry('example.com')]).matched).toBe(false);
  });

  it('rejects non-http(s) schemes', () => {
    expect(matchAllowlist('chrome://settings', [entry('settings')]).matched).toBe(false);
    expect(matchAllowlist('file:///etc/passwd', [entry('*')]).matched).toBe(false);
  });

  it('returns matched=false on empty list', () => {
    expect(matchAllowlist('https://example.com/', []).matched).toBe(false);
  });

  it('returns the matched entry so allowEvaluate is reachable', () => {
    const list = [entry('example.com', true)];
    const result = matchAllowlist('https://example.com/', list);
    expect(result.matched).toBe(true);
    expect(result.entry?.allowEvaluate).toBe(true);
  });

  it('picks the first matching entry', () => {
    const list = [entry('example.com', false), entry('*.example.com', true)];
    const result = matchAllowlist('https://example.com/', list);
    expect(result.entry?.allowEvaluate).toBe(false);
  });
});

describe('validatePattern', () => {
  it.each([
    ['example.com', null],
    ['sub.example.com', null],
    ['*.example.com', null],
    ['https://x.com/path/*', null],
    ['http://x.com/p', null],
  ])('accepts %s', (p, expected) => {
    expect(validatePattern(p)).toBe(expected);
  });

  it('rejects empty', () => {
    expect(validatePattern('')).toMatch(/empty/);
    expect(validatePattern('   ')).toMatch(/empty/);
  });

  it('rejects bare wildcard', () => {
    expect(validatePattern('*')).toMatch(/wildcard/);
    expect(validatePattern('*.*')).toMatch(/wildcard/);
  });

  it('rejects embedded / mid-label wildcards (only a leading *. is allowed)', () => {
    // A wildcard anywhere other than the leading `*.` label must be refused
    // so an allow of `sub.example.com` can never be widened by a sneaky
    // pattern. The host regex rejects the `*` outright.
    for (const bad of [
      'sub*.example.com',
      'sub*example.com',
      'ex*mple.com',
      '*example.com',
      'example.*',
      'a.*.example.com',
      '*.*.example.com',
    ]) {
      expect(validatePattern(bad)).toBeTruthy();
    }
  });

  it('rejects malformed', () => {
    expect(validatePattern('not a host')).toBeTruthy();
    expect(validatePattern('no-tld')).toBeTruthy();
  });

  it('rejects malformed URL pattern', () => {
    expect(validatePattern('https://')).toBeTruthy();
  });
});

describe('matchAllowlist — port handling', () => {
  it('host-only pattern matches any port (localhost dev case)', () => {
    expect(matchAllowlist('http://localhost:3000/', [entry('localhost')]).matched).toBe(true);
    expect(
      matchAllowlist('https://app.example.com:8443/', [entry('app.example.com')]).matched,
    ).toBe(true);
  });

  it('URL pattern with an explicit port matches ONLY that port', () => {
    const list = [entry('https://allowed.com:9000/x/*')];
    expect(matchAllowlist('https://allowed.com:9000/x/y', list).matched).toBe(true);
    // The bug that motivated this: :8443 must NOT match a :9000 pattern.
    expect(matchAllowlist('https://allowed.com:8443/x/y', list).matched).toBe(false);
    // Nor the default port.
    expect(matchAllowlist('https://allowed.com/x/y', list).matched).toBe(false);
  });

  it('URL pattern without a port matches only the default port', () => {
    const list = [entry('https://allowed.com/p/*')];
    expect(matchAllowlist('https://allowed.com/p/y', list).matched).toBe(true);
    expect(matchAllowlist('https://allowed.com:8443/p/y', list).matched).toBe(false);
  });

  it('explicit default port in a pattern still matches the default-port URL', () => {
    // new URL() normalises :443 to '' for https, so this stays default-port.
    const list = [entry('https://allowed.com:443/p/*')];
    expect(matchAllowlist('https://allowed.com/p/y', list).matched).toBe(true);
    expect(matchAllowlist('https://allowed.com:8443/p/y', list).matched).toBe(false);
  });
});

describe('normalizePattern', () => {
  it('trims and lowercases', () => {
    expect(normalizePattern('  EXAMPLE.com  ')).toBe('example.com');
  });
});
