import { attach, cdp } from './cdp.js';
import { resolveSelectorOrRef } from './resolve.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';
import { validatePath } from './upload-path.js';

/** What the target element IS, read before handing it any paths.
 *
 * FIXED literal — the paths travel to `DOM.setFileInputFiles` as structured CDP
 * arguments and never touch a function body, so this needs no `allowEvaluate`.
 * `multiple` comes back too: an input without it takes exactly one file, and
 * sending several used to look like a success that half-happened. */
export const UPLOAD_TARGET_PROBE =
  "function() { return { tag: this.tagName, type: (this.type || '').toLowerCase()," +
  ' multiple: !!this.multiple }; }';

/** What the element HOLDS afterwards.
 *
 * `setFileInputFiles` dispatches `input` and `change`, so the page gets to
 * react — and a handler that rejects the file (wrong type, too large, a quota)
 * can clear the input in the same tick. The old result echoed the paths it had
 * SENT, so that rejection came back as `ok:true` with the file listed, and the
 * agent went on to submit a form with nothing attached. Names only, never
 * content: the agent supplied the paths, so nothing new is disclosed. */
export const UPLOAD_READBACK_PROBE =
  'function() {' +
  ' if (this.isConnected === false) return null;' +
  ' var out = []; var f = this.files;' +
  ' if (!f) return null;' +
  ' for (var i = 0; i < f.length; i++) out.push(f[i].name);' +
  ' return { names: out }; }';

/** Did the element end up holding what we sent it?
 *
 * Pure so the classification is unit-tested rather than inferred. `unclear`
 * means UNVERIFIED, not failed — the node was replaced or unreadable right
 * after the write, which a re-rendering page does routinely. */
export function classifyUpload(
  sent: string[],
  held: { names: string[] } | null,
): { applied: 'yes' | 'no' | 'unclear'; accepted?: string[] } {
  if (!held) return { applied: 'unclear' };
  const want = sent.map((p) => p.split('/').pop() ?? p);
  const same = held.names.length === want.length && held.names.every((name, i) => name === want[i]);
  return { applied: same ? 'yes' : 'no', accepted: held.names };
}

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
  const probe = await cdp<{ result: { value?: { tag: string; type: string; multiple: boolean } } }>(
    tab.id!,
    'Runtime.callFunctionOn',
    { objectId, functionDeclaration: UPLOAD_TARGET_PROBE, returnByValue: true },
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
  if (paths.length > 1 && !t.multiple) {
    // Refuse rather than half-attach: the same call for the same reason as
    // select_option's not_multiple.
    throw new BridgeError(
      'bad_args',
      `upload: this <input type=file> takes ONE file (no multiple attribute) but ${paths.length} ` +
        `paths were given — send them one at a time, or target an input that accepts several`,
    );
  }

  await cdp(tab.id!, 'DOM.setFileInputFiles', { objectId, files: paths });

  // Read the element back. Synchronous, like fill's and select_option's
  // readbacks and for the same reason: rAF and timers are throttled in a
  // background tab, so a driven tab in an unfocused agent window would hang
  // instead of answering. A page that clears the input a tick later shows up on
  // the agent's next read.
  const back = await cdp<{ result: { value?: { names: string[] } | null } }>(
    tab.id!,
    'Runtime.callFunctionOn',
    { objectId, functionDeclaration: UPLOAD_READBACK_PROBE, returnByValue: true },
  ).catch(() => ({ result: { value: null } }));
  const verdict = classifyUpload(paths, back.result.value ?? null);

  return {
    tabId: tab.id,
    url: tab.url,
    data: { ok: true, count: paths.length, files: paths, ...verdict },
  };
};
