/** `observe` — the optional post-action look at the page, folded into the
 * action's own result.
 *
 * WHY IT EXISTS. Every action tool used to end blind. `navigate` and `reload`
 * call `clearRefsForTab`, so every `@eN` the agent held is dead the moment they
 * return — a follow-up `snapshot` or `find` is not a choice the agent can
 * optimise away, it is structural. And a `click` returns the tag and 100
 * characters of text, which is almost never enough to decide what to do next.
 * So the common shape of every task was act → look → act → look, at one whole
 * model turn per look: seconds of latency plus a full re-read of the context.
 * `observe` collapses each of those pairs into one call.
 *
 * It is the same idea as the embedded `waitFor` and deliberately the same
 * shape: opt-in, additive to the result, and never able to fail the action it
 * follows. It runs AFTER the wait, because what the agent wants to see is the
 * page once it has settled, not mid-transition.
 *
 * PAYLOAD DISCIPLINE. Round-trips are the expensive axis, but tokens are the
 * one that compounds — an observation sits in the transcript and is re-read on
 * every later turn. So: off by default; `snapshot: 'compact'` returns the flat
 * actionable-element list rather than the tree, which is what an agent about to
 * click something actually needs; text is capped and the cap is bounded.
 *
 * SECURITY. It re-checks the allowlist against the page it is ABOUT TO READ,
 * immediately before reading it — it does not lean on the gate the tool already
 * ran. That is load-bearing for exactly one case, and it is not a hypothetical:
 * `navigate` gates the URL it was ASKED for, and the page can then redirect
 * somewhere else. Without observe, that redirect is caught on the agent's next
 * call, because every tool gates the tab's CURRENT url. Observing inside the
 * navigate would have been the one path that read a page the allowlist never
 * approved (invariant #3). A refusal is folded into the result as
 * `skipped:'domain_not_allowed'` rather than thrown: the action has already
 * happened, so failing it would be a lie, but the page is still not read.
 *
 * Otherwise nothing new is reachable: it reuses `buildSnapshotTree` and the
 * fixed `READ_TEXT_FN` literal, so no new probe and no `allowEvaluate` (#4);
 * refs are minted through the same per-tab `newRef` (#7); and it stays inside
 * the one per-tab call chain (#8).
 */

import {
  capElements,
  capTree,
  collectInteractive,
  SNAPSHOT_MAX_ELEMENTS,
  type TreeNode,
  type CompactElement,
} from './axtree.js';
import { cdp } from './cdp.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { buildSnapshotTree } from './snapshot.js';
import { capText, READ_TEXT_FN, type CappedText } from './text.js';

const DEFAULT_OBSERVE_MAX_CHARS = 2_000;
// Bounded well below read_text's ceiling on purpose: `observe` rides along with
// an action, so it is the payload an agent pays for WITHOUT having asked for a
// read. Anything bigger is a job for read_text, where the agent chose it.
const MAX_OBSERVE_MAX_CHARS = 20_000;

export type ObserveSpec = {
  snapshot: 'compact' | 'tree' | null;
  text: boolean;
  maxChars: number;
};

export type ObserveResult = {
  source?: 'a11y' | 'dom';
  elements?: CompactElement[];
  tree?: TreeNode[];
  text?: string;
  /** The TEXT was cut. Distinct from `snapshotTruncated`, which is the element
   * list being cut — conflating them would let a partial snapshot read as
   * complete, the one failure mode a snapshot must never have. */
  truncated?: true;
  totalChars?: number;
  /** Continue a cut observation with `read_text offset=<nextOffset>`. */
  nextOffset?: number;
  /** `buildSnapshotTree` hit its own walker caps, so the element list is
   * PARTIAL — what you were looking for may simply not be in it. */
  snapshotTruncated?: true;
  /** The page was not read, and why: `domain_not_allowed` (the tab ended up
   * somewhere the allowlist does not cover — typically a redirect) or
   * `tab_gone` (it closed between the action and the look). A closed set, so
   * the model-facing schema can name both. */
  skipped?: 'domain_not_allowed' | 'tab_gone';
  error?: string;
};

/** Parse the embedded `observe` argument. Returns null when absent; throws
 * `bad_args` on a malformed shape so a typo fails loudly instead of silently
 * observing nothing — the same contract `parseWaitFor` has. Pure. */
export function parseObserve(raw: unknown, tool: string): ObserveSpec | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BridgeError(
      'bad_args',
      `${tool}: observe must be an object {snapshot?, text?, maxChars?}`,
    );
  }
  const o = raw as Record<string, unknown>;
  let snapshot: 'compact' | 'tree' | null = null;
  if (o.snapshot !== undefined && o.snapshot !== null && o.snapshot !== false) {
    if (o.snapshot === 'compact' || o.snapshot === 'tree') {
      snapshot = o.snapshot;
    } else if (o.snapshot === true) {
      // `true` is the obvious thing to type; take it as the cheap form rather
      // than rejecting a call that clearly meant "yes, show me".
      snapshot = 'compact';
    } else {
      throw new BridgeError('bad_args', `${tool}: observe.snapshot must be 'compact' or 'tree'`);
    }
  }
  const text = o.text === true;
  if (!snapshot && !text) {
    throw new BridgeError('bad_args', `${tool}: observe needs snapshot and/or text:true`);
  }
  let maxChars = DEFAULT_OBSERVE_MAX_CHARS;
  if (o.maxChars !== undefined && o.maxChars !== null) {
    const v = Number(o.maxChars);
    if (!Number.isInteger(v) || v < 1) {
      throw new BridgeError('bad_args', `${tool}: observe.maxChars must be an integer >= 1`);
    }
    maxChars = Math.min(v, MAX_OBSERVE_MAX_CHARS);
  }
  return { snapshot, text, maxChars };
}

/** Read the page's visible text through the same fixed literal `read_text`
 * uses. Whole page only: a scoped read needs a selector resolve, and `observe`
 * deliberately takes no selector — the agent that knows which subtree it wants
 * can spend a `read_text` on it. */
async function pageText(tabId: number, maxChars: number): Promise<CappedText> {
  const doc = await cdp<{ root: { nodeId: number } }>(tabId, 'DOM.getDocument', { depth: 0 });
  const q = await cdp<{ nodeId: number }>(tabId, 'DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: 'body',
  });
  if (!q.nodeId) return { text: '' };
  const resolved = await cdp<{ object: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
    nodeId: q.nodeId,
  });
  if (!resolved.object.objectId) return { text: '' };
  const out = await cdp<{ result: { value?: string } }>(tabId, 'Runtime.callFunctionOn', {
    objectId: resolved.object.objectId,
    functionDeclaration: READ_TEXT_FN,
    returnByValue: true,
  });
  // The SAME cut read_text uses — snapping both edges off a surrogate pair.
  // A raw slice here was a live defect: a lone half is unsignable, so the
  // signer would discard the ENTIRE tool_result and answer
  // `unserialisable_result` — losing the action's own body (in broker mode,
  // including the epoch of a tab it had just created, orphaning it) and telling
  // the agent an action that DID happen had failed, inviting a retry.
  return capText(out.result.value ?? '', maxChars);
}

/** Run the observation. Errors are FOLDED into the result, never thrown: the
 * action has already happened and cannot be undone, so a snapshot that fails
 * on a mid-navigation page must not retroactively turn a successful click into
 * a failure. Same rule `runEmbeddedWait` follows. */
export async function runObserve(tabId: number, spec: ObserveSpec): Promise<ObserveResult> {
  const out: ObserveResult = {};
  // Gate the page we are ABOUT to read, not the one the tool was asked about.
  // A navigate to an allowlisted URL can land somewhere else entirely (SSO
  // bounce, shortener, consent wall); every ordinary tool re-checks the tab's
  // current url on its next call, and observing inside the action must not be
  // the one path that skips that.
  try {
    const tab = await chrome.tabs.get(tabId);
    await ensureAllowed(tab.url);
  } catch (e) {
    // Two causes, and the agent should be able to tell them apart: the page is
    // off the allowlist, or the tab is simply gone. Anything else the gate can
    // throw is still a refusal to read, so it reports as the gate refusal.
    const gone = !(e instanceof BridgeError);
    return { skipped: gone ? 'tab_gone' : 'domain_not_allowed' };
  }
  try {
    if (spec.snapshot) {
      const { tree, source, truncated } = await buildSnapshotTree(tabId, 'auto');
      out.source = source;
      // Under the same emission caps as `snapshot` itself (axtree.ts). This
      // path needs them at least as much: it rides along on an action's result,
      // so an unbounded tree here does not merely bloat one read — it can push
      // an ordinary click's answer past the frame cap.
      let capTruncated = false;
      if (spec.snapshot === 'compact') {
        const shaped = capElements(collectInteractive(tree), SNAPSHOT_MAX_ELEMENTS);
        out.elements = shaped.elements;
        capTruncated = shaped.truncated;
      } else {
        const shaped = capTree(tree);
        out.tree = shaped.tree;
        capTruncated = shaped.truncated;
      }
      // A walker that hit its caps returns a PARTIAL tree. Dropping that flag
      // would present the cut list as the whole page.
      if (truncated || capTruncated) out.snapshotTruncated = true;
    }
    if (spec.text) {
      const capped = await pageText(tabId, spec.maxChars);
      out.text = capped.text;
      if (capped.truncated) {
        out.truncated = true;
        out.totalChars = capped.totalChars;
        out.nextOffset = capped.nextOffset;
      }
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  return out;
}
