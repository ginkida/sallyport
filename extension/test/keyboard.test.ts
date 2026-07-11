import { describe, expect, it } from 'vitest';

import { ensureNotPasswordField, segmentTypesText } from '../src/tools/keyboard.js';

// The password gate on send_keys re-probes before every character-typing segment
// (after the first), so a `<focus-mover> secret` sequence can't land the
// credential in a password field the one-shot up-front probe never saw
// (invariant #5). segmentTypesText decides which segments deposit a character —
// deliberately NOT an enumeration of focus-movers, because Space/Enter activate
// the focused control and site JS can .focus() on any key.
describe('segmentTypesText', () => {
  it('is true for keys that deposit a character', () => {
    // letters, digits, space, enter/return all resolve to `text`.
    for (const k of ['s', 'A', '5', 'space', 'Space', 'enter', 'return', 'shift+a', 'shift+5']) {
      expect(segmentTypesText(k)).toBe(true);
    }
  });

  it('is false for navigation/edit keys that move focus or edit but type no char', () => {
    for (const k of [
      'tab',
      'Tab',
      'shift+tab',
      'escape',
      'esc',
      'backspace',
      'delete',
      'arrowup',
      'ArrowDown',
      'home',
      'end',
      'pageup',
      'pagedown',
      'f5',
    ]) {
      expect(segmentTypesText(k)).toBe(false);
    }
  });

  it('is false for command chords (a non-shift modifier is a command, not text)', () => {
    for (const k of ['mod+a', 'ctrl+c', 'cmd+v', 'alt+a', 'ctrl+shift+tab', 'ctrl+shift+a']) {
      expect(segmentTypesText(k)).toBe(false);
    }
  });

  it('resolves on the TERMINAL key of a chord', () => {
    expect(segmentTypesText('shift+a')).toBe(true); // shift is allowed; 'a' types
    expect(segmentTypesText('tab+a')).toBe(false); // 'tab' in a modifier slot => command
  });

  it('is empty/whitespace/unknown-key safe (fails closed to false)', () => {
    expect(segmentTypesText('')).toBe(false);
    expect(segmentTypesText('+')).toBe(false);
    expect(segmentTypesText('  s  ')).toBe(true);
    expect(segmentTypesText('  tab  ')).toBe(false);
    expect(segmentTypesText('notarealkey')).toBe(false); // resolveKey throws -> false
  });
});

type CDPResponder = (
  method: string,
  params?: Record<string, unknown>,
  source?: { tabId: number; sessionId?: string },
) => unknown;

function installCdpResponder(respond: CDPResponder): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    debugger: {
      async sendCommand(
        _source: { tabId: number },
        method: string,
        params?: Record<string, unknown>,
      ) {
        return respond(method, params, _source);
      },
    },
  };
}

const focusedAxNode = (backendDOMNodeId: number): Record<string, unknown> => ({
  backendDOMNodeId,
  properties: [{ name: 'focused', value: { type: 'boolean', value: true } }],
});

describe('ensureNotPasswordField — CDP focus walk', () => {
  it('blocks a password input focused inside a cross-origin child frame', async () => {
    installCdpResponder((method, params) => {
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'top' },
            childFrames: [{ frame: { id: 'cross-origin-child' } }],
          },
        };
      }
      if (method === 'Accessibility.getFullAXTree') {
        return params?.frameId === 'top'
          ? { nodes: [focusedAxNode(10)] }
          : { nodes: [focusedAxNode(20)] };
      }
      if (method === 'DOM.describeNode') {
        return params?.backendNodeId === 20
          ? { node: { nodeName: 'INPUT', attributes: ['type', 'password'] } }
          : { node: { nodeName: 'IFRAME', attributes: [] } };
      }
      throw new Error(`unexpected command: ${method}`);
    });

    await expect(ensureNotPasswordField(1, false, 'key_type')).rejects.toMatchObject({
      code: 'password_field',
    });
  });

  it('routes a site-isolated OOPIF through its flat child session', async () => {
    const calls: Array<{ method: string; sessionId?: string }> = [];
    installCdpResponder((method, params, source) => {
      calls.push({ method, sessionId: source?.sessionId });
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'top' },
            childFrames: [{ frame: { id: 'oopif-target' } }],
          },
        };
      }
      if (method === 'Accessibility.getFullAXTree' && params?.frameId === 'top') {
        return { nodes: [focusedAxNode(10)] };
      }
      if (method === 'Accessibility.getFullAXTree' && params?.frameId === 'oopif-target') {
        throw new Error('Frame with the given frameId is not found');
      }
      if (method === 'Target.getTargets') {
        return { targetInfos: [{ targetId: 'oopif-target', type: 'iframe' }] };
      }
      if (method === 'Target.attachToTarget') return { sessionId: 'child-session' };
      if (method === 'Accessibility.getFullAXTree' && source?.sessionId === 'child-session') {
        return { nodes: [focusedAxNode(20)] };
      }
      if (method === 'DOM.describeNode' && source?.sessionId === 'child-session') {
        return { node: { nodeName: 'INPUT', attributes: ['type', 'password'] } };
      }
      if (method === 'DOM.describeNode') return { node: { nodeName: 'IFRAME', attributes: [] } };
      if (method === 'Target.detachFromTarget') return {};
      throw new Error(`unexpected command: ${method}`);
    });

    await expect(ensureNotPasswordField(1, false, 'key_type')).rejects.toMatchObject({
      code: 'password_field',
    });
    expect(calls).toContainEqual({
      method: 'Accessibility.getFullAXTree',
      sessionId: 'child-session',
    });
    expect(calls.at(-1)).toEqual({ method: 'Target.detachFromTarget', sessionId: undefined });
  });

  it('blocks a password input exposed by AX inside a closed shadow root', async () => {
    installCdpResponder((method) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } };
      if (method === 'Accessibility.getFullAXTree') return { nodes: [focusedAxNode(30)] };
      if (method === 'DOM.describeNode') {
        return { node: { nodeName: 'INPUT', attributes: ['type', 'PASSWORD'] } };
      }
      throw new Error(`unexpected command: ${method}`);
    });

    await expect(ensureNotPasswordField(1, false, 'send_keys')).rejects.toMatchObject({
      code: 'password_field',
    });
  });

  it('allows a fully described focused text input', async () => {
    installCdpResponder((method) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } };
      if (method === 'Accessibility.getFullAXTree') return { nodes: [focusedAxNode(40)] };
      if (method === 'DOM.describeNode') {
        return { node: { nodeName: 'INPUT', attributes: ['type', 'text'] } };
      }
      throw new Error(`unexpected command: ${method}`);
    });

    await expect(ensureNotPasswordField(1, false, 'key_type')).resolves.toBeUndefined();
  });

  it('fails closed when any frame response is malformed', async () => {
    installCdpResponder((method) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } };
      if (method === 'Accessibility.getFullAXTree') return { nodes: undefined };
      throw new Error(`unexpected command: ${method}`);
    });

    await expect(ensureNotPasswordField(1, false, 'key_type')).rejects.toMatchObject({
      code: 'focus_probe_failed',
    });
  });

  it('skips every CDP probe only with the explicit allowPassword override', async () => {
    installCdpResponder(() => {
      throw new Error('must not be called');
    });
    await expect(ensureNotPasswordField(1, true, 'key_type')).resolves.toBeUndefined();
  });
});
