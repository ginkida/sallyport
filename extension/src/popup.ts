import {
  getAllowlist,
  setAllowlist,
  getAudit,
  clearAudit,
  getSettings,
  setSettings,
  DEFAULT_SERVER_URL,
  type AllowEntry,
  type AuditEntry,
} from './storage.js';
import { matchAllowlist, normalizePattern, validatePattern } from './allowlist.js';
import { classifySecretInput, EXPECTED_SECRET_BYTES } from './pairing.js';
import { extractHostname, formatRelativeTime, matchesAuditFilter } from './format.js';
import { nextReconnectKick } from './reconnect-kick.js';
import type { AgentTabRow } from './background.js';

type Status = {
  state: 'disconnected' | 'connecting' | 'connected' | 'no_secret';
  serverUrl: string;
  lastError: string | null;
};

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

function send<T>(msg: unknown): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp as T));
  });
}

// -------------------------------------------------------------------------
// Inline flash — green/red banner that fades out after ~2s. Used for "✓
// added example.com" / "✓ saved" / "✕ pattern invalid" feedback.
// -------------------------------------------------------------------------

const flashTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function flash(sel: string, msg: string, kind: 'ok' | 'err' = 'ok'): void {
  const el = $(sel);
  if (!el) return;
  el.className = 'flash ' + kind;
  el.textContent = (kind === 'ok' ? '✓ ' : '✕ ') + msg;
  const prev = flashTimers.get(el);
  if (prev) clearTimeout(prev);
  flashTimers.set(
    el,
    setTimeout(() => {
      el.classList.add('fade');
      setTimeout(() => {
        el.textContent = '';
        el.className = 'flash';
      }, 320);
    }, 1800),
  );
}

// -------------------------------------------------------------------------
// Tab switching
// -------------------------------------------------------------------------

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.tab;
    if (!id) return;
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    $(`#tab-${id}`)?.classList.add('active');
    if (id === 'allowlist') renderAllowlist();
    if (id === 'audit') renderAudit();
  });
});

// -------------------------------------------------------------------------
// Top-level view switcher: onboarding vs main UI
// -------------------------------------------------------------------------

function setView(state: Status['state']): void {
  const showOnboarding = state === 'no_secret';
  $('#onboarding').classList.toggle('hidden', !showOnboarding);
  $('#main').classList.toggle('hidden', showOnboarding);
}

// -------------------------------------------------------------------------
// Status / connected view
// -------------------------------------------------------------------------

function renderBadge(state: Status['state'], paused: boolean): void {
  const badge = $('#state-badge');
  badge.className = 'badge ' + (paused ? 'disconnected' : state);
  badge.textContent = paused
    ? 'paused'
    : state === 'connected'
      ? 'connected'
      : state === 'connecting'
        ? 'connecting…'
        : state === 'no_secret'
          ? 'not paired'
          : 'disconnected';
}

function renderStatusCard(status: Status, paused: boolean): void {
  const card = $('#status-card');
  const variant = paused ? 'paused' : status.state;
  card.className = 'status-card ' + variant;

  const titleMap: Record<string, string> = {
    paused: 'Paused',
    connected: 'Connected and listening',
    connecting: 'Connecting to daemon…',
    disconnected: 'Disconnected',
    no_secret: 'Not paired',
  };
  ($('#status-title') as HTMLElement).textContent = titleMap[variant] ?? variant;

  const subMap: Record<string, string> = {
    paused: 'No commands will be executed until you resume.',
    connected: status.serverUrl,
    connecting: status.serverUrl,
    disconnected: 'Start the daemon, then Reconnect.',
    no_secret: 'Paste the daemon secret to pair.',
  };
  ($('#status-sub') as HTMLElement).textContent = subMap[variant] ?? '';

  ($('#status-error') as HTMLElement).textContent =
    status.state === 'connected' || paused ? '' : (status.lastError ?? '');

  $('#paused-block').classList.toggle('hidden', !paused);
  $('#actions-block').classList.toggle('hidden', paused);
}

async function renderSummary(connected: boolean): Promise<void> {
  const el = $('#status-summary');
  el.classList.toggle('hidden', !connected);
  if (!connected) return;
  const [allow, audit] = await Promise.all([getAllowlist(), getAudit()]);
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const recent = audit.filter((e) => e.ts >= hourAgo).length;
  const sites = `${allow.length} site${allow.length === 1 ? '' : 's'} allowed`;
  const calls = `${recent} call${recent === 1 ? '' : 's'} in the last hour`;
  el.textContent = `${sites} · ${calls}`;
}

/** Compact tail of the audit log on the Status tab — the at-a-glance
 * "is it working / what just failed" view. Full history lives in the Audit tab.
 * Sourced from the extension's own audit log (the daemon's status-ring is not
 * reachable from the popup). */
async function renderActivity(connected: boolean): Promise<void> {
  $('#activity').classList.toggle('hidden', !connected);
  if (!connected) return;
  const log = await getAudit();
  const ul = $('#activity-list') as HTMLUListElement;
  ul.innerHTML = '';
  const recent = log.slice(-4).reverse();
  if (recent.length === 0) {
    ul.innerHTML = '<li class="muted small">No tool calls yet.</li>';
  } else {
    const now = Date.now();
    for (const e of recent) {
      const li = document.createElement('li');
      const mark = document.createElement('span');
      mark.className = e.ok ? 'ok' : 'fail';
      mark.textContent = e.ok ? '✓' : '✕';
      const tool = document.createElement('span');
      tool.className = 'act-tool';
      tool.textContent = e.tool;
      const time = document.createElement('span');
      time.className = 'act-time muted';
      time.textContent = formatRelativeTime(e.ts, now);
      li.append(mark, tool, time);
      ul.appendChild(li);
    }
  }
  const lastErr = [...log].reverse().find((e) => !e.ok && !!e.error);
  ($('#activity-error') as HTMLElement).textContent = lastErr
    ? `last error · ${lastErr.tool}: ${lastErr.error}`
    : '';
}

// -------------------------------------------------------------------------
// Current-tab widget — shows the active tab's domain and lets the user
// add it to the allowlist with one click. Hidden when the active tab is
// chrome:// / file:// / extension page (nothing to allowlist).
// -------------------------------------------------------------------------

async function getActiveTabHost(): Promise<string | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return extractHostname(tabs[0]?.url);
  } catch {
    return null;
  }
}

async function renderCurrentTab(connected: boolean): Promise<void> {
  const widget = $('#current-tab');
  if (!connected) {
    widget.classList.add('hidden');
    return;
  }
  const host = await getActiveTabHost();
  if (!host) {
    widget.classList.add('hidden');
    return;
  }
  widget.classList.remove('hidden');
  ($('#ct-host') as HTMLElement).textContent = host;

  const list = await getAllowlist();
  const match = matchAllowlist(`https://${host}/`, list);
  const stateEl = $('#ct-state');
  const addBtn = $('#ct-add') as HTMLButtonElement;
  if (match.matched) {
    stateEl.className = 'ct-state ok';
    stateEl.textContent = '✓ allowed';
    stateEl.title = `matches ${match.entry?.pattern ?? ''}`;
    addBtn.classList.add('hidden');
  } else {
    stateEl.className = 'ct-state miss';
    stateEl.textContent = '✕ not allowed';
    stateEl.title = '';
    addBtn.classList.remove('hidden');
    addBtn.textContent = '+ Allow this site';
    addBtn.onclick = async () => {
      // Re-fetch fresh — the list rendered into `match` above may be stale
      // by now (context menu, another popup) and we'd otherwise stomp on
      // concurrent edits.
      // Through the SAME gate as the Allowlist tab's Add field. This path used
      // to write the host unvalidated, so the two add paths disagreed about what
      // a legal entry is — any hardening of `validatePattern` was one click away
      // from being irrelevant.
      const shapeError = validatePattern(host);
      if (shapeError) {
        flash('#status-flash', shapeError, 'err');
        return;
      }
      const cur = await getAllowlist();
      if (cur.some((e) => e.pattern === host)) return; // already added — no-op
      const next: AllowEntry[] = [
        ...cur,
        { pattern: host, allowEvaluate: false, addedAt: Date.now() },
      ];
      await setAllowlist(next);
      flash('#status-flash', `added ${host}`);
      // storage.onChanged will fire and re-render; this is a belt-and-
      // braces refresh in case the listener is throttled. Use the live
      // flag, not the captured one — connection state may have changed
      // between render and click.
      await renderCurrentTab(liveConnected);
    };
  }
}

// Cached "is the bridge live right now" — set on every refreshStatus and
// consumed by the storage.onChanged listener, which doesn't otherwise know
// whether to show/hide the connected-only widgets when re-rendering on
// allowlist/audit writes.
let liveConnected = false;

// Whether we've already kicked an immediate reconnect for the current
// disconnected episode. Reset once we see a live connection, so a drop while
// the popup stays open re-kicks once but a daemon that's simply down isn't
// hammered every poll (the backoff handles the retries between kicks).
let kickedReconnect = false;

async function refreshStatus(): Promise<void> {
  const [resp, settings] = await Promise.all([
    send<{ ok: boolean; status: Status }>({ type: 'GET_STATUS' }),
    getSettings(),
  ]);
  const status = resp?.status;
  if (!status) return;

  liveConnected = status.state === 'connected' && !settings.paused;

  // Opening the popup shouldn't sit through the reconnect backoff when the
  // daemon is reachable again — fire an immediate attempt. RECONNECT is a
  // no-op while paused / unpaired / already connected, so this is safe. The
  // once-per-episode latch (nextReconnectKick) keeps the 2s poll from hammering
  // a daemon that is simply down.
  const kick = nextReconnectKick(status.state, settings.paused, kickedReconnect);
  kickedReconnect = kick.kicked;
  if (kick.kick) void send({ type: 'RECONNECT' });

  setView(status.state);
  renderBadge(status.state, settings.paused);

  if (status.state === 'no_secret') {
    const pairUrl = $('#pair-url') as HTMLInputElement;
    if (!pairUrl.value) pairUrl.value = settings.serverUrl || DEFAULT_SERVER_URL;
    return;
  }

  renderStatusCard(status, settings.paused);
  await renderSummary(liveConnected);
  await renderActivity(liveConnected);
  await renderCurrentTab(liveConnected);
  // Keep the Advanced URL field in sync (only when closed — don't clobber
  // typing).
  const adv = $('#status-advanced') as HTMLDetailsElement;
  if (!adv.open) {
    ($('#settings-url') as HTMLInputElement).value = settings.serverUrl;
  }
}

// -------------------------------------------------------------------------
// Onboarding / pairing
// -------------------------------------------------------------------------

let detectedSecret: string | null = null;

function updatePairDetection(): void {
  const text = ($('#pair-secret') as HTMLTextAreaElement).value;
  const detect = $('#pair-detect');
  const submit = $('#pair-submit') as HTMLButtonElement;

  const d = classifySecretInput(text);
  switch (d.kind) {
    case 'empty':
      detect.textContent = '';
      detect.className = 'detect';
      detectedSecret = null;
      submit.disabled = true;
      return;
    case 'none':
      detect.textContent = '⚠ no valid secret found in pasted text';
      detect.className = 'detect warn';
      detectedSecret = null;
      submit.disabled = true;
      return;
    case 'ok':
      detect.textContent = `✓ secret detected (${d.bytes} bytes)`;
      detect.className = 'detect ok';
      detectedSecret = d.token;
      submit.disabled = false;
      return;
    case 'wrong_length':
      // Plausible base64, but not the daemon's 32 bytes — almost always a
      // truncated paste. Flag it now, but still let the user try (heuristic,
      // not a hard gate) rather than surfacing an opaque mac mismatch later.
      detect.textContent =
        `⚠ secret is ${d.bytes} bytes — the daemon's is ${EXPECTED_SECRET_BYTES}; ` +
        `did you copy the whole line?`;
      detect.className = 'detect warn';
      detectedSecret = d.token;
      submit.disabled = false;
      return;
  }
}

$('#pair-secret').addEventListener('input', updatePairDetection);

// Cmd/Ctrl+Enter inside the textarea submits — Enter alone needs to keep
// inserting newlines because banner pastes are multi-line.
$('#pair-secret').addEventListener('keydown', (e) => {
  const ev = e as KeyboardEvent;
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    ($('#pair-submit') as HTMLButtonElement).click();
  }
});

async function submitPairing(): Promise<void> {
  const errEl = $('#onboard-error') as HTMLElement;
  errEl.textContent = '';
  if (!detectedSecret) {
    errEl.textContent = 'paste a secret first';
    return;
  }
  const url = ($('#pair-url') as HTMLInputElement).value.trim() || undefined;
  const resp = await send<{ ok: boolean; error?: string }>({
    type: 'PAIR',
    secret: detectedSecret,
    serverUrl: url,
  });
  if (!resp.ok) {
    errEl.textContent = resp.error || 'pair failed';
    return;
  }
  ($('#pair-secret') as HTMLTextAreaElement).value = '';
  updatePairDetection();
  await refreshStatus();
}

$('#pair-submit').addEventListener('click', () => void submitPairing());

// -------------------------------------------------------------------------
// Status-tab action buttons
// -------------------------------------------------------------------------

$('#pause-btn').addEventListener('click', async () => {
  await send({ type: 'PAUSE' });
  await refreshStatus();
});
$('#reconnect-btn').addEventListener('click', async () => {
  await send({ type: 'RECONNECT' });
  await refreshStatus();
});
$('#unpair-btn').addEventListener('click', async () => {
  if (!confirm('Forget the daemon secret and disconnect?')) return;
  await send({ type: 'UNPAIR' });
  await refreshStatus();
});
$('#resume-btn').addEventListener('click', async () => {
  await send({ type: 'RESUME' });
  await refreshStatus();
});

// -------------------------------------------------------------------------
// Status Settings (toggles) + Advanced (daemon URL, tools list)
// -------------------------------------------------------------------------

$('#status-settings').addEventListener('toggle', async () => {
  const d = $('#status-settings') as HTMLDetailsElement;
  if (!d.open) return;
  const s = await getSettings();
  ($('#keep-awake') as HTMLInputElement).checked = s.keepAwake;
  ($('#capture-console') as HTMLInputElement).checked = s.captureConsole;
  ($('#capture-network') as HTMLInputElement).checked = s.captureNetwork;
  ($('#handle-dialogs') as HTMLInputElement).checked = s.handleDialogs;
  ($('#close-agent-tabs') as HTMLInputElement).checked = s.closeAgentTabsOnDisconnect;
});

$('#status-advanced').addEventListener('toggle', async () => {
  const adv = $('#status-advanced') as HTMLDetailsElement;
  if (!adv.open) return;
  const [s, tools] = await Promise.all([
    getSettings(),
    send<{ ok: boolean; tools: string[] }>({ type: 'LIST_TOOLS' }),
  ]);
  ($('#settings-url') as HTMLInputElement).value = s.serverUrl;
  const ul = $('#tool-list') as HTMLUListElement;
  ul.innerHTML = '';
  if (tools?.tools) {
    ($('#tool-count') as HTMLElement).textContent = String(tools.tools.length);
    for (const t of tools.tools) {
      const li = document.createElement('li');
      li.textContent = t;
      ul.appendChild(li);
    }
  }
});

$('#activity-refresh').addEventListener('click', () => void renderActivity(liveConnected));

$('#keep-awake').addEventListener('change', async () => {
  const on = ($('#keep-awake') as HTMLInputElement).checked;
  await setSettings({ keepAwake: on });
  // Turning it ON takes effect on the next tool call (keepAwake is re-read per
  // attach). Turning it OFF must take effect NOW, on every attached tab: the
  // attach path only reaches a tab when something drives it again, so an idle
  // tab would otherwise keep reporting itself focused indefinitely.
  if (!on) await send({ type: 'KEEP_AWAKE_OFF' });
});

// -------------------------------------------------------------------------
// Agent tabs — what the sessions left in this browser
// -------------------------------------------------------------------------

async function renderAgentTabs(): Promise<void> {
  const resp = await send<{ ok: boolean; tabs: AgentTabRow[] }>({ type: 'AGENT_TABS' });
  const rows = resp?.tabs ?? [];
  ($('#agent-tab-count') as HTMLElement).textContent = String(rows.length);
  const ul = $('#agent-tab-list') as HTMLUListElement;
  ul.innerHTML = '';
  if (rows.length === 0) {
    ul.innerHTML = '<li class="muted small">No agent tabs open.</li>';
    return;
  }
  for (const row of rows) {
    const li = document.createElement('li');
    const who = row.session ? `[${row.session}] ` : '';
    li.textContent = `${who}${row.title || row.url}`;
    li.title = row.url;
    ul.appendChild(li);
  }
}

$('#status-agents').addEventListener('toggle', async () => {
  if (!($('#status-agents') as HTMLDetailsElement).open) return;
  await renderAgentTabs();
});

$('#agent-tabs-close').addEventListener('click', async () => {
  const resp = await send<{ ok: boolean; closed: number }>({ type: 'CLOSE_AGENT_TABS' });
  flash('#status-flash', `closed ${resp?.closed ?? 0} agent tab(s)`);
  await renderAgentTabs();
});

$('#capture-console').addEventListener('change', async () => {
  // Takes effect on the next tool call — captureConsole is re-read per attach,
  // which lazily issues Runtime.enable for the driven tab when on.
  await setSettings({ captureConsole: ($('#capture-console') as HTMLInputElement).checked });
});

$('#capture-network').addEventListener('change', async () => {
  // Takes effect on the next tool call — captureNetwork is re-read per attach,
  // which lazily issues Network.enable for the driven tab when on.
  await setSettings({ captureNetwork: ($('#capture-network') as HTMLInputElement).checked });
});

$('#handle-dialogs').addEventListener('change', async () => {
  // Takes effect on the next tool call — handleDialogs is re-read per attach,
  // which lazily issues Page.enable for the driven tab when on.
  await setSettings({ handleDialogs: ($('#handle-dialogs') as HTMLInputElement).checked });
});

$('#close-agent-tabs').addEventListener('change', async () => {
  // Read at release time, so this takes effect for the next session that
  // disconnects — no need to restart anything.
  await setSettings({
    closeAgentTabsOnDisconnect: ($('#close-agent-tabs') as HTMLInputElement).checked,
  });
});

$('#settings-save').addEventListener('click', async () => {
  const url = ($('#settings-url') as HTMLInputElement).value.trim();
  if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
    flash('#status-flash', 'URL must start with ws:// or wss://', 'err');
    return;
  }
  await setSettings({ serverUrl: url });
  await send({ type: 'RECONNECT' });
  flash('#status-flash', 'saved — reconnecting');
  await refreshStatus();
});

// -------------------------------------------------------------------------
// Allowlist tab
// -------------------------------------------------------------------------

async function renderAllowlist(): Promise<void> {
  const list = await getAllowlist();
  const ul = $('#allow-list') as HTMLUListElement;
  ul.innerHTML = '';
  if (list.length === 0) {
    ul.innerHTML = '<li class="muted small">Empty — no domains allowed yet.</li>';
    return;
  }
  for (const entry of list) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="pattern"></span>
      <span class="eval-tag"></span>
      <button class="remove" title="remove">✕</button>
    `;
    (li.querySelector('.pattern') as HTMLElement).textContent = entry.pattern;
    if (entry.allowEvaluate) {
      (li.querySelector('.eval-tag') as HTMLElement).textContent = 'eval';
    }
    li.querySelector('.remove')?.addEventListener('click', async () => {
      const next = (await getAllowlist()).filter((e) => e.pattern !== entry.pattern);
      await setAllowlist(next);
      flash('#allow-flash', `removed ${entry.pattern}`);
      renderAllowlist();
    });
    ul.appendChild(li);
  }
}

async function submitFullAdd(): Promise<void> {
  const input = $('#allow-input') as HTMLInputElement;
  const evalCk = $('#allow-eval') as HTMLInputElement;
  const errEl = $('#allow-error') as HTMLElement;
  const pattern = normalizePattern(input.value);
  const err = validatePattern(pattern);
  if (err) {
    errEl.textContent = err;
    return;
  }
  errEl.textContent = '';
  const list = await getAllowlist();
  if (list.some((e) => e.pattern === pattern)) {
    errEl.textContent = 'pattern already in the list';
    return;
  }
  list.push({ pattern, allowEvaluate: evalCk.checked, addedAt: Date.now() });
  await setAllowlist(list);
  input.value = '';
  evalCk.checked = false;
  flash('#allow-flash', `added ${pattern}`);
  renderAllowlist();
}

$('#allow-add').addEventListener('click', () => void submitFullAdd());
$('#allow-input').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') {
    e.preventDefault();
    void submitFullAdd();
  }
});

// -------------------------------------------------------------------------
// Audit tab
// -------------------------------------------------------------------------

function renderAuditEntry(entry: AuditEntry, now: number): HTMLLIElement {
  const li = document.createElement('li');
  const head = document.createElement('div');
  head.className = 'audit-head';
  const okSpan = document.createElement('span');
  okSpan.className = entry.ok ? 'ok' : 'fail';
  okSpan.textContent = entry.ok ? '●' : '○';
  const tool = document.createElement('span');
  tool.className = 'audit-tool';
  tool.textContent = entry.tool;
  const time = document.createElement('span');
  time.className = 'audit-time';
  time.textContent = formatRelativeTime(entry.ts, now);
  time.title = new Date(entry.ts).toLocaleString();
  head.append(okSpan, tool, time);
  // Which session did this. With several agents driving one browser, and their
  // calls now genuinely interleaving, the log is otherwise an unattributable
  // stream — there isn't even the weak "this burst was probably one session"
  // proxy that strict serialisation used to give.
  if (entry.client) {
    const who = document.createElement('span');
    who.className = 'audit-client';
    who.textContent = entry.client;
    who.title = `session: ${entry.client}`;
    head.appendChild(who);
  }
  li.appendChild(head);
  if (entry.url) {
    const u = document.createElement('div');
    u.className = 'audit-url';
    u.textContent = entry.url;
    li.appendChild(u);
  }
  if (entry.error) {
    const e = document.createElement('div');
    e.className = 'audit-err';
    e.textContent = entry.error;
    li.appendChild(e);
  }
  return li;
}

async function renderAudit(): Promise<void> {
  const log = await getAudit();
  const ul = $('#audit-list') as HTMLUListElement;
  ul.innerHTML = '';
  const summary = $('#audit-summary');
  const filterInput = $('#audit-filter') as HTMLInputElement;
  const query = filterInput.value;

  if (log.length === 0) {
    ul.innerHTML = '<li class="muted small">No events yet.</li>';
    summary.textContent = '';
    return;
  }

  const total = log.length;
  const errors = log.filter((e) => !e.ok).length;
  summary.textContent = `${total} event${total > 1 ? 's' : ''}`;
  if (errors > 0) {
    const errSpan = document.createElement('span');
    errSpan.className = 'err';
    errSpan.textContent = `, ${errors} error${errors > 1 ? 's' : ''}`;
    summary.appendChild(errSpan);
  }

  const now = Date.now();
  let shown = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    if (!matchesAuditFilter(log[i], query)) continue;
    ul.appendChild(renderAuditEntry(log[i], now));
    shown++;
  }
  if (shown === 0) {
    const li = document.createElement('li');
    li.className = 'muted small';
    li.textContent = query ? `No events match "${query}".` : 'No events yet.';
    ul.appendChild(li);
  }
}

$('#audit-refresh').addEventListener('click', renderAudit);
$('#audit-filter').addEventListener('input', renderAudit);
$('#audit-clear').addEventListener('click', async () => {
  if (!confirm('Clear the audit log?')) return;
  await clearAudit();
  renderAudit();
});
$('#audit-export').addEventListener('click', async () => {
  const log = await getAudit();
  const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sallyport-audit-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// -------------------------------------------------------------------------
// Wire up
// -------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: { type: string; status?: Status }) => {
  if (msg.type === 'STATUS') {
    void refreshStatus();
  }
});

// Live-refresh when the underlying storage changes — happens when the
// service worker writes an audit entry, when the context menu adds a
// host, or when another popup tab edits settings. Cheap enough that we
// just re-render whatever panel the user is looking at; the activity
// rate is human-scale, not flooding.
function activeTabId(): string | null {
  return document.querySelector('.tab.active')?.getAttribute('data-tab') ?? null;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // Audit grows on every tool call — keep the list and the summary card
  // in sync without forcing the user to click Refresh.
  if (changes.sallyport_audit) {
    if (activeTabId() === 'audit') void renderAudit();
    // Status summary ("calls (1h)") + the recent-activity strip both read the
    // audit log — keep them fresh as calls land.
    if (activeTabId() === 'status') {
      void renderSummary(liveConnected);
      void renderActivity(liveConnected);
    }
  }
  if (changes.sallyport_allowlist) {
    if (activeTabId() === 'allowlist') void renderAllowlist();
    if (activeTabId() === 'status') {
      void renderSummary(liveConnected);
      void renderCurrentTab(liveConnected);
    }
  }
  if (changes.sallyport_settings) void refreshStatus();
});

void refreshStatus();

// The service worker pushes a STATUS message on every state change, but if
// Chrome suspended it there are no pushes — poll while the popup is open so a
// stale "connected" can never linger on screen and the reconnect kick above
// keeps the connection honest. Cheap: the popup is short-lived and the call
// is a single message round-trip.
setInterval(() => void refreshStatus(), 2000);
