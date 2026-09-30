/** Every tool returns this shape. `tabId` and `url` are picked up by
 * `runTool` for the audit log; `data` is what the daemon sees. */
export type ToolResult = { tabId?: number; url?: string; data: unknown };

/** Per-call context the registry supplies alongside the agent's arguments.
 *
 * `client` is the calling session's cosmetic label (broker mode only). It is
 * passed EXPLICITLY rather than read from a module-level "current call" global,
 * because calls now overlap — a shared mutable "current client" would be read
 * by the wrong call the moment two sessions interleave. Purely presentational:
 * it groups a session's tabs into their own window and tags audit rows. It is
 * peer-declared, so it must never gate anything. */
export type ToolContext = {
  client?: string;
  /** When `runTool` received the call (`Date.now()`). The daemon's clock for
   * this call is already running; a tool that waits after a slow step spends
   * what is LEFT of it (see poll.ts:CALL_BUDGET_MS), not a fresh allowance. */
  startedAt?: number;
};

export type Tool = (args: Record<string, unknown>, ctx?: ToolContext) => Promise<ToolResult>;
