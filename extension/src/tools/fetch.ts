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
 * to force.
 */
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
  const returnAs = args.returnAs === 'text' || args.returnAs === 'base64' ? args.returnAs : 'auto';

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
      return { status, contentType: ct, headers: headerEntries, mode: 'text', data: await resp.text() };
    }
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
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
  return { tabId: tab.id, url: tab.url, data: out.result.value };
};
