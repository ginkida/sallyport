import { describe, expect, it } from 'vitest';

import { checkScreenshotSize, MAX_SCREENSHOT_BASE64_CHARS } from '../src/tools/screenshot.js';

describe('checkScreenshotSize', () => {
  it('passes an ordinary capture through', () => {
    expect(() => checkScreenshotSize('A'.repeat(1024))).not.toThrow();
    expect(() => checkScreenshotSize('A'.repeat(MAX_SCREENSHOT_BASE64_CHARS))).not.toThrow();
  });

  it('refuses a capture the frame cap could not carry', () => {
    // An oversize frame is not a failed call — the daemon answers it with a
    // 1009 close that drops the shared extension leg for every session.
    expect(() => checkScreenshotSize('A'.repeat(MAX_SCREENSHOT_BASE64_CHARS + 1))).toThrowError(
      /over the .* limit/,
    );
  });

  it('names the ways out, including the emulated-viewport one', () => {
    let message = '';
    try {
      checkScreenshotSize('A'.repeat(MAX_SCREENSHOT_BASE64_CHARS + 1));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('maxWidth');
    expect(message).toContain('region');
    expect(message).toContain('set_viewport');
  });

  it('stays under the daemon frame cap with base64 and envelope overhead', () => {
    expect(MAX_SCREENSHOT_BASE64_CHARS).toBeLessThan(16 * 1024 * 1024);
  });
});
