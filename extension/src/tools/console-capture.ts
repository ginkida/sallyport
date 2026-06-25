/** Per-tab capture of page console errors/warnings + uncaught exceptions.
 *
 * Closes a real perception gap: a click can succeed, a snapshot can succeed,
 * yet the page silently threw a JS error and is wedged — with zero signal.
 * `console_tail` (console.ts) reads this buffer so an agent can SEE that the
 * SPA's submit handler threw instead of looping a form that will never advance.
 *
 * Security shape — this is the FIRST `chrome.debugger.onEvent` surface in the
 * codebase, so it is deliberately conservative:
 *  - OPT-IN: capture only runs when the popup setting `captureConsole` is on
 *    (default off); `ensureConsoleCapture` is called from `attach()` ONLY then,
 *    so the unconditional attach hot-path never widens the CDP footprint (#4 is
 *    honoured — pure event SUBSCRIPTION, no `Runtime.evaluate`, no interpolation);
 *  - BOUNDED: a per-tab ring of ≤50 entries × ≤1024-char text (#6 fine);
 *  - PER-TAB + CLEARED on `tabs.onRemoved`/`debugger.onDetach` (#7 untouched —
 *    no refs);
 *  - ORIGIN-TAGGED: each entry records the producing script's origin (from the
 *    event stack trace, NOT the tab's current URL — a tab can navigate
 *    cross-origin while buffering), and `console_tail` filters reads to the
 *    allowlist (#3), fail-closed on an unknown origin.
 *
 * The pure helpers (origin extraction, entry shaping, ring trim, origin filter)
 * are `chrome.*`-free so vitest drives them directly; the thin event wiring is
 * covered on the wire by the e2e harness — the same split the rest of the
 * tools use.
 */

import { BridgeError } from './errors.js';

export type ConsoleLevel = 'error' | 'warning';

export interface ConsoleEntry {
  ts: number;
  level: ConsoleLevel;
  text: string;
  /** Origin of the script that produced the entry, or null when it could not
   * be determined (opaque/non-http) — null entries are dropped at read time. */
  origin: string | null;
}

export const CONSOLE_MAX_ENTRIES = 50;
export const CONSOLE_MAX_TEXT = 1024;
const DEFAULT_CONSOLE_LIMIT = 50;

// Which `Runtime.consoleAPICalled` types we keep. console.log/info/debug are
// noise for failure diagnosis; we want the error-shaped ones (assert maps to
// error). Uncaught exceptions arrive as a separate event and are always kept.
const KEPT_CONSOLE_TYPES = new Set(['error', 'warning', 'assert']);

/** Extract the origin from a stack-frame URL. Returns null on anything that
 * isn't a real http(s)/extension origin (empty, malformed, or an opaque
 * `null`-origin scheme like data:/about:) — callers treat null as "unknown"
 * and drop it. Pure. */
export function originFromStackUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  try {
    const o = new URL(url).origin;
    return o && o !== 'null' ? o : null;
  } catch {
    return null;
  }
}

interface RemoteObjectLike {
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  type?: string;
}

interface StackTraceLike {
  callFrames?: Array<{ url?: string }>;
}

export interface ConsoleEventParams {
  type?: string;
  args?: RemoteObjectLike[];
  stackTrace?: StackTraceLike;
  exceptionDetails?: {
    text?: string;
    url?: string;
    exception?: { description?: string };
    stackTrace?: StackTraceLike;
  };
}

function topFrameUrl(stack: StackTraceLike | undefined): string | undefined {
  return stack?.callFrames?.[0]?.url;
}

function clip(s: string): string {
  return s.length > CONSOLE_MAX_TEXT ? s.slice(0, CONSOLE_MAX_TEXT) : s;
}

/** A console arg (CDP RemoteObject) → a flat display string. No nested
 * traversal: we only want a readable line, never to pull structured page data
 * out of the object graph. Pure. */
function remoteObjectToText(arg: RemoteObjectLike): string {
  if (arg.value !== undefined && arg.value !== null) return String(arg.value);
  if (typeof arg.unserializableValue === 'string') return arg.unserializableValue;
  if (typeof arg.description === 'string') return arg.description;
  return arg.type ?? '';
}

/** Map a CDP debugger event to a ConsoleEntry, or null when it is not one we
 * keep (e.g. a console.log). Pure, so the level selection / text capping /
 * origin extraction are unit-testable without chrome. */
export function shapeConsoleEntry(
  method: string,
  params: ConsoleEventParams,
  ts: number,
): ConsoleEntry | null {
  if (method === 'Runtime.exceptionThrown') {
    const det = params.exceptionDetails ?? {};
    const text = clip(String(det.exception?.description ?? det.text ?? 'uncaught exception'));
    const origin = originFromStackUrl(topFrameUrl(det.stackTrace) ?? det.url);
    return { ts, level: 'error', text, origin };
  }
  if (method === 'Runtime.consoleAPICalled') {
    const type = params.type;
    if (typeof type !== 'string' || !KEPT_CONSOLE_TYPES.has(type)) return null;
    const level: ConsoleLevel = type === 'warning' ? 'warning' : 'error';
    const args = Array.isArray(params.args) ? params.args : [];
    const text = clip(args.map(remoteObjectToText).join(' ').trim());
    const origin = originFromStackUrl(topFrameUrl(params.stackTrace));
    return { ts, level, text, origin };
  }
  return null;
}

/** Append to a ring buffer, evicting the oldest beyond `max`. Pure. */
export function pushCapped<T>(buf: T[], entry: T, max: number): T[] {
  buf.push(entry);
  while (buf.length > max) buf.shift();
  return buf;
}

/** Keep only entries from an allowed origin. Fail-closed: an entry whose origin
 * is null (couldn't be determined) is DROPPED, never returned. Pure (the
 * allowlist check is injected). */
export function filterByAllowedOrigins(
  entries: ConsoleEntry[],
  isAllowed: (origin: string) => boolean,
): ConsoleEntry[] {
  return entries.filter((e) => e.origin !== null && isAllowed(e.origin));
}

/** Parse `console_tail`'s `limit` (default 50, capped at the ring size). Pure. */
export function parseConsoleLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_CONSOLE_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new BridgeError('bad_args', 'console_tail: limit must be a positive integer');
  }
  return Math.min(n, CONSOLE_MAX_ENTRIES);
}

// --- chrome-bound state + wiring -------------------------------------------

const buffers = new Map<number, ConsoleEntry[]>();
const enabledTabs = new Set<number>();

function onDebuggerEvent(source: { tabId?: number }, method: string, params?: unknown): void {
  if (source.tabId === undefined) return;
  if (method !== 'Runtime.consoleAPICalled' && method !== 'Runtime.exceptionThrown') return;
  const entry = shapeConsoleEntry(method, (params ?? {}) as ConsoleEventParams, Date.now());
  if (!entry) return;
  const buf = buffers.get(source.tabId) ?? [];
  pushCapped(buf, entry, CONSOLE_MAX_ENTRIES);
  buffers.set(source.tabId, buf);
}

// Registered once. Guarded so importing this module in vitest (no chrome) just
// loads the pure helpers without demanding the API.
if (typeof chrome !== 'undefined' && chrome.debugger?.onEvent) {
  chrome.debugger.onEvent.addListener(onDebuggerEvent);
}

/** Idempotently turn on console capture for a tab. Issues `Runtime.enable`
 * (which makes the consoleAPICalled / exceptionThrown events fire) at most once
 * per tab. Called from `attach()` ONLY when the captureConsole setting is on.
 * Uses `chrome.debugger.sendCommand` directly to avoid an import cycle with
 * cdp.ts. Best-effort: a failure drops the flag so a later attach retries and
 * never breaks the tool call. */
export async function ensureConsoleCapture(tabId: number): Promise<void> {
  if (enabledTabs.has(tabId)) return;
  enabledTabs.add(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
  } catch {
    enabledTabs.delete(tabId);
  }
}

/** Drop a tab's buffer + enabled flag — wired into tabs.onRemoved /
 * debugger.onDetach (cdp.ts) so capture state never outlives the tab. */
export function clearConsole(tabId: number): void {
  buffers.delete(tabId);
  enabledTabs.delete(tabId);
}

/** Snapshot a tab's captured entries (a copy, oldest→newest). */
export function readConsole(tabId: number): ConsoleEntry[] {
  return [...(buffers.get(tabId) ?? [])];
}
