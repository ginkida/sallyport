import { attach, cdp } from './cdp.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

/**
 * `fetch_in_page` — runs `fetch()` from the page's JS context.
 *
 * Unlike `evaluate`, the function body is fixed and only the URL/method/
 * headers/body are JSON-interpolated. The page's cookies and auth context
 * apply, which is the whole point (lets the agent grab e.g. a profile-pic
 * URL from a logged-in session). It is gated by the page's domain — the
 * tab must be on an allow-listed host — but does NOT require the
 * per-domain `evaluate` flag.
 *
 * Returns:
 *   { status, contentType, headers: [[k,v], ...], mode: 'text' | 'base64',
 *     data: string }
 *
 * `mode` defaults to 'auto': text for text/json/html/xml content-types,
 * base64 for everything else. Pass returnAs='text' or returnAs='base64'
 * to force — and `saveAs` defaults it to 'base64', because a body destined
 * for a FILE must not go through `resp.text()`: that decodes as UTF-8 and
 * replaces every invalid sequence with U+FFFD, which is lossy, irreversible,
 * and silent. An explicit `returnAs:'text'` still wins; the caller asked.
 *
 * The body is size-capped TWICE, and the second one is the one that counts.
 * An oversize tool_result trips the daemon's 16 MiB frame cap, and that is a
 * 1009 close of the SHARED extension leg — it fails not just this call but
 * every OTHER session's in-flight call, and `not_connected` is retryable, so a
 * well-behaved agent reconnects and tears it down again. `print_to_pdf` and
 * `screenshot` already self-police for exactly this reason.
 *
 *  - in the page (`FETCH_MAX_BYTES`), before the body becomes a string: a cheap
 *    early bail so a 200 MB asset is never materialised in the renderer. It is
 *    an OPTIMISATION, not the gate — the number comes from page JS, and nothing
 *    load-bearing may rest on what a page reports (invariant #4);
 *  - in the extension (`checkFetchSize`), on the string we actually hold: this
 *    is the authority, and it measures what the WIRE will carry rather than
 *    what the body decodes to. Those differ: canonical JSON escapes control
 *    characters to `\u00XX`, six bytes each, so a text body well under the byte
 *    ceiling can still serialise past the frame cap.
 */
/** Cap on the response body, checked in the page before any string is built.
 * Matches print_to_pdf's ceiling in spirit: ~9 MiB of binary becomes ~12 MiB of
 * base64, comfortably under the daemon's 16 MiB frame cap once the envelope and
 * MAC are added. Text is capped at the same byte count. */
export const FETCH_MAX_BYTES = 9 * 1024 * 1024;

/** Cap on the SERIALISED payload — what the frame actually has to carry. 12 MiB
 * leaves ~4 MiB of headroom under the daemon's 16 MiB frame cap for the
 * envelope, the MAC and the rest of the result object. Same ceiling
 * `print_to_pdf` uses for its base64. */
export const FETCH_MAX_WIRE_BYTES = 12 * 1024 * 1024;

/** The serialised size of the payload string as it will travel: JSON-escaped
 * and UTF-8 encoded. Base64 needs no escaping and is pure ASCII, so this is
 * exactly `data.length` for a binary body; for text it can be several times the
 * decoded byte count, which is the case the in-page check cannot see. */
export function wireBytes(data: string): number {
  return new TextEncoder().encode(JSON.stringify(data)).length;
}

/** Authoritative, extension-side size gate. Mirrors `pdf.ts:checkPdfSize` —
 * measured on the string WE hold, not on a number the page handed us. */
export function checkFetchSize(data: string, saveAs: boolean): void {
  const bytes = wireBytes(data);
  if (bytes > FETCH_MAX_WIRE_BYTES) throw fetchTooLarge(bytes, saveAs);
}

/** Turn a too-big payload into the stable, non-retryable error.
 * Pure, so the wording and the code are testable without chrome. */
export function fetchTooLarge(bytes: number, saveAs: boolean): BridgeError {
  return new BridgeError(
    'fetch_too_large',
    `fetch_in_page: the response serialises to ${bytes} bytes, over the ` +
      `${FETCH_MAX_WIRE_BYTES} limit — ` +
      `the bridge frame cap cannot carry it${saveAs ? ' (saveAs does not help: the body still crosses the wire)' : ''}. ` +
      `Request a smaller asset, or fetch it in pieces with a Range header.`,
  );
}

export const fetchInPage: Tool = async (args) => {
  const url = String(args.url || '');
  if (!url) throw new BridgeError('bad_args', 'fetch_in_page: url required');
  const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';
  const headers =
    args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)
      ? (args.headers as Record<string, unknown>)
      : {};
  // The MCP schema declares header values as strings. Enforce it here so a
  // non-string slips out as a clean `bad_args` rather than being JSON-baked
  // into the fetch expression and surfacing later as a confusing
  // `fetch_failed` from the browser's stricter Headers validation.
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== 'string') {
      throw new BridgeError(
        'bad_args',
        `fetch_in_page: header ${JSON.stringify(k)} must be a string, got ${typeof v}`,
      );
    }
  }
  const body = args.body !== undefined ? String(args.body) : undefined;
  const saveAs = typeof args.saveAs === 'string' && args.saveAs !== '';
  // `saveAs` implies base64: the daemon writes the bytes to disk, and the text
  // path would hand it a lossy UTF-8 re-decode of whatever the server sent.
  const returnAs =
    args.returnAs === 'text' || args.returnAs === 'base64'
      ? args.returnAs
      : saveAs
        ? 'base64'
        : 'auto';

  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);

  const bodyJson = body === undefined ? 'undefined' : JSON.stringify(body);
  // The function body is FIXED. Only the args are JSON-interpolated, which
  // means an attacker can't inject code by crafting a URL with a quote
  // (JSON-stringification escapes it).
  const expr = `(async () => {
    const resp = await fetch(${JSON.stringify(url)}, {
      method: ${JSON.stringify(method)},
      headers: ${JSON.stringify(headers)},
      body: ${bodyJson},
      credentials: 'include',
    });
    const ct = resp.headers.get('content-type') || '';
    const status = resp.status;
    const headerEntries = [...resp.headers.entries()];
    let mode = ${JSON.stringify(returnAs)};
    if (mode === 'auto') {
      mode = (
        ct.startsWith('text/')
        || ct.includes('json')
        || ct.includes('xml')
        || ct.includes('javascript')
      ) ? 'text' : 'base64';
    }
    if (mode === 'text') {
      const text = await resp.text();
      // Measure UTF-8 BYTES, not UTF-16 code units. What the frame cap counts is
      // bytes on the wire, and for anything non-ASCII the two diverge in the
      // dangerous direction — 9M characters of Cyrillic is 18 MB of UTF-8 and
      // would sail past a length check while still killing the connection. The
      // encode allocates a copy in the page, which never crosses the wire.
      const textBytes = new TextEncoder().encode(text).length;
      if (textBytes > ${FETCH_MAX_BYTES}) {
        return { status, contentType: ct, tooLargeBytes: textBytes };
      }
      return { status, contentType: ct, headers: headerEntries, mode: 'text', data: text };
    }
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (bytes.length > ${FETCH_MAX_BYTES}) {
      return { status, contentType: ct, tooLargeBytes: bytes.length };
    }
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return { status, contentType: ct, headers: headerEntries, mode: 'base64', data: btoa(binary) };
  })()`;

  const out = await cdp<{
    result: { type: string; value?: unknown };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>(tab.id!, 'Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (out.exceptionDetails) {
    const msg = out.exceptionDetails.exception?.description ?? out.exceptionDetails.text;
    throw new BridgeError('fetch_failed', `fetch_in_page: ${msg}`);
  }
  const value = out.result.value as { tooLargeBytes?: number; data?: unknown } | undefined;
  if (value && typeof value.tooLargeBytes === 'number') {
    // The page's early bail. Trusted only to save work, never as the gate:
    // the check below is what actually protects the shared leg.
    throw fetchTooLarge(value.tooLargeBytes, saveAs);
  }
  if (value && typeof value.data === 'string') checkFetchSize(value.data, saveAs);
  return { tabId: tab.id, url: tab.url, data: out.result.value };
};
