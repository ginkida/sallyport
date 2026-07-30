import type { AllowEntry } from './storage.js';

// Patterns supported:
//   "example.com"          — exact host, ANY port
//   "localhost"            — single-label host is fine too (exact, ANY port)
//   "*.example.com"        — host or any subdomain, ANY port
//   "*.localhost"          — same, for a reserved non-public suffix (see below)
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
    // The shape rule is enforced HERE as well as in `validatePattern`, because
    // the validator only guards one of the popup's two add paths and cannot
    // reach an entry stored by an older build. Without this, invariant #3's
    // "bare `*` is rejected" held only by accident — there is no `*`-only branch
    // in this function — while `*.com` (or `https://*.com/*`, whose parsed
    // hostname lands here identically) was honoured in full at the enforcement
    // point. Fail closed on a shape the human is not allowed to enter.
    if (!wildcardSuffixAllowed(suffix)) return false;
    return host === suffix || host.endsWith('.' + suffix);
  }
  return false;
}

/** Single-label suffixes a wildcard may span. `localhost` is loopback by
 * specification and `test` / `invalid` / `example` are reserved names that never
 * resolve publicly (RFC 2606 / 6761), so a wildcard over them can only reach
 * this machine or nothing at all.
 *
 * `local` and `internal` are deliberately ABSENT, though they are equally
 * unroutable — unroutable is not the same as trusted, which is the mistake an
 * earlier version of this rule made. `.local` is mDNS: resolution is
 * unauthenticated and first-responder-wins, so `*.local` authorises every device
 * on whatever network the laptop is attached to right now (router, printer, NAS
 * and Home-Assistant panels on plaintext HTTP), and on an untrusted network any
 * peer can claim a name and become an allowlisted origin. `.internal` is
 * split-horizon corporate and cloud DNS, so `*.internal` is an entire intranet —
 * already logged in, since the agent drives the human's own profile. Both still
 * work in their scoped two-label form (`*.corp.local`, `*.prod.internal`) and as
 * exact hosts (`nas.local`), which is what a homelab actually needs. */
const RESERVED_SUFFIXES = new Set(['localhost', 'test', 'invalid', 'example']);

function wildcardSuffixAllowed(suffix: string): boolean {
  const labels = suffix.split('.');
  // An IP literal has no subdomains, so a wildcard over one is never what was
  // meant — and `*.0.0.1` would reach 1.0.0.1 (a public resolver) and 10.0.0.1.
  if (labels.every((l) => /^[0-9]+$/.test(l))) return false;
  if (labels.length >= 2) return true;
  return RESERVED_SUFFIXES.has(labels[0]);
}

export function normalizePattern(input: string): string {
  return input.trim().toLowerCase();
}

const SHAPE_HINT =
  'a wildcard needs two labels of its own (*.example.com) or a reserved local ' +
  'suffix (*.localhost, *.test); a dotless host must be one of localhost, test, ' +
  'invalid, example — otherwise write the full host (nas.local, wiki.corp.example)';

export function validatePattern(pattern: string): string | null {
  const p = pattern.trim().toLowerCase();
  if (!p) return 'empty pattern';
  if (p === '*' || p === '*.*') return 'wildcards must be scoped to a domain';
  if (p.startsWith('http://') || p.startsWith('https://')) {
    let parsed: URL;
    try {
      parsed = new URL(p.replace(/\*$/, ''));
    } catch {
      return 'invalid URL pattern';
    }
    // The SAME host rule as below. Without this the whole rule was nine
    // characters from being bypassed: `*` is not a forbidden host code point, so
    // `new URL('https://*.com/')` parses with hostname `*.com`, which `matchOne`
    // hands to `hostMatches` exactly like the bare `*.com` we refuse — and the
    // person who just hit that refusal is precisely the one motivated to try the
    // other documented spelling.
    return hostShapeError(parsed.hostname);
  }
  return hostShapeError(p);
}

/** Shared shape check for the host part of any pattern. Returns null when the
 * shape is allowed, else the human-facing reason. */
function hostShapeError(host: string): string | null {
  // A bracketed IPv6 literal is exact-only and can't be label-split. The daemon's
  // own loopback set is {127.0.0.1, ::1, localhost} (invariant #2) and modern dev
  // servers print `http://[::1]:5173`, so refusing to let it be typed left the
  // loopback dev case half-fixed — the popup's quick-add already stored it.
  if (host.startsWith('[')) {
    try {
      return new URL(`http://${host}/`).hostname === host ? null : 'invalid IPv6 host';
    } catch {
      return 'invalid IPv6 host';
    }
  }
  const wildcard = host.startsWith('*.');
  const rest = wildcard ? host.slice(2) : host;
  const labels = rest.split('.');
  if (!labels.every((label) => /^[a-z0-9-]+$/.test(label))) {
    return 'pattern must look like example.com, *.example.com or localhost';
  }
  if (wildcard) {
    return wildcardSuffixAllowed(rest) ? null : `*.${rest} is too broad — ${SHAPE_HINT}`;
  }
  // An EXACT host with a dot is always fine: `hostMatches` compares it verbatim.
  if (labels.length >= 2) return null;
  // A dotless host is gated on the same reserved set. `localhost` is the one
  // such name with a specification behind it; `wiki`, `git`, `jira` are resolved
  // by the DHCP search list, LLMNR or NBT-NS — unauthenticated, different on
  // every network, and the classic squatting target. Generalising `localhost` to
  // every label (as an earlier version of this rule did) meant this gate stopped
  // refusing anything dotless at all.
  return RESERVED_SUFFIXES.has(rest) ? null : `${rest} is not a routable host — ${SHAPE_HINT}`;
}
