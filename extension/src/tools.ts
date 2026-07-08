/** Tool registry — the only public surface of `src/tools/*`.
 *
 * Background.ts imports `runTool`, `TOOL_NAMES`, `BridgeError` from here.
 * Implementations live in `src/tools/<module>.ts` so each file owns one
 * concern. Adding a new tool: write it as a `Tool` in a module, add an
 * entry below, write a matching MCP schema in the daemon. */

import { appendAudit, getSettings, redactAuditArgs, type AuditEntry } from './storage.js';
import { BridgeError } from './tools/errors.js';
import { confirmEpoch, EXPECTED_EPOCH_ARG, stripEpochArg } from './tools/ownership.js';
import { evaluate } from './tools/evaluate.js';
import { consoleTail } from './tools/console.js';
import { handleDialog } from './tools/dialog.js';
import { click, fill, readText } from './tools/dom.js';
import { fetchInPage } from './tools/fetch.js';
import { find } from './tools/find.js';
import { historyGo } from './tools/history.js';
import { keyType, sendKeys } from './tools/keyboard.js';
import { hover, mouseClick } from './tools/mouse.js';
import { networkTail } from './tools/network.js';
import { reveal } from './tools/reveal.js';
import { screenshot } from './tools/screenshot.js';
import { selectOption } from './tools/select.js';
import { settle } from './tools/settle.js';
import { scroll } from './tools/scroll.js';
import { snapshot } from './tools/snapshot.js';
import { getState } from './tools/state.js';
import { closeTab, listTabs, navigate, reload } from './tools/tabs.js';
import { upload } from './tools/upload.js';
import { waitFor } from './tools/wait.js';
import type { Tool } from './tools/types.js';

export { BridgeError } from './tools/errors.js';

const tools: Record<string, Tool> = {
  list_tabs: listTabs,
  navigate,
  reload,
  history_go: historyGo,
  close_tab: closeTab,
  snapshot,
  read_text: readText,
  get_state: getState,
  console_tail: consoleTail,
  network_tail: networkTail,
  handle_dialog: handleDialog,
  click,
  mouse_click: mouseClick,
  hover,
  fill,
  select_option: selectOption,
  key_type: keyType,
  send_keys: sendKeys,
  screenshot,
  wait_for: waitFor,
  settle,
  find,
  reveal,
  scroll,
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

  // Broker-mode ownership confirmation (invariant #13, defence-in-depth). The
  // daemon is the authoritative gate but injects the create-time epoch it
  // recorded for the owned tab; we confirm it matches what we minted before
  // acting, so a recycled Chrome tabId can't silently retarget us (tab_gone).
  // Strip the broker-internal field so neither the tool nor the audit sees it.
  const expectedEpoch = args[EXPECTED_EPOCH_ARG];
  const callArgs = stripEpochArg(args);

  const audit: AuditEntry = {
    ts: Date.now(),
    tool: name,
    args: redactAuditArgs(name, callArgs),
    ok: false,
  };
  if (typeof callArgs.tabId === 'number') audit.tabId = callArgs.tabId;

  try {
    if (expectedEpoch !== undefined && typeof callArgs.tabId === 'number') {
      confirmEpoch(callArgs.tabId, expectedEpoch);
    }
    const result = await tool(callArgs);
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
    // `focus_probe_failed` (classifyPasswordProbe's fail-closed branch,
    // focus.ts) is included too: it fires precisely when we couldn't rule
    // OUT a password field, so the same "might be a credential" reasoning
    // applies — not redacting here would leak the attempted secret into the
    // persisted, popup-exportable audit log even though the keystroke itself
    // was correctly blocked from reaching the page.
    if (
      e instanceof BridgeError &&
      (e.code === 'password_field' || e.code === 'focus_probe_failed')
    ) {
      audit.args = redactAuditArgs(name, callArgs, { force: true });
    }
    await appendAudit(audit);
    throw e;
  }
}
