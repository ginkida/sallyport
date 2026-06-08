/** Every tool returns this shape. `tabId` and `url` are picked up by
 * `runTool` for the audit log; `data` is what the daemon sees. */
export type ToolResult = { tabId?: number; url?: string; data: unknown };
export type Tool = (args: Record<string, unknown>) => Promise<ToolResult>;
