/** Pure semantic matcher over the flat interactive-element list from a
 * snapshot (`collectInteractive`). Shared by `find` and `reveal` so the two
 * can't drift on "how a target is matched". Runs ENTIRELY extension-side over
 * the already-returned `CompactElement[]` — no agent string is ever
 * interpolated into a page probe (the snapshot probes are fixed literals).
 * Chrome-free, so it is unit-tested under vitest. */

import type { CompactElement } from './axtree.js';
import { BridgeError } from './errors.js';

export type Predicate = {
  /** One-of role match (exact). Undefined = any role. */
  role?: string[];
  /** Name match: substring (default) or exact when `nameExact`. */
  name?: string;
  nameExact?: boolean;
  /** Substring match on String(value). */
  value?: string;
};

export type Match = CompactElement & { score: number };

/** Parse + validate a predicate from raw tool args (shared by find/reveal).
 * Throws `bad_args` on a malformed shape, and when no usable field is given
 * (a predicate-less find is just a snapshot). */
export function parsePredicate(args: Record<string, unknown>, tool: string): Predicate {
  const pred: Predicate = { nameExact: args.nameExact === true };

  if (args.role !== undefined) {
    if (typeof args.role === 'string') {
      if (args.role !== '') pred.role = [args.role];
    } else if (Array.isArray(args.role) && args.role.every((r) => typeof r === 'string')) {
      const roles = (args.role as string[]).filter((r) => r !== '');
      if (roles.length) pred.role = roles;
    } else {
      throw new BridgeError('bad_args', `${tool}: role must be a string or array of strings`);
    }
  }
  if (args.name !== undefined) {
    if (typeof args.name !== 'string') {
      throw new BridgeError('bad_args', `${tool}: name must be a string`);
    }
    if (args.name !== '') pred.name = args.name;
  }
  if (args.value !== undefined) {
    if (typeof args.value !== 'string') {
      throw new BridgeError('bad_args', `${tool}: value must be a string`);
    }
    if (args.value !== '') pred.value = args.value;
  }

  if (!pred.role && pred.name === undefined && pred.value === undefined) {
    throw new BridgeError('bad_args', `${tool}: need at least one of role, name, value`);
  }
  return pred;
}

function scoreOne(
  el: CompactElement,
  pred: Predicate,
  roles: string[] | null,
  nameQ: string | undefined,
  valueQ: string | undefined,
): number | null {
  if (roles && !roles.includes(el.role)) return null;

  let nameScore = 0;
  if (nameQ !== undefined) {
    if (!el.name) return null; // a name predicate requires a name
    const n = el.name.toLowerCase();
    if (pred.nameExact) {
      if (n !== nameQ) return null;
      nameScore = 100;
    } else {
      if (!n.includes(nameQ)) return null;
      nameScore = n === nameQ ? 100 : n.startsWith(nameQ) ? 50 : 10;
    }
  }
  if (valueQ !== undefined && !String(el.value ?? '').toLowerCase().includes(valueQ)) {
    return null;
  }

  let score = nameScore;
  if (roles) score += 5;
  if (valueQ !== undefined) score += 5;
  // Tie-break toward the tightest label ("Send" over "Send a message") — but
  // only when matching BY name, so role/value-only results keep pure document
  // order instead of being silently reordered by label length.
  if (nameQ !== undefined) score -= (el.name?.length ?? 0) * 0.01;
  return score;
}

/** AND across every provided field; ranked best-first (exact name > prefix >
 * substring), ties broken by document order. */
export function matchElements(els: CompactElement[], pred: Predicate): Match[] {
  const roles = pred.role && pred.role.length ? pred.role : null;
  const nameQ = pred.name?.toLowerCase();
  const valueQ = pred.value?.toLowerCase();

  const scored: Array<{ el: CompactElement; i: number; score: number }> = [];
  els.forEach((el, i) => {
    const s = scoreOne(el, pred, roles, nameQ, valueQ);
    if (s !== null) scored.push({ el, i, score: s });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((x) => ({ ...x.el, score: x.score }));
}
