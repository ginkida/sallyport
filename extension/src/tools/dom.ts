import { attach, cdp } from './cdp.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { getRef, isRef } from './refs.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

export async function resolveSelectorOrRef(
  tabId: number,
  selector: string,
  tool: string,
): Promise<string> {
  if (isRef(selector)) {
    const r = getRef(tabId, selector);
    if (!r) {
      throw new BridgeError(
        'bad_ref',
        `${tool}: unknown ref "${selector}" for tab ${tabId} — run snapshot first`,
      );
    }
    const resolved = await cdp<{ object: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
      backendNodeId: r.backendDOMNodeId,
    });
    if (!resolved.object.objectId) {
      throw new BridgeError('bad_ref', `${tool}: could not resolve ref to DOM`);
    }
    return resolved.object.objectId;
  }
  const doc = await cdp<{ root: { nodeId: number } }>(tabId, 'DOM.getDocument', { depth: 0 });
  const q = await cdp<{ nodeId: number }>(tabId, 'DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector,
  });
  if (!q.nodeId) {
    throw new BridgeError('not_found', `${tool}: element not found: ${selector}`);
  }
  const resolved = await cdp<{ object: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
    nodeId: q.nodeId,
  });
  if (!resolved.object.objectId) {
    throw new BridgeError('not_found', `${tool}: could not resolve element`);
  }
  return resolved.object.objectId;
}

export const click: Tool = async (args) => {
  const selector = String(args.selector || '');
  if (!selector) throw new BridgeError('bad_args', 'click: selector required');
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  const objectId = await resolveSelectorOrRef(tab.id!, selector, 'click');
  const out = await cdp<{ result: { value?: { tag: string; text: string } } }>(
    tab.id!,
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration:
        "function() { this.scrollIntoView({ block: 'center' }); this.click(); " +
        "return { tag: this.tagName, text: (this.textContent || '').slice(0, 100) }; }",
      returnByValue: true,
    },
  );
  return { tabId: tab.id, url: tab.url, data: { ok: true, ...(out.result.value ?? {}) } };
};

export const fill: Tool = async (args) => {
  const selector = String(args.selector || '');
  if (!selector) throw new BridgeError('bad_args', 'fill: selector required');
  if (args.value === undefined || args.value === null) {
    throw new BridgeError('bad_args', 'fill: value required');
  }
  const value = String(args.value);
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);

  const objectId = await resolveSelectorOrRef(tab.id!, selector, 'fill');

  const probe = await cdp<{ result: { value?: { isPassword: boolean; tag: string } } }>(
    tab.id!,
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration:
        "function() { return { tag: this.tagName, isPassword: this.type === 'password' }; }",
      returnByValue: true,
    },
  );
  if (probe.result.value?.isPassword && args.allowPassword !== true) {
    throw new BridgeError(
      'password_field',
      'fill: refusing to type into <input type=password>; pass allowPassword=true to override',
    );
  }

  const fnBody = `function(v) {
    this.focus();
    if (this.isContentEditable) {
      const sel = window.getSelection();
      if (sel) {
        const r = document.createRange();
        r.selectNodeContents(this);
        sel.removeAllRanges();
        sel.addRange(r);
      }
      let inserted = false;
      try { inserted = document.execCommand('insertText', false, v); } catch (_) {}
      if (!inserted) {
        this.textContent = v;
        this.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: v, bubbles: true }));
      }
      return { tag: this.tagName, mode: 'contenteditable' };
    }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(this, v); else this.value = v;
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
    return { tag: this.tagName, mode: 'value' };
  }`;
  const out = await cdp<{ result: { value?: { tag: string; mode: string } } }>(
    tab.id!,
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: fnBody,
      arguments: [{ value }],
      returnByValue: true,
    },
  );
  return { tabId: tab.id, url: tab.url, data: { ok: true, ...(out.result.value ?? {}) } };
};

// Trimmed innerText preferred; fall back to textContent (hidden-but-present nodes).
// Pinned as a const so the ref-branch and body-branch can't drift apart.
const READ_TEXT_FN = 'function() { return (this.innerText || this.textContent || "").trim(); }';

export const readText: Tool = async (args) => {
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);

  if (typeof args.ref === 'string' && isRef(args.ref)) {
    const r = getRef(tab.id!, args.ref);
    if (!r) {
      throw new BridgeError(
        'bad_ref',
        `unknown ref "${args.ref}" for tab ${tab.id} — run snapshot first`,
      );
    }
    const resolved = await cdp<{ object: { objectId?: string } }>(tab.id!, 'DOM.resolveNode', {
      backendNodeId: r.backendDOMNodeId,
    });
    if (!resolved.object.objectId) {
      throw new BridgeError('bad_ref', 'could not resolve ref to a DOM node');
    }
    const out = await cdp<{ result: { value?: string } }>(tab.id!, 'Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration: READ_TEXT_FN,
      returnByValue: true,
    });
    return { tabId: tab.id, url: tab.url, data: { text: out.result.value ?? '' } };
  }

  const doc = await cdp<{ root: { nodeId: number } }>(tab.id!, 'DOM.getDocument', { depth: 0 });
  const bodyQ = await cdp<{ nodeId: number }>(tab.id!, 'DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: 'body',
  });
  if (!bodyQ.nodeId) return { tabId: tab.id, url: tab.url, data: { text: '' } };
  const resolved = await cdp<{ object: { objectId?: string } }>(tab.id!, 'DOM.resolveNode', {
    nodeId: bodyQ.nodeId,
  });
  if (!resolved.object.objectId) {
    return { tabId: tab.id, url: tab.url, data: { text: '' } };
  }
  const out = await cdp<{ result: { value?: string } }>(tab.id!, 'Runtime.callFunctionOn', {
    objectId: resolved.object.objectId,
    functionDeclaration: READ_TEXT_FN,
    returnByValue: true,
  });
  return { tabId: tab.id, url: tab.url, data: { text: out.result.value ?? '' } };
};
