import { collectInteractive } from './axtree.js';
import { attach } from './cdp.js';
import { ensureAllowed } from './gates.js';
import { matchElements, parseLimit, parsePredicate } from './match.js';
import { buildSnapshotTree } from './snapshot.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

/** Semantic locator: snapshot the page, then return @eN refs of interactive
 * elements matching a role/name/value predicate — instead of guessing CSS
 * against hashed SPA classnames. The match runs extension-side over the
 * snapshot's flat element list; `find` adds no page probe of its own, so it
 * needs no allowEvaluate. Empty matches is a normal not-found, not an error. */
export const find: Tool = async (args) => {
  const pred = parsePredicate(args, 'find');
  const mode = args.mode === 'a11y' || args.mode === 'dom' ? args.mode : 'auto';
  const limit = parseLimit(args.limit);
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  const { tree, source, truncated } = await buildSnapshotTree(tab.id!, mode);
  const all = matchElements(collectInteractive(tree), pred);
  return {
    tabId: tab.id,
    url: tab.url,
    data: {
      source,
      matches: all.slice(0, limit),
      total: all.length,
      ...(truncated ? { truncated: true } : {}),
    },
  };
};
