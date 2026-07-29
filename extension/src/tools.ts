/** Tool registry — the only public surface of `src/tools/*`.
 *
 * Background.ts imports `runTool`, `TOOL_NAMES`, `BridgeError` from here.
 * Implementations live in `src/tools/<module>.ts` so each file owns one
 * concern. Adding a new tool: write it as a `Tool` in a module, add an
 * entry below, write a matching MCP schema in the daemon. */

import { appendAudit, getSettings, redactAuditArgs, type AuditEntry } from './storage.js';
import { BridgeError } from './tools/errors.js';
import {
  CLIENT_LABEL_ARG,
  confirmEpoch,
  EXPECTED_EPOCH_ARG,
  stripBrokerArgs,
} from './tools/ownership.js';
import { releaseTabs } from './tools/release.js';
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
import { printToPdf } from './tools/pdf.js';
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
  print_to_pdf: printToPdf,
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

/** Tools the DAEMON calls on its own initiative, never an agent. Kept out of
 * `tools` (and therefore out of `TOOL_NAMES` and the MCP catalogue) so the
 * advertised surface stays exactly what an agent may ask for. */
const internalTools: Record<string, Tool> = {
  _release_tabs: releaseTabs,
};

/** Per-tab serialisation of tool bodies.
 *
 * Calls now overlap (the daemon runs one lane per session, and the connection
 * no longer queues them), and per-tab state is emphatically NOT safe for two
 * concurrent calls on the SAME tab: `buildSnapshotTree` resets that tab's refs
 * mid-flight, and snapshot/mouse release a shared CDP object group in their
 * `finally` — a second call would have its handles freed under it and its `@eN`
 * refs renumbered.
 *
 * It is defence-in-depth EVERYWHERE, not a load-bearing gate: the daemon's
 * per-client lane is what actually serialises, and since ownership is exclusive
 * per client (invariant #13) "one call per client" already implies "one call
 * per tab". Standalone is a single lane too, so it is uncontended there as
 * well. The point is that this file is the one chokepoint every tool passes
 * through, so a future change that widens daemon concurrency cannot silently
 * corrupt per-tab state (refs, snapshot/mouse object groups) before anyone
 * notices. It costs nothing when uncontended. */
const tabChains = new Map<number, Promise<unknown>>();

function onTab<T>(tabId: number | undefined, run: () => Promise<T>): Promise<T> {
  if (typeof tabId !== 'number') return run();
  const prior = tabChains.get(tabId) ?? Promise.resolve();
  const next = prior.then(run, run);
  // Never let a rejection break the chain for later calls, and drop the entry
  // once the tab goes quiet so the map doesn't grow with every tab ever driven.
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  tabChains.set(tabId, settled);
  void settled.then(() => {
    if (tabChains.get(tabId) === settled) tabChains.delete(tabId);
  });
  return next;
}

export async function runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const settings = await getSettings();
  if (settings.paused) {
    throw new BridgeError('paused', 'Sallyport is paused — resume from the popup');
  }
  const tool = tools[name] ?? internalTools[name];
  if (!tool) throw new BridgeError('unknown_tool', `unknown tool: ${name}`);

  // Broker-mode ownership confirmation (invariant #13, defence-in-depth). The
  // daemon is the authoritative gate but injects the create-time epoch it
  // recorded for the owned tab; we confirm it matches what we minted before
  // acting, so a recycled Chrome tabId can't silently retarget us (tab_gone).
  // Strip the broker-internal fields so neither the tool nor the audit sees
  // them as ordinary arguments.
  const expectedEpoch = args[EXPECTED_EPOCH_ARG];
  const rawLabel = args[CLIENT_LABEL_ARG];
  const client = typeof rawLabel === 'string' && rawLabel ? rawLabel : undefined;
  const callArgs = stripBrokerArgs(args);

  const audit: AuditEntry = {
    ts: Date.now(),
    tool: name,
    args: redactAuditArgs(name, callArgs),
    ok: false,
  };
  // Which session did this. With several agents driving one browser the audit
  // log is otherwise an unattributable interleaved stream — and losing the
  // serialisation that used to make it roughly chronological per session
  // removes even that weak proxy.
  if (client !== undefined) audit.client = client;
  if (typeof callArgs.tabId === 'number') audit.tabId = callArgs.tabId;

  try {
    if (expectedEpoch !== undefined && typeof callArgs.tabId === 'number') {
      confirmEpoch(callArgs.tabId, expectedEpoch);
    }
    const result = await onTab(
      typeof callArgs.tabId === 'number' ? callArgs.tabId : undefined,
      () => tool(callArgs, { client }),
    );
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
    // `focus_probe_failed` (the CDP focus walk's fail-closed branch,
    // keyboard.ts/focus.ts) is included too: it fires precisely when we couldn't rule
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
