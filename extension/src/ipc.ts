/** Trust gate for the popup↔service-worker message channel.
 *
 * The control messages the service worker accepts (PAIR injects a pairing
 * secret, UNPAIR wipes the secret + allowlist, PAUSE/RESUME/RECONNECT toggle the
 * connection) must originate from the extension's OWN pages — the popup — never
 * from a content script running in a web page or from another extension.
 *
 * `chrome.runtime.onMessage` is already same-extension-only: this extension
 * declares no `externally_connectable` and ships no content scripts, so today
 * nothing untrusted can reach the handler. This predicate is a FAIL-CLOSED guard
 * so that a *future* content script or `externally_connectable` entry can't
 * silently turn PAIR/UNPAIR into a web-reachable secret-injection or denial
 * surface — the trust assumption is enforced in code, not just in the manifest.
 * Pure / unit-tested (`ownId` injected instead of reading `chrome.runtime.id`). */
export function isTrustedPopupSender(
  sender: chrome.runtime.MessageSender | undefined,
  ownId: string | undefined,
): boolean {
  if (!sender || !ownId) return false;
  // Our own extension only (not another extension over some future channel).
  if (sender.id !== ownId) return false;
  // From an extension page (popup / options / the service worker itself), NOT a
  // content script in a tab — content-script senders carry a `tab`.
  if (sender.tab !== undefined) return false;
  return true;
}
