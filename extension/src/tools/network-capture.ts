/** Per-tab capture of the page's XHR/fetch RESPONSE bodies — the DATA behind
 * canvas dashboards (and any SPA that renders from network JSON).
 *
 * Closes the perception gap canvas leaves: a chart drawn on <canvas> has no DOM
 * text to read, so snapshot/read_text find nothing and the only fallback is a
 * screenshot + vision — slow and imprecise. But the numbers ARE on the wire: the
 * chart library fetched them as JSON. `network_tail` (network.ts) reads this
 * buffer so an agent can pull the exact figures instead of eyeballing pixels
 * (then, if it wants the full untruncated payload, re-fetch that URL with
 * fetch_in_page).
 *
 * Security shape — a second `chrome.debugger.onEvent` surface (sibling of
 * console-capture.ts) and a heavier one (it reads response BODIES), so it keeps
 * the same conservative posture:
 *  - OPT-IN: only runs when the popup setting `captureNetwork` is on (default
 *    off); `ensureNetworkCapture` is called from `attach()` ONLY then, so the
 *    unconditional attach hot-path never issues `Network.enable` (#4 honoured —
 *    pure event SUBSCRIPTION + a fixed `Network.getResponseBody`, no
 *    `Runtime.evaluate`, no agent interpolation);
 *  - SCOPED to XHR/Fetch: image/font/media/script/stylesheet loads are ignored —
 *    only the API-call surface where dashboard data rides;
 *  - BODIES only for data content-types (json/text/xml/csv), each capped at
 *    NETWORK_MAX_BODY; binary/compressed bodies are skipped;
 *  - NO auth leak: request/response HEADERS are never captured (so no
 *    Authorization / Cookie / Set-Cookie), only method/url/status/contentType/
 *    size + body;
 *  - BOUNDED: a per-tab ring, capped pending metadata, and separate per-tab and
 *    global limits on body reads. Results have their own wire-byte budget (#6);
 *  - PER-TAB + CLEARED on `tabs.onRemoved`/`debugger.onDetach` (#7 untouched —
 *    no refs);
 *  - ORIGIN-TAGGED (response URL origin) + read-time filtered to the allowlist,
 *    fail-closed (#3): a dashboard whose data API is on another host requires
 *    THAT host in the allowlist too — the correct explicit-access posture.
 *
 * The pure helpers are `chrome.*`-free so vitest drives them directly; the thin
 * event wiring is covered on the wire by the e2e harness — the same split the
 * rest of the tools use.
 */

import { pushCapped } from './console-capture.js';
import { BridgeError } from './errors.js';
import { NetworkBodyCache, type CapturedBody } from './network-body-cache.js';

export interface NetworkEntry extends CapturedBody {
  ts: number;
  method: string;
  url: string;
  /** Set when `url` was clipped to NETWORK_MAX_URL (a page put a huge query
   * string on it). `origin` is still derived from the FULL url (invariant #3). */
  urlTruncated?: boolean;
  status: number;
  /** Resource type, lowercased — always 'xhr' or 'fetch' (nothing else is kept). */
  type: string;
  contentType: string;
  /** Bytes on the wire (encodedDataLength), best-effort. */
  size: number;
  /** Response URL origin, or null when it could not be determined — null entries
   * are dropped at read time (fail-closed). */
  origin: string | null;
}

export const NETWORK_MAX_ENTRIES = 100;
export const NETWORK_MAX_BODY = 256 * 1024;
// Total WIRE BYTES returned in ONE network_tail result — counted over the WHOLE
// serialised entry (metadata + body), not just the body: a page can put a
// multi-hundred-KB query string on a same-origin XHR, so N entries' urls alone
// can blow the 16 MiB frame cap with no bodies at all. Measured as UTF-8 length
// of the JSON-serialised form (see entryWireBytes) — NOT UTF-16 `.length`, which
// undercounts badly (a control char escapes to `\uXXXX` = 6 bytes, a CJK unit is
// 3 UTF-8 bytes), so a code-unit budget could pass a result that serialises past
// the cap and 1009-closes the WS. Entries past the budget (oldest first) drop
// their body to metadata (bodyOmitted); every controllable string field is
// independently clipped (url + origin to NETWORK_MAX_URL, method/contentType to
// NETWORK_MAX_META_FIELD) so even metadata-only entries stay small. 10 MiB leaves >=6 MiB
// headroom under MAX_FRAME_BYTES for the envelope and HMAC framing. A same-origin
// RPC report (e.g. Metrika's /i-proxy/ gateway with a signed per-session key)
// often can't be replayed with fetch_in_page, so the per-body cap is generous and
// it is the aggregate wire size that is bounded.
export const NETWORK_RESPONSE_BUDGET = 10 * 1024 * 1024;
// Retained-body cache (network-body-cache.ts) — in the SAME unit as the budget
// above (wire bytes, via bodyWireBytes) and DERIVED from it: a tab retains at
// most what one result can carry. That keeps the response budget the one
// authority on "how much body is there", and makes the cache purely the
// cross-TAB memory bound the per-tab ring never gave (N tabs × 100 entries ×
// 256 KiB was unbounded in N). Two caps in two units would let the cache
// silently starve the budget's own body-stripping path — it did, at 4 MiB
// UTF-16 — so this is one number, not two.
export const NETWORK_BODY_CACHE_PER_TAB = NETWORK_RESPONSE_BUDGET;
export const NETWORK_BODY_CACHE_TOTAL = 4 * NETWORK_RESPONSE_BUDGET;
// Body reads IN FLIGHT to Chrome: a concurrency limit, not admission control.
// Past it a read WAITS in a per-tab FIFO instead of being dropped — a dashboard
// fires a dozen widget XHRs whose loadingFinished events all land before the
// first getResponseBody round-trip returns, and dropping everything past the
// fourth lost exactly the bodies network_tail exists for (signed same-origin
// RPCs can't be re-fetched). The queue is bounded by the ring size, since an
// entry the ring has already evicted is never read; only an overflowing queue
// answers capture_busy.
export const NETWORK_MAX_BODY_READS_PER_TAB = 4;
export const NETWORK_MAX_BODY_READS = 32;
export const NETWORK_MAX_QUEUED_BODY_READS = NETWORK_MAX_ENTRIES;
// Per-entry URL cap. Real API urls are well under this; it exists only so a
// pathological giant query string can't dominate a result's wire size.
export const NETWORK_MAX_URL = 4 * 1024;
// Cap for the other page/server-controllable string fields (`method`,
// `contentType`). Real HTTP methods are a handful of chars and a Content-Type
// essence is short, so this never truncates a legitimate value — it exists only
// so a pathological `fetch(url,{method:'X'.repeat(...)})` or a server emitting a
// giant Content-Type can't blow the 16 MiB frame cap on the sibling path the url
// cap doesn't cover (round-4 caught this: url alone wasn't enough).
export const NETWORK_MAX_META_FIELD = 256;

const WIRE_ENCODER = new TextEncoder();

/** Wire cost of a captured body: the UTF-8 byte length of its JSON-serialised
 * form. Pure. */
export function bodyWireBytes(body: string): number {
  return WIRE_ENCODER.encode(JSON.stringify(body)).length;
}

/** Wire cost of a WHOLE serialised entry (metadata + body) — exactly what counts
 * against the 16 MiB frame cap once the tool result is stringified and sent.
 * Pure. */
export function entryWireBytes(entry: NetworkEntry): number {
  return WIRE_ENCODER.encode(JSON.stringify(entry)).length;
}

/** Clip a captured URL to NETWORK_MAX_URL, flagging truncation. Callers must take
 * `origin` from the UNCAPPED url first (invariant #3) — only the stored/filterable
 * url is trimmed. Pure. */
export function clipUrl(url: string, max = NETWORK_MAX_URL): { url: string; truncated: boolean } {
  if (url.length <= max) return { url, truncated: false };
  return { url: url.slice(0, max), truncated: true };
}
const DEFAULT_NETWORK_LIMIT = 20;
const NETWORK_MAX_PENDING = 512;

// Only the API-call surface — where canvas/SPA dashboards fetch their data.
const CAPTURED_RESOURCE_TYPES = new Set(['xhr', 'fetch']);

export interface NetworkMeta {
  ts: number;
  method: string;
  url: string;
  status: number;
  type: string;
  contentType: string;
  size: number;
}

/** Origin of a URL string, or null on anything that isn't a real
 * http(s)/extension origin (empty, malformed, or an opaque `null`-origin scheme
 * like data:/about:). Callers treat null as "unknown" and drop it. Pure. */
export function originFromUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  try {
    const o = new URL(url).origin;
    return o && o !== 'null' ? o : null;
  } catch {
    return null;
  }
}

/** Is this a content-type whose body is textual DATA worth capturing? JSON,
 * text/*, XML, CSV, NDJSON, GraphQL, JS (JSONP). Excludes images/fonts/media and
 * other binary so we never pull opaque bytes into the buffer. Pure. */
export function isDataContentType(mime: unknown): boolean {
  if (typeof mime !== 'string' || !mime) return false;
  const m = mime.toLowerCase();
  return (
    m.includes('json') ||
    m.startsWith('text/') ||
    m.includes('xml') ||
    m.includes('csv') ||
    m.includes('ndjson') ||
    m.includes('graphql') ||
    m.includes('javascript')
  );
}

/** Clip a response body to NETWORK_MAX_BODY, flagging truncation. Pure. */
export function clipBody(
  body: string,
  max = NETWORK_MAX_BODY,
): { body: string; truncated: boolean } {
  if (body.length <= max) return { body, truncated: false };
  return { body: body.slice(0, max), truncated: true };
}

/** Build a NetworkEntry from assembled metadata + an optional body string
 * (already known to be textual data; null when unavailable/binary). Pure, so
 * origin extraction / body capping are unit-testable without chrome. */
export function shapeNetworkEntry(meta: NetworkMeta, bodyText: string | null): NetworkEntry {
  // origin from the FULL url BEFORE clipping, so the fail-closed allowlist filter
  // (invariant #3) is unaffected by url truncation — then length-bounded (like the
  // other controllable string fields) so no returned field is uncapped IN CODE. A
  // real allowlist-passing origin is DNS-bounded to <=267 chars, far below the cap,
  // so the filter is never affected; the cap only bounds a pathological host string
  // and removes reliance on the external DNS bound.
  const origin = originFromUrl(meta.url);
  const clippedUrl = clipUrl(meta.url);
  const entry: NetworkEntry = {
    ts: meta.ts,
    // method/contentType are page/server-controllable too; cap them so no single
    // metadata field can dominate the result's wire size (see NETWORK_MAX_META_FIELD).
    method: meta.method.slice(0, NETWORK_MAX_META_FIELD),
    url: clippedUrl.url,
    status: meta.status,
    type: meta.type,
    contentType: meta.contentType.slice(0, NETWORK_MAX_META_FIELD),
    size: meta.size,
    origin: origin === null ? null : origin.slice(0, NETWORK_MAX_URL),
  };
  if (clippedUrl.truncated) entry.urlTruncated = true;
  if (typeof bodyText === 'string') {
    const { body, truncated } = clipBody(bodyText);
    entry.body = body;
    if (truncated) entry.bodyTruncated = true;
  }
  return entry;
}

/** Read-time filter: origin-allowed (fail-closed — a null origin is DROPPED) +
 * optional URL substring match, then slice to the newest `limit`. Returns the
 * sliced entries plus the pre-slice total so the caller can flag truncation.
 * Pure (the allowlist check is injected). */
export function filterNetworkEntries(
  entries: NetworkEntry[],
  isAllowed: (origin: string) => boolean,
  opts: { filter?: string; limit: number },
): { entries: NetworkEntry[]; total: number } {
  let out = entries.filter((e) => e.origin !== null && isAllowed(e.origin));
  if (opts.filter) {
    const needle = opts.filter.toLowerCase();
    out = out.filter((e) => e.url.toLowerCase().includes(needle));
  }
  return { entries: out.slice(-opts.limit), total: out.length };
}

/** Keep the NEWEST entries whole within a total WIRE-BYTE budget measured over the
 * ENTIRE serialised entry (metadata + body), not just the body — so one result
 * never exceeds the 16 MiB WS frame cap regardless of the requested `limit` OR of
 * how large the per-entry metadata (notably `url`) grew. An entry that doesn't fit
 * with its body drops the body (metadata + `size` kept, `bodyOmitted` set); its
 * clipped metadata still counts, so the running total tracks the real payload.
 * Measured in serialised wire bytes (entryWireBytes), not UTF-16 `.length`, so
 * JSON-escape/UTF-8 expansion can't sneak the frame over the cap. Clones the
 * entries it strips — never mutates the ring buffer. `entries` arrive
 * oldest→newest. Pure. */
export function applyResponseBudget(
  entries: NetworkEntry[],
  budget = NETWORK_RESPONSE_BUDGET,
): { entries: NetworkEntry[]; omitted: number } {
  const out = entries.slice();
  let used = 0;
  let omitted = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i];
    const full = entryWireBytes(e);
    if (used + full <= budget) {
      used += full;
      continue;
    }
    if (typeof e.body === 'string') {
      // Doesn't fit with its body — clone without it (ring buffer untouched). The
      // stripped, url-capped metadata is small; count it so `used` stays honest.
      const stripped: NetworkEntry = {
        ts: e.ts,
        method: e.method,
        url: e.url,
        status: e.status,
        type: e.type,
        contentType: e.contentType,
        size: e.size,
        origin: e.origin,
        bodyOmitted: true,
      };
      if (e.urlTruncated) stripped.urlTruncated = true;
      out[i] = stripped;
      used += entryWireBytes(stripped);
      omitted++;
    } else {
      // Already metadata-only (url-capped, small) — keep it and count it.
      used += full;
    }
  }
  return { entries: out, omitted };
}

/** Parse `network_tail`'s args: `limit` (default 20, capped at the ring size)
 * and an optional `filter` (URL substring). Pure. */
export function parseNetworkArgs(args: { limit?: unknown; filter?: unknown }): {
  limit: number;
  filter?: string;
} {
  let limit = DEFAULT_NETWORK_LIMIT;
  if (args.limit !== undefined && args.limit !== null) {
    const n = Number(args.limit);
    if (!Number.isInteger(n) || n < 1) {
      throw new BridgeError('bad_args', 'network_tail: limit must be a positive integer');
    }
    limit = Math.min(n, NETWORK_MAX_ENTRIES);
  }
  if (args.filter !== undefined && args.filter !== null) {
    if (typeof args.filter !== 'string') {
      throw new BridgeError('bad_args', 'network_tail: filter must be a string');
    }
    return { limit, filter: args.filter };
  }
  return { limit };
}

// --- chrome-bound state + wiring -------------------------------------------

const buffers = new Map<number, NetworkEntry[]>();
const bodyCache = new NetworkBodyCache(
  NETWORK_BODY_CACHE_PER_TAB,
  NETWORK_BODY_CACHE_TOTAL,
  bodyWireBytes,
);
// tabId -> (requestId -> in-flight metadata), assembled across
// requestWillBeSent (method, url, type) and responseReceived (final url,
// status, mimeType), finalised at loadingFinished. Capped PER TAB: one shared
// map with a global cap let a request-heavy tab evict another session's
// in-flight entries, whose responses were then silently never recorded — that
// session's network_tail just came back short with no indication anything was
// lost. Keying by tab also makes clearNetwork an O(1) delete instead of a scan,
// and removes any chance of a requestId colliding across tabs.
const pending = new Map<number, Map<string, NetworkMeta>>();

function pendingFor(tabId: number): Map<string, NetworkMeta> {
  let forTab = pending.get(tabId);
  if (forTab === undefined) {
    forTab = new Map();
    pending.set(tabId, forTab);
  }
  return forTab;
}
// Tokens identify capture lifetimes, not just tab IDs: a body read or enable
// failure from a detached session must never affect a later attachment.
const enabledTabs = new Map<number, symbol>();
let captureAllowed = true;
// In-flight body reads are counted as ACTUAL unresolved CDP calls, including
// those from a cleared capture — repeated detach/re-enable must not bypass the
// limit. Reads past it wait in a per-tab FIFO (oldest response first) and drain
// as slots free up (see NETWORK_MAX_QUEUED_BODY_READS).
const bodyReadsByTab = new Map<number, number>();
let bodyReads = 0;
type QueuedBodyRead = { requestId: string; tabId: number; entry: NetworkEntry; generation: symbol };
const bodyQueue = new Map<number, QueuedBodyRead[]>();

/** Stop accumulation immediately, including reads started before opt-out.
 * Enabling only permits future attach calls; it never drives an idle tab. */
export function setNetworkCaptureAllowed(allowed: boolean): void {
  captureAllowed = allowed;
  if (!allowed) {
    for (const tabId of enabledTabs.keys()) clearNetwork(tabId);
  }
}

function normalizeType(t: unknown): string {
  return typeof t === 'string' ? t.toLowerCase() : '';
}

/** Admit a body read for an already-recorded entry. Recording at
 * loadingFinished keeps the ring ordered by response completion, even when CDP
 * returns bodies out of order. An evicted entry may finish, but is never put
 * back into the ring. */
function enqueueBodyRead(read: QueuedBodyRead): void {
  const queue = bodyQueue.get(read.tabId) ?? [];
  if (queue.length >= NETWORK_MAX_QUEUED_BODY_READS) {
    read.entry.bodyOmitted = true;
    read.entry.bodyOmissionReason = 'capture_busy';
    return;
  }
  read.entry.bodyPending = true;
  queue.push(read);
  bodyQueue.set(read.tabId, queue);
  drainBodyReads();
}

/** Start queued reads while slots are free — per tab first, then globally.
 * Tabs are visited in queue-creation order; the per-tab cap keeps one tab from
 * holding more than its share of the global slots, so none starves. A read whose
 * capture ended, or whose entry left the ring while it waited, is dropped. */
function drainBodyReads(): void {
  for (const [tabId, queue] of bodyQueue) {
    if (bodyReads >= NETWORK_MAX_BODY_READS) return;
    while (
      queue.length > 0 &&
      (bodyReadsByTab.get(tabId) ?? 0) < NETWORK_MAX_BODY_READS_PER_TAB &&
      bodyReads < NETWORK_MAX_BODY_READS
    ) {
      const read = queue.shift()!;
      if (enabledTabs.get(tabId) !== read.generation || !buffers.get(tabId)?.includes(read.entry)) {
        delete read.entry.bodyPending;
        continue;
      }
      bodyReadsByTab.set(tabId, (bodyReadsByTab.get(tabId) ?? 0) + 1);
      bodyReads++;
      void runBodyRead(read);
    }
    if (queue.length === 0) bodyQueue.delete(tabId);
  }
}

async function runBodyRead({ requestId, tabId, entry, generation }: QueuedBodyRead): Promise<void> {
  try {
    const res = (await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', {
      requestId,
    })) as { body?: string; base64Encoded?: boolean };
    if (enabledTabs.get(tabId) !== generation) return;
    const buf = buffers.get(tabId);
    const index = buf?.indexOf(entry) ?? -1;
    if (!buf || index < 0) return; // already evicted while reading
    if (typeof res?.body === 'string' && res.base64Encoded !== true) {
      const clipped = clipBody(res.body);
      bodyCache.retain(tabId, entry, clipped.body, buf.slice(0, index));
      if (entry.body !== undefined && clipped.truncated) entry.bodyTruncated = true;
    }
  } catch {
    // Body evicted, target gone, etc. Keep the already-recorded metadata.
  } finally {
    delete entry.bodyPending;
    bodyReads--;
    const remaining = (bodyReadsByTab.get(tabId) ?? 1) - 1;
    if (remaining === 0) bodyReadsByTab.delete(tabId);
    else bodyReadsByTab.set(tabId, remaining);
    drainBodyReads();
  }
}

function onNetworkEvent(source: { tabId?: number }, method: string, params?: unknown): void {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  const generation = enabledTabs.get(tabId);
  if (generation === undefined) return;
  const p = (params ?? {}) as {
    requestId?: unknown;
    type?: unknown;
    request?: { method?: unknown; url?: unknown };
    response?: { url?: unknown; status?: unknown; mimeType?: unknown };
    encodedDataLength?: unknown;
  };
  const requestId = typeof p.requestId === 'string' ? p.requestId : null;
  if (requestId === null) return;

  if (method === 'Network.requestWillBeSent') {
    const type = normalizeType(p.type);
    if (!CAPTURED_RESOURCE_TYPES.has(type)) return;
    const forTab = pendingFor(tabId);
    if (forTab.size >= NETWORK_MAX_PENDING) {
      const oldest = forTab.keys().next().value;
      if (oldest !== undefined) forTab.delete(oldest);
    }
    const req = p.request ?? {};
    forTab.set(requestId, {
      ts: Date.now(),
      method: typeof req.method === 'string' ? req.method : '',
      url: typeof req.url === 'string' ? req.url : '',
      status: 0,
      type,
      contentType: '',
      size: 0,
    });
    return;
  }

  const forTab = pending.get(tabId);
  const rec = forTab?.get(requestId);
  if (forTab === undefined || rec === undefined) return;

  if (method === 'Network.responseReceived') {
    const resp = p.response ?? {};
    if (typeof resp.url === 'string') rec.url = resp.url; // final URL post-redirect
    if (typeof resp.status === 'number') rec.status = resp.status;
    if (typeof resp.mimeType === 'string') rec.contentType = resp.mimeType;
    return;
  }

  if (method === 'Network.loadingFinished') {
    forTab.delete(requestId);
    if (typeof p.encodedDataLength === 'number') rec.size = p.encodedDataLength;
    const entry = shapeNetworkEntry(rec, null);
    const buf = buffers.get(tabId) ?? [];
    if (buf.length === NETWORK_MAX_ENTRIES) bodyCache.release(buf[0]);
    pushCapped(buf, entry, NETWORK_MAX_ENTRIES);
    buffers.set(tabId, buf);
    if (isDataContentType(rec.contentType))
      enqueueBodyRead({ requestId, tabId, entry, generation });
    return;
  }

  if (method === 'Network.loadingFailed') {
    forTab.delete(requestId);
  }
}

// Registered once. Guarded so importing this module in vitest (no chrome) just
// loads the pure helpers without demanding the API. A second onEvent listener
// alongside console-capture's is fine — each filters to its own method prefix.
if (typeof chrome !== 'undefined' && chrome.debugger?.onEvent) {
  chrome.debugger.onEvent.addListener(onNetworkEvent);
}

/** Idempotently turn on network capture for a tab — issues `Network.enable`
 * once per tab. Called from `attach()` ONLY when the captureNetwork setting is
 * on. Uses `chrome.debugger.sendCommand` directly to avoid an import cycle with
 * cdp.ts. Best-effort: a failure drops the flag so a later attach retries and
 * never breaks the tool call. */
export async function ensureNetworkCapture(tabId: number): Promise<void> {
  if (!captureAllowed || enabledTabs.has(tabId)) return;
  const generation = Symbol();
  enabledTabs.set(tabId, generation);
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  } catch {
    if (enabledTabs.get(tabId) === generation) clearNetwork(tabId);
  }
}

/** Drop a tab's buffer + enabled flag + any in-flight pending — wired into
 * tabs.onRemoved / debugger.onDetach (cdp.ts) so capture state never outlives
 * the tab. */
export function clearNetwork(tabId: number): void {
  for (const entry of buffers.get(tabId) ?? []) bodyCache.release(entry);
  bodyQueue.delete(tabId); // in-flight reads still count until Chrome answers
  buffers.delete(tabId);
  enabledTabs.delete(tabId);
  pending.delete(tabId);
}

/** Snapshot a tab's captured entries (a copy, oldest→newest). */
export function readNetwork(tabId: number): NetworkEntry[] {
  // Body completion must not change a result whose wire budget was already
  // computed, or add data to a snapshot returned before opt-out.
  return (buffers.get(tabId) ?? []).map((entry) => ({ ...entry }));
}
