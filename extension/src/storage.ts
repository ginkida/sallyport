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
};

export const DEFAULT_SERVER_URL = 'ws://127.0.0.1:10086/ws';
export const AUDIT_LIMIT = 500;
/** Per-string cap inside audit entries. chrome.storage.local has a 10 MiB
 * quota total; without this an agent that uploads a 5 MiB base64 blob via
 * save_to_file would blow it out in a few calls and writes start failing
 * silently. 1 KiB keeps args readable for debugging without ever
 * approaching the limit. */
export const MAX_AUDIT_STRING = 1024;

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

/** Recursively trim every string inside an audit value. Other primitives
 * pass through. Pure / tested. */
export function truncateAuditValue(v: unknown): unknown {
  if (typeof v === 'string') return truncateAuditString(v);
  if (Array.isArray(v)) return v.map(truncateAuditValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = truncateAuditValue(val);
    return out;
  }
  return v;
}

export async function appendAudit(entry: AuditEntry): Promise<void> {
  const safe: AuditEntry = {
    ...entry,
    args: Object.fromEntries(
      Object.entries(entry.args).map(([k, v]) => [k, truncateAuditValue(v)]),
    ),
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
