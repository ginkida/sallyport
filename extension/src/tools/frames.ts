/** What a read of this page CANNOT see: the frames inside it.
 *
 * Neither the a11y walk, the DOM walk nor `read_text`'s body probe crosses a
 * frame boundary — the document behind one is separate, and for a cross-origin
 * frame it lives in another process. Erasing that fact is what made a checkout,
 * an SSO step or an embedded dashboard read as an empty shell, so the reading
 * tools say so instead.
 *
 * A leaf module (it imports `cdp.ts` and nothing else) so both `snapshot.ts`
 * and `dom.ts` can use it without the graph growing an edge between them. */

import { cdp } from './cdp.js';

/** Child-frame origins of the page, for the `frames` field on `snapshot` and `read_text`.
 *
 * Pure over a `Page.getFrameTree` response so the walk and the filtering are
 * unit-tested. ORIGINS ONLY, never full urls: the frame's current location can
 * carry a token or an account identifier (an OAuth step lands on one routinely),
 * and the parent document — which the caller is allowed to read in full — can
 * only see the `src` it set, not where the frame navigated itself. The origin
 * names the gap without shipping anything the page itself doesn't already
 * expose. The `src` DOES ride along in the DOM walk's iframe leaf, where it is
 * exactly the parent's own attribute.
 *
 * `about:blank`, `about:srcdoc` and `data:` frames are dropped: they are the
 * page's own scaffolding, not another document the agent needs to know about. */
export function frameOrigins(tree: unknown, max = 20): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || out.length >= max) return;
    const n = node as { frame?: { url?: unknown }; childFrames?: unknown };
    // depth 0 is the main frame — it is the page the caller already knows.
    if (depth > 0 && typeof n.frame?.url === 'string') {
      let origin: string | null = null;
      try {
        const u = new URL(n.frame.url);
        origin = u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
      } catch {
        origin = null;
      }
      if (origin && !seen.has(origin)) {
        seen.add(origin);
        out.push(origin);
      }
    }
    if (Array.isArray(n.childFrames)) {
      for (const child of n.childFrames) visit(child, depth + 1);
    }
  };
  visit((tree as { frameTree?: unknown })?.frameTree, 0);
  return out;
}

/** Ask the browser which frames the page has. Best-effort in every direction:
 * a failure (or a build of Chrome that wants `Page.enable` first) simply means
 * the `frames` field is absent, and the tree's own iframe nodes still say a
 * frame is there. One browser-side call per explicit `snapshot` — deliberately
 * NOT inside `buildSnapshotTree`, which `find` and `reveal` run in a loop. */
export async function pageFrameOrigins(tabId: number): Promise<string[]> {
  try {
    return frameOrigins(await cdp<unknown>(tabId, 'Page.getFrameTree'));
  } catch {
    return [];
  }
}
