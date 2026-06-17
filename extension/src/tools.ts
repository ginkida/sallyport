/** Tool registry — the only public surface of `src/tools/*`.
 *
 * Background.ts imports `runTool`, `TOOL_NAMES`, `BridgeError` from here.
 * Implementations live in `src/tools/<module>.ts` so each file owns one
 * concern. Adding a new tool: write it as a `Tool` in a module, add an
 * entry below, write a matching MCP schema in the daemon. */

import { appendAudit, getSettings, redactAuditArgs, type AuditEntry } from './storage.js';
import { BridgeError } from './tools/errors.js';
import { evaluate } from './tools/evaluate.js';
import { click, fill, readText } from './tools/dom.js';
import { fetchInPage } from './tools/fetch.js';
import { find } from './tools/find.js';
import { keyType, sendKeys } from './tools/keyboard.js';
import { mouseClick } from './tools/mouse.js';
import { reveal } from './tools/reveal.js';
import { screenshot } from './tools/screenshot.js';
import { settle } from './tools/settle.js';
import { snapshot } from './tools/snapshot.js';
import { closeTab, listTabs, navigate, reload } from './tools/tabs.js';
import { upload } from './tools/upload.js';
import { waitFor } from './tools/wait.js';
import type { Tool } from './tools/types.js';

export { BridgeError } from './tools/errors.js';

const tools: Record<string, Tool> = {
  list_tabs: listTabs,
  navigate,
  reload,
  close_tab: closeTab,
  snapshot,
  read_text: readText,
  click,
  mouse_click: mouseClick,
  fill,
  key_type: keyType,
  send_keys: sendKeys,
  screenshot,
  wait_for: waitFor,
  settle,
  find,
  reveal,
  evaluate,
  fetch_in_page: fetchInPage,
  upload,
};

export const TOOL_NAMES = Object.keys(tools);

export async function runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const settings = await getSettings();
  if (settings.paused) {
    throw new BridgeError('paused', 'Sallyport is paused — resume from the popup');
  }
  const tool = tools[name];
  if (!tool) throw new BridgeError('unknown_tool', `unknown tool: ${name}`);

  const audit: AuditEntry = {
    ts: Date.now(),
    tool: name,
    args: redactAuditArgs(name, args),
    ok: false,
  };
  if (typeof args.tabId === 'number') audit.tabId = args.tabId;

  try {
    const result = await tool(args);
    audit.ok = true;
    if (result.tabId !== undefined) audit.tabId = result.tabId;
    if (result.url !== undefined) audit.url = result.url;
    await appendAudit(audit);
    return result.data;
  } catch (e) {
    audit.error = e instanceof Error ? e.message : String(e);
    // A typing call rejected by the password gate still carries the
    // attempted secret in args (the success path already redacts when
    // allowPassword=true). Redact it before it reaches the audit log.
    if (e instanceof BridgeError && e.code === 'password_field') {
      audit.args = redactAuditArgs(name, args, { force: true });
    }
    await appendAudit(audit);
    throw e;
  }
}
