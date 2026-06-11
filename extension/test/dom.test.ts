/**
 * `fill`'s password gate reads the target's `type` attribute from the browser
 * DOM via CDP `DOM.getAttributes` (a flat `[name, value, …]` list) rather than
 * a page-readable `this.type` getter, so a hostile page can't shadow the gate
 * with a throwing or lying accessor. `attributesIndicatePassword` is the pure
 * decision over that list; the chrome-bound read around it is exercised
 * manually / via the daemon e2e harness. These tests pin the fail-closed
 * semantics that the gate depends on.
 *
 * `dom.ts` imports `cdp.ts`, which registers `chrome.*` listeners at module
 * load, so we stub the minimal surface and import the module dynamically once
 * the stub is in place (vitest runs under node with no real `chrome`).
 */

import { beforeAll, describe, expect, it } from 'vitest';

let attributesIndicatePassword: (attrs: readonly string[] | null | undefined) => boolean;

beforeAll(async () => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: { onRemoved: { addListener() {} } },
    debugger: { onDetach: { addListener() {} } },
  };
  ({ attributesIndicatePassword } = await import('../src/tools/dom.js'));
});

describe('attributesIndicatePassword', () => {
  it('flags an explicit type=password', () => {
    expect(attributesIndicatePassword(['type', 'password'])).toBe(true);
    expect(attributesIndicatePassword(['id', 'pw', 'type', 'password', 'name', 'p'])).toBe(true);
  });

  it('matches case-insensitively and trims, per HTML content-attribute rules', () => {
    expect(attributesIndicatePassword(['type', 'PASSWORD'])).toBe(true);
    expect(attributesIndicatePassword(['type', 'Password'])).toBe(true);
    expect(attributesIndicatePassword(['TYPE', 'password'])).toBe(true);
    expect(attributesIndicatePassword(['type', '  password  '])).toBe(true);
  });

  it('does not flag ordinary fields', () => {
    expect(attributesIndicatePassword(['type', 'text'])).toBe(false);
    expect(attributesIndicatePassword(['type', 'email'])).toBe(false);
    expect(attributesIndicatePassword(['placeholder', 'password'])).toBe(false);
  });

  it('treats a present-but-typeless element as ordinary (defaults to text)', () => {
    expect(attributesIndicatePassword([])).toBe(false);
    expect(attributesIndicatePassword(['id', 'x', 'class', 'y'])).toBe(false);
  });

  it('fails closed when the attribute list could not be read', () => {
    expect(attributesIndicatePassword(null)).toBe(true);
    expect(attributesIndicatePassword(undefined)).toBe(true);
  });

  it('ignores a dangling final name with no value', () => {
    // A malformed odd-length list must not throw; the trailing name is skipped.
    expect(attributesIndicatePassword(['type'])).toBe(false);
    expect(attributesIndicatePassword(['id', 'x', 'type'])).toBe(false);
  });
});
