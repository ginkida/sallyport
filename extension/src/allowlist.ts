import type { AllowEntry } from './storage.js';

// Patterns supported:
//   "example.com"          — exact host, ANY port
//   "*.example.com"        — host or any subdomain, ANY port
//   "https://x.com/p/*"    — protocol + host + path prefix, default port
//   "https://x.com:8443/*" — protocol + host + EXACT port + path prefix
// No raw wildcard "*" — must list domains explicitly.
//
// Port semantics: a host-only pattern matches any port (so a developer who
// allowlists `localhost` reaches `localhost:3000`); a URL pattern with an
// explicit port matches ONLY that port; a URL pattern without a port matches
// only the scheme's default port. Pinning a port therefore requires the
// `https://host:port/...` form — that is the boundary the syntax implies and
// the matcher now honors it (previously the port was silently ignored).

export type MatchResult = {
  matched: boolean;
  entry?: AllowEntry;
};

export function matchAllowlist(url: string, list: AllowEntry[]): MatchResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { matched: false };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { matched: false };
  }
  const host = parsed.hostname.toLowerCase();
  for (const entry of list) {
    if (matchOne(parsed, host, entry.pattern)) {
      return { matched: true, entry };
    }
  }
  return { matched: false };
}

function matchOne(url: URL, host: string, pattern: string): boolean {
  const pat = pattern.trim().toLowerCase();
  if (!pat) return false;

  if (pat.startsWith('http://') || pat.startsWith('https://')) {
    try {
      const pu = new URL(pat.replace(/\*$/, ''));
      if (pu.protocol !== url.protocol) return false;
      if (!hostMatches(host, pu.hostname)) return false;
      // `URL.port` is '' for the scheme's default port. So an explicit
      // `:8443` must match exactly; a pattern with no port (pu.port === '')
      // matches only the default-port URL (url.port === ''). A host-only
      // pattern never reaches here, so it keeps any-port semantics.
      if (url.port !== pu.port) return false;
      if (pat.endsWith('*')) {
        return url.pathname.startsWith(pu.pathname);
      }
      return url.pathname === pu.pathname || url.pathname === pu.pathname + '/';
    } catch {
      return false;
    }
  }
  return hostMatches(host, pat);
}

function hostMatches(host: string, pattern: string): boolean {
  if (pattern === host) return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith('.' + suffix);
  }
  return false;
}

export function normalizePattern(input: string): string {
  return input.trim().toLowerCase();
}

export function validatePattern(pattern: string): string | null {
  const p = pattern.trim();
  if (!p) return 'empty pattern';
  if (p === '*' || p === '*.*') return 'wildcards must be scoped to a domain';
  if (p.startsWith('http://') || p.startsWith('https://')) {
    try {
      new URL(p.replace(/\*$/, ''));
    } catch {
      return 'invalid URL pattern';
    }
    return null;
  }
  if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(p)) {
    return 'pattern must look like example.com or *.example.com';
  }
  return null;
}
