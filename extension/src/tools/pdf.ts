/** `print_to_pdf` — render the page to a PDF via Page.printToPDF.
 *
 * Structured CDP only (no page JavaScript) — same trust shape as screenshot:
 * allowlist-gated, no per-domain evaluate flag needed. Unlike screenshot it
 * does NOT need a visible tab: print rendering doesn't wait for a compositor
 * frame, so background agent tabs in broker mode are printable too.
 *
 * The base64 payload crosses the WS once and the daemon writes it into the
 * download sandbox (local_tools.py POST_CALL_PROCESSORS) — the MCP caller
 * only ever sees {path, size, filename}. checkPdfSize keeps a giant PDF from
 * tripping the daemon's 16 MiB frame cap, which would 1009-close the
 * connection and strand the call entirely.
 */

import { attach, cdp } from './cdp.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

/** Cap on the base64 payload length: 12 MiB of base64 ≈ 9 MiB of binary —
 * comfortably under the daemon's 16 MiB frame cap even with envelope and
 * MAC overhead. */
export const MAX_PDF_BASE64_CHARS = 12 * 1024 * 1024;

export type PrintArgs = {
  landscape: boolean;
  printBackground: boolean;
  scale: number;
};

export function parsePrintArgs(args: Record<string, unknown>): PrintArgs {
  let scale = 1;
  if (args.scale !== undefined && args.scale !== null) {
    const v = Number(args.scale);
    if (!Number.isFinite(v) || v < 0.1 || v > 2) {
      throw new BridgeError('bad_args', 'print_to_pdf: scale must be a number in [0.1, 2]');
    }
    scale = v;
  }
  return {
    landscape: args.landscape === true,
    printBackground: args.printBackground !== false,
    scale,
  };
}

export function checkPdfSize(base64: string): void {
  if (base64.length > MAX_PDF_BASE64_CHARS) {
    throw new BridgeError(
      'pdf_too_large',
      `print_to_pdf: generated PDF is ${base64.length} base64 chars, over the ` +
        `${MAX_PDF_BASE64_CHARS} limit — the bridge frame cap cannot carry it. ` +
        'Reduce the page (smaller scale, print stylesheet) or capture a region with screenshot.',
    );
  }
}

export const printToPdf: Tool = async (args) => {
  const print = parsePrintArgs(args);
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  const out = await cdp<{ data: string }>(tab.id!, 'Page.printToPDF', {
    landscape: print.landscape,
    printBackground: print.printBackground,
    scale: print.scale,
  });
  checkPdfSize(out.data);
  return {
    tabId: tab.id,
    url: tab.url,
    data: { pdfBase64: out.data, base64Length: out.data.length },
  };
};
