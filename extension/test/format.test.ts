import { describe, expect, it } from 'vitest';
import { extractHostname, formatRelativeTime, matchesAuditFilter } from '../src/format.js';

const NOW = new Date('2026-05-22T12:00:00Z').getTime();

describe('formatRelativeTime', () => {
  it('collapses sub-10s events to "just now"', () => {
    expect(formatRelativeTime(NOW - 5_000, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW, NOW)).toBe('just now');
  });

  it('shows seconds for the first minute', () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('30s ago');
  });

  it('shows minutes for the first hour', () => {
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(formatRelativeTime(NOW - 59 * 60_000, NOW)).toBe('59m ago');
  });

  it('shows hours for the first day', () => {
    expect(formatRelativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
  });

  it('shows days up to a week', () => {
    expect(formatRelativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
  });

  it('falls back to calendar date for old timestamps', () => {
    const out = formatRelativeTime(NOW - 30 * 86_400_000, NOW);
    // Locale-dependent but should contain a 3-letter month abbreviation.
    expect(out).toMatch(/[A-Z][a-z]{2}/);
  });

  it('clamps future timestamps to "just now" instead of negative diffs', () => {
    expect(formatRelativeTime(NOW + 5_000, NOW)).toBe('just now');
  });
});

describe('extractHostname', () => {
  it('returns lowercased hostname for http(s)', () => {
    expect(extractHostname('https://Example.COM/path')).toBe('example.com');
    expect(extractHostname('http://x.io')).toBe('x.io');
  });

  it('returns null for chrome:// and other non-web schemes', () => {
    expect(extractHostname('chrome://extensions')).toBeNull();
    expect(extractHostname('about:blank')).toBeNull();
    expect(extractHostname('file:///home/user')).toBeNull();
    expect(extractHostname('chrome-extension://abc/popup.html')).toBeNull();
  });

  it('returns null for malformed URLs and undefined input', () => {
    expect(extractHostname(undefined)).toBeNull();
    expect(extractHostname('not a url')).toBeNull();
    expect(extractHostname('')).toBeNull();
  });
});

describe('matchesAuditFilter', () => {
  const entry = {
    tool: 'navigate',
    url: 'https://example.com/page',
    error: 'allowlist reject',
  };

  it('returns true for empty / whitespace queries', () => {
    expect(matchesAuditFilter(entry, '')).toBe(true);
    expect(matchesAuditFilter(entry, '   ')).toBe(true);
  });

  it('matches by tool name, case-insensitive', () => {
    expect(matchesAuditFilter(entry, 'nav')).toBe(true);
    expect(matchesAuditFilter(entry, 'NAVIGATE')).toBe(true);
    expect(matchesAuditFilter(entry, 'click')).toBe(false);
  });

  it('matches by url substring', () => {
    expect(matchesAuditFilter(entry, 'example')).toBe(true);
    expect(matchesAuditFilter(entry, 'EXAMPLE.com')).toBe(true);
  });

  it('matches by error text', () => {
    expect(matchesAuditFilter(entry, 'reject')).toBe(true);
  });

  it('handles missing url / error fields', () => {
    expect(matchesAuditFilter({ tool: 'click' }, 'click')).toBe(true);
    expect(matchesAuditFilter({ tool: 'click' }, 'example')).toBe(false);
  });
});
