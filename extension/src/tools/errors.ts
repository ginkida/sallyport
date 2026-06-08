/** Structured errors thrown by tools. `code` is a stable token the daemon
 * forwards verbatim so callers can branch on it (e.g. `domain_not_allowed`,
 * `evaluate_not_allowed`, `password_field`). `message` is the human string.
 */
export class BridgeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
