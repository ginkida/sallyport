import { attach, cdp } from './cdp.js';
import { resolveSelectorOrRef } from './resolve.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';
import { validatePath } from './upload-path.js';

export const upload: Tool = async (args) => {
  const selector = String(args.selector || '');
  if (!selector) throw new BridgeError('bad_args', 'upload: selector required');
  const rawPaths = args.paths;
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    throw new BridgeError(
      'bad_args',
      'upload: paths must be a non-empty array of absolute file paths',
    );
  }
  const paths = rawPaths.map(validatePath);

  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  const objectId = await resolveSelectorOrRef(tab.id!, selector, 'upload');

  // Confirm the target is actually <input type=file> before handing paths to
  // CDP. setFileInputFiles silently no-ops on a wrong element; a clear
  // BridgeError is easier for the agent to recover from.
  const probe = await cdp<{ result: { value?: { tag: string; type: string } } }>(
    tab.id!,
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration:
        "function() { return { tag: this.tagName, type: (this.type || '').toLowerCase() }; }",
      returnByValue: true,
    },
  );
  const t = probe.result.value;
  if (!t || t.tag !== 'INPUT' || t.type !== 'file') {
    const tag = t?.tag ?? 'unknown';
    const typeStr = t?.type ? `[type=${t.type}]` : '';
    throw new BridgeError(
      'wrong_element',
      `upload: target is ${tag}${typeStr}, expected <input type=file>`,
    );
  }

  await cdp(tab.id!, 'DOM.setFileInputFiles', { objectId, files: paths });
  return {
    tabId: tab.id,
    url: tab.url,
    data: { ok: true, count: paths.length, files: paths },
  };
};
