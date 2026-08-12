import { describe, expect, it } from 'vitest';

import {
  classifyAttachError,
  keepAwakeAction,
  looksLikeMissingNodeError,
  looksLikeSelectorSyntaxError,
} from '../src/tools/cdp.js';
import { BridgeError, invalidSelectorError, staleRefError } from '../src/tools/errors.js';

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

// Keep-awake must actually REVOKE focus emulation when the user turns the
// setting off (not just stop re-asserting), so a tab stops reporting itself
// focused. keepAwakeAction decides enable / disable per attach — the off-path
// is UNCONDITIONAL (no ephemeral "was emulated" gate) so it stays correct after
// an MV3 service-worker restart wipes in-memory state.
describe('keepAwakeAction', () => {
  it('enables when the setting is on', () => {
    expect(keepAwakeAction(true)).toBe('enable');
  });

  it('disables (revokes) unconditionally when the setting is off — the guarantee that survives an SW restart', () => {
    expect(keepAwakeAction(false)).toBe('disable');
  });
});

/**
 * Two narrow readers of Chrome's CDP rejection text. Both exist to move a
 * failure OFF the generic `error` code — whose taxonomy hint is "if it recurs
 * identically, treat it as non-retryable" — and onto a code whose hint tells
 * the agent what to actually do. Both are deliberately conservative: an
 * unmatched rejection keeps whatever classification it already had, exactly
 * like `classifyAttachError`'s always-present fallback, because mislabelling a
 * transient failure as permanent (or vice versa) is worse than not labelling it.
 */
describe('looksLikeSelectorSyntaxError', () => {
  it('recognises the malformed-CSS rejections Chrome actually emits', () => {
    for (const msg of [
      "DOM Error while querying: Failed to execute 'querySelector'",
      'Invalid selector: :has-text("Send")',
      'DOM Error while querying',
    ]) {
      expect(looksLikeSelectorSyntaxError(new Error(msg))).toBe(true);
    }
  });

  it('leaves unrelated rejections alone — a transient failure must not read as permanent', () => {
    for (const msg of [
      'Debugger is not attached to the tab with id: 7.',
      'Target closed.',
      'Session with given id not found.',
    ]) {
      expect(looksLikeSelectorSyntaxError(new Error(msg))).toBe(false);
    }
  });

  it('accepts a non-Error rejection without throwing', () => {
    expect(looksLikeSelectorSyntaxError('Invalid selector')).toBe(true);
    expect(looksLikeSelectorSyntaxError(undefined)).toBe(false);
  });
});

describe('looksLikeMissingNodeError', () => {
  it('recognises a node the page has destroyed', () => {
    for (const msg of [
      'No node with given id found',
      'Could not find node with given id',
      'Node with given id does not belong to the document',
    ]) {
      expect(looksLikeMissingNodeError(new Error(msg))).toBe(true);
    }
  });

  it('does not claim a detached debugger or a wedged tab is a stale ref', () => {
    for (const msg of [
      'Debugger is not attached to the tab with id: 7.',
      'Target closed.',
      'Invalid selector',
      'Not found', // no "node" in it at all
    ]) {
      expect(looksLikeMissingNodeError(new Error(msg))).toBe(false);
    }
  });
});

/**
 * The two shared error factories these classifiers feed. What matters is the
 * CODE (the agent branches on it) and that the message names a next step.
 */
describe('staleRefError / invalidSelectorError', () => {
  it('a destroyed node is bad_ref — the code whose hint says "re-snapshot"', () => {
    const err = staleRefError('click', '@e12');
    expect(err.code).toBe('bad_ref');
    expect(err.message).toContain('@e12');
    expect(err.message).toContain('snapshot');
  });

  it('malformed CSS is bad_args (retryable=no) and names the Playwright-isms', () => {
    const err = invalidSelectorError('fill', ':has-text("Send")');
    expect(err.code).toBe('bad_args');
    expect(err.message).toContain(':has-text');
    expect(err.message).toContain('find');
  });
});
