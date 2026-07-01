import { describe, expect, it } from 'vitest';

import { isTrustedPopupSender } from '../src/ipc.js';

const OWN = 'aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb';
const sender = (over: Partial<chrome.runtime.MessageSender>): chrome.runtime.MessageSender =>
  over as chrome.runtime.MessageSender;

// PAIR/UNPAIR/PAUSE must come from the extension's own popup, never a content
// script in a web page or another extension. isTrustedPopupSender is the
// fail-closed gate (see ipc.ts).
describe('isTrustedPopupSender', () => {
  it("accepts the extension's own popup (own id, no tab)", () => {
    expect(
      isTrustedPopupSender(sender({ id: OWN, url: `chrome-extension://${OWN}/popup.html` }), OWN),
    ).toBe(true);
  });

  it('rejects a sender carrying a tab (a content script in a web page)', () => {
    expect(isTrustedPopupSender(sender({ id: OWN, tab: { id: 5 } as chrome.tabs.Tab }), OWN)).toBe(
      false,
    );
  });

  it('rejects a different extension id', () => {
    expect(isTrustedPopupSender(sender({ id: 'someOtherExtensionId' }), OWN)).toBe(false);
  });

  it('fails closed on a missing sender, missing own id, or missing sender id', () => {
    expect(isTrustedPopupSender(undefined, OWN)).toBe(false);
    expect(isTrustedPopupSender(sender({ id: OWN }), undefined)).toBe(false);
    expect(isTrustedPopupSender(sender({}), OWN)).toBe(false);
  });
});
