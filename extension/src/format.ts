// Pure formatting helpers used by the popup. Kept here so they can be unit
// tested without a DOM.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact human time relative to `now`. Matches the conventions a user
 * scanning the audit log expects: emphasises recent events, collapses
 * older ones to a clock time, very old ones to a calendar date.
 *
 * - <10s → "just now"
 * - <60s → "Ns ago"
 * - <60m → "Nm ago"
 * - <24h → "Nh ago"
 * - same calendar day before that bucket → fall through to "Nh ago"
 *   (no special case — 23h still reads fine)
 * - <7d → "Nd ago"
 * - older → locale date (e.g. "Mar 15")
 *
 * Future timestamps (clock skew) are clamped to "just now".
 */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < 10_000) return 'just now';
  if (diff < MINUTE) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Substring filter for audit entries. We match against tool name, URL,
 * and error text — the three fields a user is realistically scanning for
 * when triaging the log. Pure so it can be unit tested.
 */
export function matchesAuditFilter(
  entry: { tool: string; url?: string; error?: string },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (entry.tool.toLowerCase().includes(q)) return true;
  if (entry.url && entry.url.toLowerCase().includes(q)) return true;
  if (entry.error && entry.error.toLowerCase().includes(q)) return true;
  return false;
}

/**
 * Best-effort hostname extractor for URLs we pull from `chrome.tabs.query`
 * or `chrome.runtime.openOptionsPage` callers. Returns the lowercased
 * hostname for http(s) URLs and `null` for chrome://, about:, file://,
 * extension URLs, or anything we can't parse — the popup uses `null` to
 * mean "no domain you'd realistically allowlist".
 */
export function extractHostname(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}
