/** Structured errors thrown by tools. `code` is a stable token the daemon
 * forwards verbatim so callers can branch on it (e.g. `domain_not_allowed`,
 * `evaluate_not_allowed`, `password_field`). `message` is the human string.
 */
export class BridgeError extends Error {
  code: string;
  /** Optional structured, machine-readable failure metadata that rides the
   * tool_result body alongside `code`/`message` (additive — the MAC covers the
   * body wholesale, so PROTOCOL_VERSION is unchanged). It is surfaced verbatim
   * to the agent, so it MUST carry only structural metadata
   * (labels/values/tags/counts/indices) and NEVER a value read from a resolved
   * node (no `.value` read-back channel). Left undefined by every gate that
   * doesn't explicitly opt in — currently only select_option's not_found
   * populates it. */
  detail?: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** A `@eN` whose node the page has since destroyed.
 *
 * Distinct from "a ref we never minted" only in wording; both are `bad_ref`,
 * whose taxonomy hint already says "re-snapshot for a fresh ref". Before this
 * existed the destroyed-node case escaped as the raw CDP rejection, i.e. as code
 * `error`, whose hint says the opposite ("if it recurs identically, treat it as
 * non-retryable") — so the agent's cheapest recovery was the one the error told
 * it not to take. Lives here rather than in dom.ts because the wait engine
 * (poll.ts) raises the same failure and must not import dom.ts. */
export function staleRefError(tool: string, ref: string): BridgeError {
  return new BridgeError(
    'bad_ref',
    `${tool}: ref "${ref}" no longer resolves — the page re-rendered since the snapshot; ` +
      `run snapshot or find again for a fresh ref`,
  );
}

/** CSS the browser refuses to parse. Names the Playwright-isms explicitly
 * because they are what a model emits by reflex, and points at the tool that
 * actually does what they were reaching for. `bad_args` is retryable=no, which
 * is the truth here: an identical retry fails identically. */
export function invalidSelectorError(tool: string, selector: string): BridgeError {
  return new BridgeError(
    'bad_args',
    `${tool}: not a valid CSS selector: ${selector} — :has-text(), :contains() and text= are ` +
      `Playwright syntax, not CSS; locate the element with find (role/name) and act on the ` +
      `@eN ref it returns`,
  );
}
