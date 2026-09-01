import { collectInteractive } from './axtree.js';
import { attach } from './cdp.js';
import { BridgeError } from './errors.js';
import { ensureAllowed, ensureStillAllowed } from './gates.js';
import { matchElements, parseLimit, parsePredicate, type Match, type Predicate } from './match.js';
import { refWatermark } from './refs.js';
import { buildSnapshotTree } from './snapshot.js';
import { resolveTab } from './tab-resolve.js';
import type { Tool } from './types.js';

/** Semantic locator: snapshot the page, then return @eN refs of interactive
 * elements matching a role/name/value predicate — instead of guessing CSS
 * against hashed SPA classnames. The match runs extension-side over the
 * snapshot's flat element list; `find` adds no page probe of its own, so it
 * needs no allowEvaluate. Empty matches is a normal not-found, not an error. */

// Locating several controls is the normal case, not the exception — "the
// composer, the send button, and the row I am replying to" is one intention,
// and it used to be three calls, i.e. three model turns AND three full tree
// walks. The matcher is pure and extension-side, so extra predicates cost
// microseconds and not one extra CDP command; the cap is about keeping the
// result readable, not about cost.
const MAX_QUERIES = 10;

// A poll tick here is a WHOLE accessibility tree, not pollFor's three cheap CDP
// calls — so the cadence is deliberately much slower than the 250 ms the
// selector waits use. `find` with a timeout is for "it has not rendered yet",
// where a half-second granularity is irrelevant, and paying for a full tree
// four times a second on a heavy SPA would trade a round-trip for browser load.
const FIND_POLL_MS = 500;
const MAX_FIND_TIMEOUT_MS = 30_000;

export type FindQuery = { pred: Predicate; limit: number; raw: Record<string, unknown> };

/** Parse find's predicate argument: one predicate, or a batch under `queries`.
 * Returns the list plus whether the caller used the scalar form, because the
 * answer shapes differ and the scalar one must stay byte-compatible. Pure. */
export function parseQueries(args: Record<string, unknown>): {
  queries: FindQuery[];
  batch: boolean;
} {
  const raw = args.queries;
  if (raw === undefined || raw === null) {
    return {
      queries: [{ pred: parsePredicate(args, 'find'), limit: parseLimit(args.limit), raw: args }],
      batch: false,
    };
  }
  if (!Array.isArray(raw)) {
    throw new BridgeError('bad_args', 'find: queries must be an array of predicates');
  }
  // Refuse the ambiguous call rather than inheriting some fields and dropping
  // others: `limit` used to fall through from the call level while role/name/
  // value silently did not, so `find(role:'button', queries:[…])` quietly
  // ignored half of what was asked. Same rule parsePointerTarget applies to
  // selector-vs-x/y.
  for (const key of ['role', 'name', 'nameExact', 'value'] as const) {
    if (args[key] !== undefined) {
      throw new BridgeError(
        'bad_args',
        `find: pass either queries or a single predicate, not both (got queries and ${key})`,
      );
    }
  }
  if (raw.length === 0) {
    throw new BridgeError('bad_args', 'find: queries must not be empty');
  }
  if (raw.length > MAX_QUERIES) {
    throw new BridgeError(
      'bad_args',
      `find: at most ${MAX_QUERIES} queries per call (got ${raw.length})`,
    );
  }
  const queries = raw.map((q, i) => {
    if (typeof q !== 'object' || q === null || Array.isArray(q)) {
      throw new BridgeError('bad_args', `find: queries[${i}] must be an object`);
    }
    const entry = q as Record<string, unknown>;
    // Each entry is validated exactly as a scalar find would be, so a typo in
    // one of ten is rejected with the same message it would get on its own.
    return {
      pred: parsePredicate(entry, `find: queries[${i}]`),
      limit: parseLimit(entry.limit ?? args.limit),
      raw: entry,
    };
  });
  return { queries, batch: true };
}

/** Parse the optional `timeoutMs`. 0 (the default) means answer from a single
 * snapshot — the historical behaviour, and the right one when the agent knows
 * the page has rendered. Pure. */
export function parseFindTimeout(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new BridgeError('bad_args', 'find: timeoutMs must be a non-negative integer');
  }
  return Math.min(n, MAX_FIND_TIMEOUT_MS);
}

/** Which of the query's matches to report, and how many there were. Split out
 * so the shaping is identical for the scalar and batched answers. */
function shape(all: Match[], limit: number): { matches: Match[]; total: number } {
  return { matches: all.slice(0, limit), total: all.length };
}

export const find: Tool = async (args) => {
  const { queries, batch } = parseQueries(args);
  const mode = args.mode === 'a11y' || args.mode === 'dom' ? args.mode : 'auto';
  const timeoutMs = parseFindTimeout(args.timeoutMs);
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);

  const start = Date.now();
  // One mark for the whole poll: every tick but the last is discarded, and
  // those refs never leave the extension (same reasoning as reveal's loop).
  const mark = refWatermark(tab.id!);
  let source: 'a11y' | 'dom' = 'a11y';
  let truncated = false;
  let readUrl = tab.url;
  let results: Array<{ matches: Match[]; total: number }> = [];

  for (;;) {
    // Re-gate on EVERY tick. A poll can run for 30 s, and the page is free to
    // navigate under us in that time — a single check at entry would let the
    // walk read whatever the tab drifted onto (invariant #3). Also gives us the
    // URL actually read, so the result and the audit row describe the same page
    // rather than the one the call started on.
    readUrl = await ensureStillAllowed(tab.id!);
    const built = await buildSnapshotTree(tab.id!, mode, mark);
    source = built.source;
    truncated = built.truncated;
    const flat = collectInteractive(built.tree);
    // One walk, N predicates. The matcher never touches the page.
    results = queries.map((q) => shape(matchElements(flat, q.pred), q.limit));
    // Wait, when asked, until EVERY query has found something: a batch is one
    // intention ("the form is ready"), and reporting it half-satisfied would
    // hand back refs from a snapshot the next one is about to invalidate.
    if (!timeoutMs || results.every((r) => r.total > 0)) break;
    if (Date.now() - start + FIND_POLL_MS > timeoutMs) break;
    await new Promise((r) => setTimeout(r, FIND_POLL_MS));
  }

  const elapsedMs = Date.now() - start;
  if (!batch) {
    return {
      tabId: tab.id,
      url: readUrl,
      data: {
        source,
        ...results[0],
        ...(truncated ? { truncated: true } : {}),
        ...(timeoutMs ? { elapsedMs } : {}),
      },
    };
  }
  return {
    tabId: tab.id,
    url: readUrl,
    data: {
      source,
      results: queries.map((q, i) => ({ query: q.raw, ...results[i] })),
      ...(truncated ? { truncated: true } : {}),
      ...(timeoutMs ? { elapsedMs } : {}),
    },
  };
};
