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
