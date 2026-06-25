import { describe, expect, it } from 'vitest';

import { classifyAttachError } from '../src/tools/cdp.js';
import { BridgeError } from '../src/tools/errors.js';

describe('classifyAttachError', () => {
  it('returns a BridgeError tagged "attach failed:" carrying the original text', () => {
    const err = classifyAttachError('No tab with given id: 42.');
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.message).toBe('attach failed: No tab with given id: 42.');
  });

  it('classifies restricted pages as attach_forbidden_url', () => {
    for (const msg of [
      'Cannot access a chrome:// URL',
      'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
      'The extensions gallery cannot be scripted.',
      'Cannot attach to extension pages.',
      'Cannot access a chrome-untrusted:// URL',
    ]) {
      expect(classifyAttachError(msg).code).toBe('attach_forbidden_url');
    }
  });

  it('classifies a busy/occupied tab as attach_debugger_conflict', () => {
    for (const msg of [
      'Another debugger is already attached to the tab with id: 123.',
      'Cannot attach to the target with an attached client.',
      'Tabs cannot be edited right now (user may be dragging a tab).',
    ]) {
      expect(classifyAttachError(msg).code).toBe('attach_debugger_conflict');
    }
  });

  it('classifies a gone tab/target as attach_target_closed', () => {
    for (const msg of [
      'No tab with given id: 99.',
      'No target with given id: 7.',
      'Cannot attach to this target.',
    ]) {
      expect(classifyAttachError(msg).code).toBe('attach_target_closed');
    }
  });

  it('falls back to attach_failed without swallowing an unrecognised error', () => {
    const err = classifyAttachError('Some brand-new Chrome error nobody mapped');
    expect(err.code).toBe('attach_failed');
    expect(err.message).toContain('Some brand-new Chrome error nobody mapped');
  });

  it('caps the echoed message at 200 chars (it can embed a long page URL)', () => {
    const long = 'Cannot access contents of url ' + 'x'.repeat(500);
    const err = classifyAttachError(long);
    // Classification reads the full message; only the echoed detail is capped.
    expect(err.code).toBe('attach_forbidden_url');
    expect(err.message.length).toBe('attach failed: '.length + 200);
  });

  it('tolerates an empty/garbage message (still a generic BridgeError)', () => {
    expect(classifyAttachError('').code).toBe('attach_failed');
    expect(classifyAttachError('').message).toBe('attach failed: ');
  });

  it('is case-insensitive', () => {
    expect(classifyAttachError('NO TAB WITH GIVEN ID: 5.').code).toBe('attach_target_closed');
  });
});
