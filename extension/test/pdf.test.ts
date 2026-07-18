import { describe, expect, it } from 'vitest';
import {
  MAX_PDF_BASE64_CHARS,
  checkPdfSize,
  parsePrintArgs,
} from '../src/tools/pdf.js';

describe('print_to_pdf.parsePrintArgs', () => {
  it('defaults to portrait, background on, scale 1', () => {
    expect(parsePrintArgs({})).toEqual({
      landscape: false,
      printBackground: true,
      scale: 1,
    });
  });

  it('honours explicit landscape/printBackground/scale', () => {
    expect(parsePrintArgs({ landscape: true, printBackground: false, scale: 0.5 })).toEqual({
      landscape: true,
      printBackground: false,
      scale: 0.5,
    });
  });

  it('accepts the scale bounds 0.1 and 2', () => {
    expect(parsePrintArgs({ scale: 0.1 }).scale).toBe(0.1);
    expect(parsePrintArgs({ scale: 2 }).scale).toBe(2);
  });

  it('treats scale null/undefined as the default', () => {
    expect(parsePrintArgs({ scale: null }).scale).toBe(1);
    expect(parsePrintArgs({ scale: undefined }).scale).toBe(1);
  });

  it('coerces a numeric string scale', () => {
    expect(parsePrintArgs({ scale: '1.5' }).scale).toBe(1.5);
  });

  it('rejects out-of-range, NaN and infinite scale', () => {
    expect(() => parsePrintArgs({ scale: 0.09 })).toThrow(/scale must be a number/);
    expect(() => parsePrintArgs({ scale: 2.01 })).toThrow(/scale must be a number/);
    expect(() => parsePrintArgs({ scale: NaN })).toThrow(/scale must be a number/);
    expect(() => parsePrintArgs({ scale: Infinity })).toThrow(/scale must be a number/);
    expect(() => parsePrintArgs({ scale: 'wide' })).toThrow(/scale must be a number/);
  });

  it('only strict true enables landscape; only strict false disables background', () => {
    expect(parsePrintArgs({ landscape: 1 }).landscape).toBe(false);
    expect(parsePrintArgs({ printBackground: 0 }).printBackground).toBe(true);
  });
});

describe('print_to_pdf.checkPdfSize', () => {
  it('accepts a payload at exactly the cap', () => {
    expect(() => checkPdfSize('a'.repeat(MAX_PDF_BASE64_CHARS))).not.toThrow();
  });

  it('rejects a payload one char over the cap', () => {
    expect(() => checkPdfSize('a'.repeat(MAX_PDF_BASE64_CHARS + 1))).toThrow(/pdf_too_large|over the/);
  });

  it('keeps the cap under the daemon 16 MiB frame budget', () => {
    // base64 inflates binary by 4/3: the cap must leave headroom for the
    // signed envelope under the 16 MiB WS frame limit (invariant #6).
    expect(MAX_PDF_BASE64_CHARS).toBeLessThan(16 * 1024 * 1024);
  });
});
