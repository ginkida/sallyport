import { setConsoleCaptureAllowed } from './console-capture.js';
import { setNetworkCaptureAllowed } from './network-capture.js';

/** React to the popup flipping a capture setting.
 *
 * Turning capture off must also reach idle tabs; waiting for their next tool
 * call could leave response bodies accumulating indefinitely. Clearing is
 * synchronous and invalidates pending reads before this handler returns. The
 * CDP side narrows at once too, best-effort, on every tab this worker enabled
 * capture on: `Network.disable` frees the renderer's response buffer, and the
 * 'console' object-group release + `Runtime.disable` free what V8 kept of every
 * logged argument (no tool depends on either domain being enabled — Runtime
 * commands work without `Runtime.enable`). Turning capture ON only permits
 * future attach calls. */
export function onSettingsChanged(
  changes: Record<string, { newValue?: unknown } | undefined>,
  area: string,
): void {
  if (area !== 'local' || !('sallyport_settings' in changes)) return;
  const settings = changes.sallyport_settings?.newValue as
    { captureConsole?: unknown; captureNetwork?: unknown } | undefined;
  setConsoleCaptureAllowed(!!settings?.captureConsole);
  setNetworkCaptureAllowed(!!settings?.captureNetwork);
}

/** Install the listener. Called from `background.ts` at worker load — before any
 * attach can await a settings read — with a NAMED import, so the edge shows up
 * in the import-graph cycle test (a bare side-effect import would not). */
export function installCaptureSettingsListener(): void {
  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener(onSettingsChanged);
  }
}
