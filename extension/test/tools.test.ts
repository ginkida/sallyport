/**
 * The broker-mode epoch chokepoint in `runTool` (invariant #13, defence-in-depth).
 *
 * The daemon is the authoritative ownership gate, but it can't see that Chrome
 * recycled a tabId — so it keeps injecting the create-time `expectedEpoch` it
 * recorded, and `runTool` confirms it against the locally-minted epoch BEFORE
 * acting (→ `tab_gone` on mismatch). It also strips the broker-internal field so
 * neither the tool body nor the audit log ever sees it. These pin that wiring at
 * its real enforcement point; the helpers themselves are unit-tested separately
 * in ownership.test.ts, but only this proves they're wired correctly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the vi.mock factory (itself hoisted above imports) can reference it.
const { clickStub } = vi.hoisted(() => ({ clickStub: vi.fn() }));

vi.mock('../src/storage.js', () => ({
  getSettings: vi.fn(async () => ({ paused: false })),
  appendAudit: vi.fn(async () => {}),
  redactAuditArgs: vi.fn((_name: string, args: Record<string, unknown>) => args),
}));

vi.mock('../src/tools/dom.js', () => ({
  click: clickStub,
  fill: vi.fn(),
  readText: vi.fn(),
}));

vi.mock('../src/tools/keyboard.js', () => ({
  keyType: vi.fn(),
  sendKeys: vi.fn(),
}));

import { runTool, BridgeError } from '../src/tools.js';
import { appendAudit, redactAuditArgs } from '../src/storage.js';
import { clearAllEpochs, mintEpoch } from '../src/tools/ownership.js';
import { keyType } from '../src/tools/keyboard.js';

beforeEach(() => {
  clearAllEpochs();
  clickStub.mockReset();
  clickStub.mockResolvedValue({ data: { ok: true } });
  vi.mocked(appendAudit).mockClear();
  vi.mocked(redactAuditArgs).mockClear();
  vi.mocked(keyType).mockReset();
});

describe('runTool epoch chokepoint', () => {
  it('runs the tool with the broker-internal epoch stripped when it matches', async () => {
    const epoch = mintEpoch(5);
    await runTool('click', { tabId: 5, expectedEpoch: epoch });

    expect(clickStub).toHaveBeenCalledOnce();
    const passed = clickStub.mock.calls[0][0];
    expect(passed).toEqual({ tabId: 5 }); // expectedEpoch removed before the tool sees it
    expect('expectedEpoch' in passed).toBe(false);
  });

  it('refuses with tab_gone and never runs the tool when the epoch mismatches', async () => {
    mintEpoch(5); // a DIFFERENT epoch than the daemon will claim
    await expect(
      runTool('click', { tabId: 5, expectedEpoch: 'stale-epoch' }),
    ).rejects.toMatchObject({ code: 'tab_gone' });
    expect(clickStub).not.toHaveBeenCalled();
  });

  it('refuses with tab_gone when the tab id was recycled (no minted epoch)', async () => {
    await expect(runTool('click', { tabId: 7, expectedEpoch: 'any' })).rejects.toMatchObject({
      code: 'tab_gone',
    });
    expect(clickStub).not.toHaveBeenCalled();
  });

  it('never leaks expectedEpoch into the audit log (success or refusal)', async () => {
    const epoch = mintEpoch(5);
    await runTool('click', { tabId: 5, expectedEpoch: epoch });
    await runTool('click', { tabId: 5, expectedEpoch: epoch });
    mintEpoch(8);
    await expect(runTool('click', { tabId: 8, expectedEpoch: 'wrong' })).rejects.toBeInstanceOf(
      Error,
    );

    for (const call of vi.mocked(appendAudit).mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain('expectedEpoch');
    }
  });

  it('confirms nothing when no expectedEpoch is supplied (standalone path)', async () => {
    // No epoch injected by the daemon → the chokepoint is inert and the tool runs.
    await runTool('click', { tabId: 5 });
    expect(clickStub).toHaveBeenCalledOnce();
    expect(clickStub.mock.calls[0][0]).toEqual({ tabId: 5 });
  });
});

describe('runTool — force-redacts attempted secrets on password-probe failures', () => {
  it('force-redacts key_type.text when the tool throws password_field', async () => {
    vi.mocked(keyType).mockRejectedValueOnce(
      new BridgeError('password_field', 'key_type: focus is on <input type=password>'),
    );
    await expect(runTool('key_type', { tabId: 5, text: 'hunter2' })).rejects.toMatchObject({
      code: 'password_field',
    });
    const forceCall = vi
      .mocked(redactAuditArgs)
      .mock.calls.find(([, , opts]) => opts?.force === true);
    expect(forceCall).toBeDefined();
    expect(forceCall![0]).toBe('key_type');
  });

  it('force-redacts key_type.text when the probe fails closed with focus_probe_failed', async () => {
    // The CDP focus walk's fail-closed branch (keyboard.ts/focus.ts): we couldn't rule
    // OUT a password field, so the attempted text must not reach the audit
    // log any less than the confirmed password_field case does.
    vi.mocked(keyType).mockRejectedValueOnce(
      new BridgeError('focus_probe_failed', 'key_type: could not verify the focused field'),
    );
    await expect(runTool('key_type', { tabId: 5, text: 'hunter2' })).rejects.toMatchObject({
      code: 'focus_probe_failed',
    });
    const forceCall = vi
      .mocked(redactAuditArgs)
      .mock.calls.find(([, , opts]) => opts?.force === true);
    expect(forceCall).toBeDefined();
    expect(forceCall![0]).toBe('key_type');
  });

  it('does NOT force-redact on unrelated tool failures', async () => {
    vi.mocked(keyType).mockRejectedValueOnce(new BridgeError('bad_args', 'key_type: missing text'));
    await expect(runTool('key_type', { tabId: 5, text: 'hunter2' })).rejects.toMatchObject({
      code: 'bad_args',
    });
    const forceCall = vi
      .mocked(redactAuditArgs)
      .mock.calls.find(([, , opts]) => opts?.force === true);
    expect(forceCall).toBeUndefined();
  });
});
