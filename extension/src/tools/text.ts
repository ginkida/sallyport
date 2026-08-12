/** Page text: the one probe that reads it, and the one function that cuts it.
 *
 * A leaf module — it imports nothing but `errors.ts`. That placement is the
 * point: `read_text` (dom.ts) and `observe` (observe.ts) both slice page text,
 * `dom.ts` imports `observe.ts`, and the cutting has a sharp edge that must not
 * be reimplemented per caller. It was, once: `observe` shipped with a raw
 * `slice`, which is how a lone surrogate could reach the signer and take a
 * whole action's result down with it.
 */

import { BridgeError } from './errors.js';

// Trimmed innerText preferred; fall back to textContent (hidden-but-present
// nodes). Pinned as a const so read_text's two branches and the text-wait
// probe can't drift apart. FIXED literal.
export const READ_TEXT_FN =
  'function() { return (this.innerText || this.textContent || "").trim(); }';

// A whole-page innerText on a chat SPA easily runs to tens of KB — past the
// MCP tool-result budget, which shunts the payload into a file the agent
// then has to re-read. Cap by default; `maxChars` overrides either way, and
// the `truncated`/`totalChars` markers keep the cut visible.
const DEFAULT_READ_MAX_CHARS = 20_000;
// A ceiling on top of the default. Without one, `maxChars: 500000` was a single
// call that put ~125k tokens into the window permanently — and unlike a
// snapshot there is no structure to skim, so the model pays for all of it on
// every later turn. With `offset` below, a genuinely long page is now readable
// in pages instead, which is both cheaper and resumable.
const MAX_READ_MAX_CHARS = 200_000;

export function parseMaxChars(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_READ_MAX_CHARS;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1) {
    throw new BridgeError('bad_args', 'read_text: maxChars must be an integer >= 1');
  }
  return Math.min(v, MAX_READ_MAX_CHARS);
}

export function parseOffset(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 0) {
    throw new BridgeError('bad_args', 'read_text: offset must be an integer >= 0');
  }
  return v;
}

export type CappedText = {
  text: string;
  truncated?: true;
  totalChars?: number;
  offset?: number;
  nextOffset?: number;
};

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/** Slice the page text into one readable window.
 *
 * The cut used to be reported (`truncated`/`totalChars`) but not resumable: the
 * only way past character 20 000 was to re-read from zero with a bigger cap,
 * paying for the first 20 000 characters a second time and putting them in the
 * context twice. `nextOffset` is the whole fix — hand it straight back as
 * `offset` to continue.
 *
 * Both edges are snapped off the middle of a surrogate pair. JS string indices
 * are UTF-16 code units, so a naive slice through an emoji leaves a LONE
 * SURROGATE — which `protocol.ts` refuses to sign, turning the whole read into
 * `unserialisable_result`. On a chat SPA, the exact thing this tool is for,
 * that is not a rare boundary. Snapping costs at most one code unit per edge.
 *
 * A page is never returned empty while more text remains: with `maxChars: 1`
 * landing on a pair, the pair is taken whole rather than emitting
 * `{text:'', nextOffset: offset}`, which a paging agent would loop on forever.
 * Pure, so all of this is testable without chrome. */
export function capText(text: string, maxChars: number, offset = 0): CappedText {
  const total = text.length;
  let start = Math.min(offset, total);
  // A low surrogate at `start` means the previous read stopped mid-pair (or the
  // caller invented the offset) — step past the orphan rather than emitting it.
  if (start > 0 && start < total && isLowSurrogate(text.charCodeAt(start))) {
    if (isHighSurrogate(text.charCodeAt(start - 1))) start += 1;
  }
  let end = Math.min(start + maxChars, total);
  if (
    end < total &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  ) {
    end -= 1;
    // …unless that would make this page empty, which would stall a paging loop.
    if (end <= start) end = Math.min(start + 2, total);
  }
  const slice = text.slice(start, end);
  const out: CappedText = { text: slice };
  if (start > 0) out.offset = start;
  if (end < total) {
    out.truncated = true;
    out.totalChars = total;
    out.nextOffset = end;
  } else if (start > 0) {
    // Reached the end on a continuation read — say how long the whole thing was
    // so the agent can tell "done" from "maybe more".
    out.totalChars = total;
  }
  return out;
}
