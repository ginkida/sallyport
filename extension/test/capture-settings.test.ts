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
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Network.enable', expect.anything());
    sendCommand.mockClear();
    mod.onSettingsChanged({ sallyport_settings: undefined }, 'local');
    // Off narrows the footprint now, not at detach.
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Network.disable');
    sendCommand.mockClear();
    await network.ensureNetworkCapture(2);
    expect(sendCommand).not.toHaveBeenCalled();
    expect(network.readNetwork(1)).toEqual([]);
  });

  it('turning capture ON sends nothing — it only permits the next attach', async () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    vi.stubGlobal('chrome', {
      debugger: { sendCommand, onEvent: { addListener: vi.fn() } },
    });
    const network = await import('../src/tools/network-capture.js');
    const consoleCapture = await import('../src/tools/console-capture.js');
    const mod = await import('../src/tools/capture-settings.js');
    mod.onSettingsChanged({ sallyport_settings: { newValue: {} } }, 'local');
    expect(sendCommand).not.toHaveBeenCalled(); // nothing was capturing
    mod.onSettingsChanged(
      { sallyport_settings: { newValue: { captureConsole: true, captureNetwork: true } } },
      'local',
    );
    expect(sendCommand).not.toHaveBeenCalled();
    await network.ensureNetworkCapture(1);
    await consoleCapture.ensureConsoleCapture(1);
    expect(sendCommand.mock.calls.map(([, m]) => m)).toEqual(['Network.enable', 'Runtime.enable']);
  });
});
