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
  });

  it('still refuses a dotless host that is not a reserved name', () => {
    // Loosening this rule for `localhost` deliberately did NOT generalise to
    // every label: `no-tld` stays refused, in both the exact and wildcard form.
    expect(validatePattern('no-tld')).toBeTruthy();
    expect(validatePattern('*.no-tld')).toBeTruthy();
  });

  it('rejects malformed URL pattern', () => {
    expect(validatePattern('https://')).toBeTruthy();
  });
});

describe('matchAllowlist — malformed stored pattern', () => {
  it('returns no match when a stored http(s) pattern is not a valid URL (catch path)', () => {
    // matchOne builds `new URL(pattern)`; a malformed pattern that slipped
    // into storage must fail closed (no match), not throw.
    expect(matchAllowlist('https://example.com/', [entry('https://')]).matched).toBe(false);
    expect(matchAllowlist('https://example.com/', [entry('http://[')]).matched).toBe(false);
  });

  it('returns no match when a stored pattern is empty/whitespace-only after trim', () => {
    expect(matchAllowlist('https://example.com/', [entry('')]).matched).toBe(false);
    expect(matchAllowlist('https://example.com/', [entry('   ')]).matched).toBe(false);
  });

  it('URL pattern with matching protocol but a DIFFERENT host does not match', () => {
    // Same protocol/path as the requested URL, but pu.hostname != host — the
    // protocol check alone must not be enough to match.
    expect(
      matchAllowlist('https://evil.com/path/foo', [entry('https://good.com/path/*')]).matched,
    ).toBe(false);
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

describe('validatePattern — the localhost dev case, and how far it may go', () => {
  const e = (pattern: string): AllowEntry => ({ pattern, allowEvaluate: false, addedAt: 0 });

  it('accepts the shapes a local dev server actually needs', () => {
    // The reason this rule was loosened at all: the matcher has always supported
    // `localhost`, a test is named for it, and SECURITY.md offers it as why
    // host-only entries match any port — but the Add field required a dot.
    for (const p of [
      'localhost',
      '*.localhost',
      '*.test',
      'myapp.test',
      'nas.local',
      '*.corp.local',
      '[::1]',
      '127.0.0.1',
      'http://localhost:3000/*',
    ]) {
      expect(validatePattern(p), p).toBeNull();
    }
  });

  it('REFUSES a wildcard over a whole TLD — including via the URL form', () => {
    // The URL branch is the reason this must be tested: `*` is not a forbidden
    // host code point, so `new URL('https://*.com/')` parses with hostname
    // `*.com` and lands in the same matcher. Leaving that branch unchecked put
    // the entire rule nine characters from being bypassed.
    for (const p of [
      '*.com',
      '*.dev',
      '*.app',
      '*.io',
      'https://*.com/*',
      'http://*.com/*',
      'https://*.dev/*',
    ]) {
      expect(validatePattern(p), p).toBeTruthy();
    }
  });

  it('REFUSES *.local and *.internal — unroutable is not trusted', () => {
    // The mistake an earlier version of this rule made. `.local` is mDNS:
    // unauthenticated, first-responder-wins, so it covers every device on
    // whatever network the laptop is on. `.internal` is a whole intranet, and
    // the agent drives the human's own logged-in profile. Both keep their
    // scoped forms, asserted above.
    expect(validatePattern('*.local')).toBeTruthy();
    expect(validatePattern('*.internal')).toBeTruthy();
  });

  it('REFUSES a dotless host that is not a reserved name', () => {
    // `localhost` has a specification behind it; `wiki` / `git` / `jira` are
    // resolved by the DHCP search list, LLMNR or NBT-NS — unauthenticated,
    // different on every network, the classic squatting target. Generalising to
    // every label meant the gate stopped refusing anything dotless at all.
    for (const p of ['wiki', 'git', 'jira', 'no-tld', 'com', 'dev', '-', '--']) {
      expect(validatePattern(p), p).toBeTruthy();
    }
  });

  it('REFUSES a wildcard over an IP literal — an IP has no subdomains', () => {
    // `*.0.0.1` would reach 1.0.0.1 (a public resolver) and 10.0.0.1.
    expect(validatePattern('*.0.0.1')).toBeTruthy();
    expect(validatePattern('*.1.1')).toBeTruthy();
  });

  it('still refuses bare wildcards and malformed labels', () => {
    expect(validatePattern('*')).toMatch(/scoped/);
    expect(validatePattern('*.*')).toMatch(/scoped/);
    expect(validatePattern('')).toMatch(/empty/);
    expect(validatePattern('exa mple.com')).toMatch(/must look like/);
    expect(validatePattern('foo..com')).toMatch(/must look like/);
    expect(validatePattern('::1')).toMatch(/must look like/); // unbracketed IPv6
    expect(validatePattern('[::1]:3000')).toBeTruthy();
  });

  it('every refusal names a shape that actually validates', () => {
    // A refusal is the one moment a human reasons about scope, so its advice
    // must not be a dead end. Pull each suggested pattern back through the
    // validator rather than trusting the prose.
    for (const refused of ['*.com', 'wiki', '*.local']) {
      const msg = validatePattern(refused);
      expect(msg, refused).toBeTruthy();
      for (const suggested of (msg as string).match(/\*?\.?[a-z0-9-]+\.[a-z0-9-]+/g) ?? []) {
        if (suggested.includes('example.com') || suggested.includes('localhost')) {
          expect(validatePattern(suggested), `${refused} -> ${suggested}`).toBeNull();
        }
      }
    }
  });

  it('the MATCHER enforces the same shape, so a stored illegal entry is inert', () => {
    // Defence in depth: `validatePattern` guards typing, not authorisation. An
    // entry can arrive from an older build, and until this guard existed
    // invariant #3 held only because `hostMatches` happens to have no `*`-only
    // branch. Each of these would previously have been honoured in full.
    for (const [url, pattern] of [
      ['https://evil.com/x', '*.com'],
      ['https://mail.google.com/x', 'https://*.com/*'],
      ['http://router.local/admin', '*.local'],
      ['http://jenkins.internal/', '*.internal'],
      ['http://1.0.0.1/', '*.0.0.1'],
    ] as const) {
      expect(matchAllowlist(url, [e(pattern)]).matched, `${url} vs ${pattern}`).toBe(false);
    }
  });

  it('and still honours what it should', () => {
    expect(matchAllowlist('http://localhost:3000/x', [e('*.localhost')]).matched).toBe(true);
    expect(matchAllowlist('http://app.localhost:8000/x', [e('*.localhost')]).matched).toBe(true);
    expect(matchAllowlist('http://localhost:5173/x', [e('localhost')]).matched).toBe(true);
    expect(matchAllowlist('http://[::1]:5173/x', [e('[::1]')]).matched).toBe(true);
    expect(matchAllowlist('http://myapp.test/x', [e('*.test')]).matched).toBe(true);
    expect(matchAllowlist('http://nas.local/x', [e('nas.local')]).matched).toBe(true);
    expect(matchAllowlist('https://api.example.com/x', [e('*.example.com')]).matched).toBe(true);
    // A dotless exact entry must NOT quietly become a wildcard over that label.
    expect(matchAllowlist('http://evil.localhost/x', [e('localhost')]).matched).toBe(false);
    // ...and localhost is not the loopback IP, which the CHANGELOG calls out.
    expect(matchAllowlist('http://127.0.0.1:3000/x', [e('localhost')]).matched).toBe(false);
  });
});
