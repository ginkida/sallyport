import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The listener's own edges — the lifecycle behaviour it drives is covered in
 * capture-lifecycle.test.ts. */
describe('capture settings listener', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('installs nothing when chrome.storage is unavailable (importing never demands the API)', async () => {
    vi.stubGlobal('chrome', {});
    const mod = await import('../src/tools/capture-settings.js');
    expect(() => mod.installCaptureSettingsListener()).not.toThrow();
  });

  it('treats a REMOVED settings key as capture off', async () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    vi.stubGlobal('chrome', {
      debugger: { sendCommand, onEvent: { addListener: vi.fn() } },
    });
    const network = await import('../src/tools/network-capture.js');
    const mod = await import('../src/tools/capture-settings.js');
    await network.ensureNetworkCapture(1);
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Network.enable');
    mod.onSettingsChanged({ sallyport_settings: undefined }, 'local');
    sendCommand.mockClear();
    await network.ensureNetworkCapture(2);
    expect(sendCommand).not.toHaveBeenCalled();
    expect(network.readNetwork(1)).toEqual([]);
  });
});
