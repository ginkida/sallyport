// Persistent state for the extension. Two namespaces:
//   chrome.storage.local  — secret + settings + audit log (sync across SW restarts)
//   chrome.storage.session — ephemeral runtime state (cleared when browser quits)

export type AllowEntry = {
  pattern: string;
  allowEvaluate: boolean;
  addedAt: number;
};

export type AuditEntry = {
  ts: number;
  tool: string;
  tabId?: number;
  url?: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
};

export type Settings = {
  serverUrl: string;
  paused: boolean;
  /** Keep driven tabs unfrozen + focus-emulated while the debugger is
   * attached (cdp.ts:keepAwake). Default on; the page then behaves as if
   * active (e.g. Telegram sends read receipts during automation). */
  keepAwake: boolean;
  /** Capture page console errors/warnings + uncaught exceptions on driven
   * tabs (console-capture.ts), readable via the `console_tail` tool. Default
   * OFF — it lazily enables CDP `Runtime.enable` (widening the observable CDP
   * footprint), so it is opt-in. */
  captureConsole: boolean;
  /** Capture XHR/fetch response bodies on driven tabs (network-capture.ts),
   * readable via the `network_tail` tool — the data behind canvas dashboards.
   * Default OFF — it lazily enables CDP `Network.enable` and reads response
   * bodies (widening the observable CDP footprint), so it is opt-in. */
  captureNetwork: boolean;
  /** Auto-answer native JS dialogs (alert/confirm/prompt/beforeunload) on
   * driven tabs (dialog-capture.ts) — an open dialog freezes the page's JS
   * and no tool can click it — steerable via the `handle_dialog` tool.
   * Default OFF — it lazily enables CDP `Page.enable` (widening the
   * observable CDP footprint) and answers dialogs the human might have
   * wanted to see, so it is opt-in. */
  handleDialogs: boolean;
};

export const DEFAULT_SERVER_URL = 'ws://127.0.0.1:10086/ws';
export const AUDIT_LIMIT = 500;
/** Per-string cap inside audit entries. chrome.storage.local has a 10 MiB
 * quota total; without this an agent that uploads a 5 MiB base64 blob via
 * save_to_file would blow it out in a few calls and writes start failing
 * silently. 1 KiB keeps args readable for debugging without ever
 * approaching the limit. */
export const MAX_AUDIT_STRING = 1024;
/** Total array-elements + object-keys a single audit value may expand while
 * being truncated — one running budget shared across the WHOLE nested
 * structure, not a per-level cap (an independent width/depth pair still
 * multiplies out: e.g. width 50 at depth 4 is 6M+ leaves). `MAX_AUDIT_STRING`
 * alone doesn't bound fan-out — an args object with many array elements (or
 * deeply nested ones) can still serialise past the 10 MiB quota even with
 * every leaf string capped. 16 is far more than any real tool call's args
 * ever use; worst case (every visited item a max-length string, AND its key
 * if it's an object key) is ~32 KiB/entry, so `AUDIT_LIMIT` entries stay well
 * inside the quota. Object KEYS are truncated too (not just values), so an
 * args object with attacker/model-controlled property names can't blow past
 * the string-size bound via an oversized key. Recursion/output stop the
 * moment the budget is exhausted regardless of width. Enumeration COST is a
 * separate, only partially-addressed concern: a plain-object `for...in` pass
 * is O(width) in a JS engine no matter how early the loop body breaks — see
 * the comment in `truncateAuditValueBudgeted`'s object branch. */
export const MAX_AUDIT_ITEMS = 16;

const K = {
  secret: 'sallyport_secret_b64',
  allow: 'sallyport_allowlist',
  audit: 'sallyport_audit',
  settings: 'sallyport_settings',
} as const;

export async function getSecret(): Promise<string | null> {
  const out = await chrome.storage.local.get(K.secret);
  const v = out[K.secret];
  return typeof v === 'string' && v ? v : null;
}

export async function setSecret(b64: string): Promise<void> {
  await chrome.storage.local.set({ [K.secret]: b64 });
}

export async function clearSecret(): Promise<void> {
  await chrome.storage.local.remove(K.secret);
}

export async function getAllowlist(): Promise<AllowEntry[]> {
  const out = await chrome.storage.local.get(K.allow);
  const v = out[K.allow];
  return Array.isArray(v) ? (v as AllowEntry[]) : [];
}

export async function setAllowlist(list: AllowEntry[]): Promise<void> {
  await chrome.storage.local.set({ [K.allow]: list });
}

export async function getSettings(): Promise<Settings> {
  const out = await chrome.storage.local.get(K.settings);
  const v = out[K.settings] as Partial<Settings> | undefined;
  return {
    serverUrl: v?.serverUrl || DEFAULT_SERVER_URL,
    paused: !!v?.paused,
    keepAwake: v?.keepAwake !== false, // default on
    captureConsole: !!v?.captureConsole, // default off (opt-in)
    captureNetwork: !!v?.captureNetwork, // default off (opt-in)
    handleDialogs: !!v?.handleDialogs, // default off (opt-in)
  };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [K.settings]: next });
  return next;
}

// The arg that carries typed text, per keystroke/value tool. When such a
// tool runs with allowPassword=true the agent is deliberately typing into a
// password field, so that value is a credential and must NOT be written
// verbatim to the persisted (and popup-exportable) audit log.
const TYPED_VALUE_ARG: Record<string, string> = {
  fill: 'value',
  key_type: 'text',
  send_keys: 'keys',
};

/** Redact the typed-text arg so a credential never lands in the persisted
 * (popup-exportable) audit log. Redacts when the call targets a password
 * field — either `allowPassword=true` (success path) or `force` (the call
 * was rejected with `password_field`, so the arg was an attempted secret).
 *
 * The value is coerced with `String(...)` before measuring, exactly like the
 * tools do (`fill`/`key_type`/`send_keys` `String()`-coerce before typing),
 * so a numeric PIN or array credential is redacted too — not waved through
 * just because it wasn't already a string. Leaves args untouched for normal
 * (non-password) fields so the audit trail stays useful. Pure / tested. */
export function redactAuditArgs(
  tool: string,
  args: Record<string, unknown>,
  opts?: { force?: boolean },
): Record<string, unknown> {
  const key = TYPED_VALUE_ARG[tool];
  if (!key) return args;
  if (!opts?.force && args.allowPassword !== true) return args;
  if (args[key] === undefined) return args;
  return { ...args, [key]: `<redacted password, ${String(args[key]).length} chars>` };
}

/** Trim a single string for safe audit storage. Pure / tested. */
export function truncateAuditString(s: string): string {
  if (s.length <= MAX_AUDIT_STRING) return s;
  return s.slice(0, MAX_AUDIT_STRING) + `…<truncated, ${s.length} chars total>`;
}

/** Recursively trim every string inside an audit value, AND bound total
 * array-elements/object-keys visited to `MAX_AUDIT_ITEMS` (shared across the
 * whole call via `budget`) so a wide-or-deep args object can't fan out past
 * the storage quota regardless of shape. Other primitives pass through.
 * Pure / tested. */
function truncateAuditValueBudgeted(v: unknown, budget: { left: number }): unknown {
  if (typeof v === 'string') return truncateAuditString(v);
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const item of v) {
      if (budget.left <= 0) {
        out.push(`…<${v.length - out.length} more>`);
        break;
      }
      budget.left--;
      out.push(truncateAuditValueBudgeted(item, budget));
    }
    return out;
  }
  if (v && typeof v === 'object') {
    // `for...in` + a break the instant the budget is exhausted, NOT
    // `Object.entries(v)` up front — entries() eagerly materialises an array
    // of EVERY own key/value pair (double the allocation: keys AND values)
    // before a single one is visited or recursed into, so a wide object
    // (e.g. attacker-controlled header names via fetch_in_page) paid that
    // allocation cost regardless of the budget. `for...in` avoids building
    // that intermediate array and never recurses past the budget, which
    // measurably cuts the constant factor (~3x in a 200k-key benchmark) —
    // but is NOT a full fix: V8 must still enumerate a dictionary-mode
    // object's own keys in a single pass to iterate it at all, so this
    // remains O(width) in the object's size, not O(budget). There's no
    // standard JS API for partial/lazy enumeration of a plain object's own
    // keys. In practice the object already exists in memory (something
    // upstream already paid to construct/parse it), so this bounds the
    // *incremental* overhead this function adds, not the pre-existing cost
    // of holding a wide object at all. We deliberately do NOT report an
    // exact "N more keys" count here (unlike the array branch, whose
    // `v.length` is a free O(1) property) — computing one would require
    // another full pass for no functional benefit.
    const out: Record<string, unknown> = {};
    let truncated = false;
    for (const k in v as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      if (budget.left <= 0) {
        truncated = true;
        break;
      }
      budget.left--;
      // Keys can be attacker/model-controlled too (e.g. header names) — cap
      // them the same as string values, or one oversized key alone could
      // blow past the storage quota regardless of MAX_AUDIT_ITEMS.
      const safeKey = truncateAuditString(k);
      out[safeKey] = truncateAuditValueBudgeted((v as Record<string, unknown>)[k], budget);
    }
    if (truncated) out['…'] = '<more keys omitted, audit budget exhausted>';
    return out;
  }
  return v;
}

export function truncateAuditValue(v: unknown): unknown {
  return truncateAuditValueBudgeted(v, { left: MAX_AUDIT_ITEMS });
}

export async function appendAudit(entry: AuditEntry): Promise<void> {
  const safe: AuditEntry = {
    ...entry,
    // Pass the WHOLE args object through the budgeted truncator (not a
    // per-key map) so the top-level key count shares the same budget as
    // everything nested under it — mapping per-key would give each value
    // its own fresh MAX_AUDIT_ITEMS budget, leaving the number of top-level
    // keys itself unbounded (a wide, flat args object would still fan out).
    args: truncateAuditValue(entry.args) as Record<string, unknown>,
  };
  if (entry.error !== undefined) safe.error = truncateAuditString(entry.error);

  const out = await chrome.storage.local.get(K.audit);
  const log = (Array.isArray(out[K.audit]) ? out[K.audit] : []) as AuditEntry[];
  log.push(safe);
  while (log.length > AUDIT_LIMIT) log.shift();
  await chrome.storage.local.set({ [K.audit]: log });
}

export async function getAudit(): Promise<AuditEntry[]> {
  const out = await chrome.storage.local.get(K.audit);
  return Array.isArray(out[K.audit]) ? (out[K.audit] as AuditEntry[]) : [];
}

export async function clearAudit(): Promise<void> {
  await chrome.storage.local.remove(K.audit);
}
