/** `select_option` — drive a native `<select>` without opening the OS popup.
 *
 * A native `<select>`'s dropdown is rendered by the operating system's menu
 * layer (macOS `NSMenu`, the Windows combo listbox), NOT by the page renderer.
 * CDP `Input.*` events inject into Blink's renderer input pipeline, which has
 * yielded focus to the platform UI while the menu is up — so synthesized keys
 * are ignored and the only event the menu honours is a dismiss (`Escape`
 * closes it). The OS menu has no DOM node, no `objectId`, no page-reachable
 * a11y node: there is no CDP surface for it at all. Every mature framework
 * (Playwright `selectOption`, Selenium `Select`, Cypress `.select()`) therefore
 * never opens the popup — it mutates the `<select>` in the DOM and fires
 * `input` + `change`, which is exactly what this tool does.
 *
 * Trust shape: allowlist-gated (it is an action tool) but NO `allowEvaluate`.
 * `SELECT_APPLY_PROBE` is a FIXED literal built from `planSelection.toString()`
 * (our code), and the chosen value/label/index travel only as a structured
 * `Runtime.callFunctionOn` argument (`spec`), never by string interpolation —
 * the same trust shape as the aim probes (`aim.ts`) and `fill`'s value setter,
 * so no per-domain evaluate flag is required.
 *
 * `planSelection` and `buildSpec` are pure (no `chrome.*`, no DOM) so vitest
 * drives the matching/validation logic standalone; the thin DOM mutation lives
 * in the serialised probe and is covered on the wire by the e2e harness, the
 * same split `aim.ts` ↔ `mouse.ts` uses.
 */

import { attach, cdp } from './cdp.js';
import { resolveSelectorOrRef } from './resolve.js';
import { BridgeError } from './errors.js';
import { ensureAllowed } from './gates.js';
import { parseObserve, runObserve } from './observe.js';
import { parseWaitFor, runEmbeddedWait } from './poll.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

/** One `<option>` reduced to the fields matching needs. `label` is the visible
 * text already trimmed (`option.label || option.text`). */
export interface OptionLike {
  value: string;
  label: string;
  index: number;
  disabled: boolean;
}

/** A `<select>` reduced to what the pure planner needs — extracted page-side. */
export interface SelectInput {
  tagName: string | null;
  disabled: boolean;
  multiple: boolean;
  options: OptionLike[];
}

/** How the agent named the option(s) to choose. Arrays only select more than
 * one on a `<select multiple>`. */
export type SelectSpec =
  | { by: 'value'; values: string[] }
  | { by: 'label'; values: string[] }
  | { by: 'index'; indices: number[] };

/** Every way a selection can be refused. Shared by the pure planner and the
 * page probe so the error vocabulary is one source of truth. */
export type SelectFailure =
  | { ok: false; code: 'wrong_element'; tag: string | null }
  | {
      ok: false;
      code: 'not_found';
      missing: string[];
      available: { value: string; label: string }[];
    }
  | { ok: false; code: 'bad_args'; reason: 'not_multiple' }
  | { ok: false; code: 'bad_args'; reason: 'disabled'; target: 'select' }
  | { ok: false; code: 'bad_args'; reason: 'disabled'; target: 'option'; index: number };

/** The planner's verdict: concrete option indices to select, or a failure. */
export type SelectionPlan = { ok: true; indices: number[]; multiple: boolean } | SelectFailure;

/** What the page probe returns after applying the selection. */
type ApplyResult =
  | {
      ok: true;
      tag: string;
      multiple: boolean;
      /** What the element actually holds after the change events — or, when
       * `applied` is 'unclear', the plan, since nothing could be read back. */
      selected: { index: number; value: string; label: string }[];
      applied: 'yes' | 'no' | 'unclear';
    }
  | SelectFailure;

/** Resolve a spec to the option indices to select, validating along the way.
 *
 * PURE and SELF-CONTAINED — it is serialised into the page probe via
 * `.toString()`, so it must reference no imports, no module-level symbols and
 * no closures (only its params and the `String` global). Decides single-vs-
 * multiple from the element (`input.multiple`), not the arg arity, so a single-
 * element array against a single-select is fine; 2+ entries against a single-
 * select is the explicit `not_multiple` error. */
export function planSelection(input: SelectInput, spec: SelectSpec): SelectionPlan {
  if (input.tagName !== 'SELECT') {
    return { ok: false, code: 'wrong_element', tag: input.tagName };
  }
  if (input.disabled) {
    return { ok: false, code: 'bad_args', reason: 'disabled', target: 'select' };
  }
  const keys: Array<string | number> = spec.by === 'index' ? spec.indices : spec.values;
  if (keys.length > 1 && !input.multiple) {
    return { ok: false, code: 'bad_args', reason: 'not_multiple' };
  }
  const indices: number[] = [];
  const missing: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    let hit: OptionLike | null = null;
    for (let j = 0; j < input.options.length; j++) {
      const o = input.options[j];
      if (spec.by === 'value' && o.value === key) {
        hit = o;
        break;
      }
      if (spec.by === 'label' && o.label === String(key).trim()) {
        hit = o;
        break;
      }
      if (spec.by === 'index' && o.index === key) {
        hit = o;
        break;
      }
    }
    if (hit) indices.push(hit.index);
    else missing.push(String(key));
  }
  if (missing.length > 0) {
    const available: { value: string; label: string }[] = [];
    for (let k = 0; k < input.options.length && k < 50; k++) {
      available.push({ value: input.options[k].value, label: input.options[k].label });
    }
    return { ok: false, code: 'not_found', missing, available };
  }
  for (let m = 0; m < indices.length; m++) {
    if (input.options[indices[m]].disabled) {
      return {
        ok: false,
        code: 'bad_args',
        reason: 'disabled',
        target: 'option',
        index: indices[m],
      };
    }
  }
  return { ok: true, indices, multiple: input.multiple };
}

/** FIXED literal. `planSelection` is OUR serialised code; the chosen
 * value/label/index arrive only as the structured `spec` argument, never
 * interpolated — so the probe needs no `allowEvaluate`. Single-select uses the
 * native `HTMLSelectElement.prototype` value setter (the React-safe path `fill`
 * uses); multi-select sets `option.selected`. Fires bubbling `input` + `change`
 * so frameworks react as if a human chose the option. */
const SELECT_APPLY_PROBE = `function(spec) {
  var planSelection = ${planSelection.toString()};
  var el = this;
  var input;
  if (el && el.tagName === 'SELECT') {
    var opts = [];
    for (var i = 0; i < el.options.length; i++) {
      var o = el.options[i];
      opts.push({ value: o.value, label: (o.label || o.text || '').trim(), index: i, disabled: !!o.disabled });
    }
    input = { tagName: 'SELECT', disabled: !!el.disabled, multiple: !!el.multiple, options: opts };
  } else {
    input = { tagName: el ? el.tagName : null, disabled: false, multiple: false, options: [] };
  }
  var plan = planSelection(input, spec);
  if (!plan.ok) return plan;
  if (input.multiple) {
    for (var j = 0; j < el.options.length; j++) el.options[j].selected = false;
    for (var k = 0; k < plan.indices.length; k++) el.options[plan.indices[k]].selected = true;
  } else {
    var desc = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
    var target = input.options[plan.indices[0]].value;
    if (desc && desc.set) desc.set.call(el, target);
    else el.value = target;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  var selected = [];
  var applied = 'unclear';
  try {
    if (el.isConnected === false) {
      applied = 'unclear';
    } else {
      for (var m = 0; m < el.options.length; m++) {
        if (el.options[m].selected) {
          var got = el.options[m];
          selected.push({ index: m, value: got.value, label: (got.label || got.text || '').trim() });
        }
      }
      var same = selected.length === plan.indices.length;
      if (same) {
        for (var n = 0; n < plan.indices.length; n++) {
          if (selected[n].index !== plan.indices[n]) { same = false; break; }
        }
      }
      applied = same ? 'yes' : 'no';
    }
  } catch (e) {
    applied = 'unclear';
  }
  if (applied === 'unclear') {
    selected = [];
    for (var q = 0; q < plan.indices.length; q++) {
      var ix = plan.indices[q];
      selected.push({ index: ix, value: input.options[ix].value, label: input.options[ix].label });
    }
  }
  return { ok: true, tag: 'SELECT', multiple: input.multiple, selected: selected, applied: applied };
}`;

// Exported only so the self-containment vitest can assert the probe carries no
// import/closure leakage (mirrors aim.test.ts's serialisation checks).
export { SELECT_APPLY_PROBE };

function toArray(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : [v];
}

/** Parse `select_option`'s option spec from the raw args. Enforces exactly one
 * of value/label/index (JSON-Schema can't express that cleanly across three
 * keys, so it's validated here — same convention as the rest of the codebase).
 * PURE so the validation is unit-tested without a chrome tab. */
export function buildSpec(args: Record<string, unknown>): SelectSpec {
  const present = (['value', 'label', 'index'] as const).filter(
    (k) => args[k] !== undefined && args[k] !== null,
  );
  if (present.length === 0) {
    throw new BridgeError('bad_args', 'select_option: one of value, label, or index is required');
  }
  if (present.length > 1) {
    throw new BridgeError(
      'bad_args',
      `select_option: give exactly one of value/label/index (got: ${present.join(', ')})`,
    );
  }
  const key = present[0];
  if (key === 'index') {
    const indices = toArray(args.index).map((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) {
        throw new BridgeError(
          'bad_args',
          'select_option: index must be a non-negative integer (or an array of them)',
        );
      }
      return n;
    });
    if (indices.length === 0) {
      throw new BridgeError('bad_args', 'select_option: index array must be non-empty');
    }
    return { by: 'index', indices };
  }
  // value/label: coerce to string (option.value is always a string in the DOM;
  // a numeric value/label is matched by its string form, like `fill` coerces).
  const values = toArray(args[key]).map((v) => String(v));
  if (values.length === 0) {
    throw new BridgeError('bad_args', `select_option: ${key} array must be non-empty`);
  }
  return { by: key, values };
}

/** Map a page-side failure to a `BridgeError` with a stable code the daemon
 * forwards. `wrong_element` actively routes the agent to the click/find/reveal
 * flow for custom (non-`<select>`) comboboxes. `not_found` additionally carries
 * a structured `detail` so the agent can re-issue programmatically instead of
 * regexing the option list back out of the prose. Exported for the unit test
 * that pins the detail shape + the no-detail-on-other-failures contract. */
export function planError(f: SelectFailure): BridgeError {
  if (f.code === 'wrong_element') {
    const tag = (f.tag ?? 'unknown').toLowerCase();
    return new BridgeError(
      'wrong_element',
      `select_option: target is <${tag}>, not a native <select>. This looks like a custom JS ` +
        `combobox (react-select, MUI, Radix, …) which lives in the DOM — open it with ` +
        `click/mouse_click, then choose the option with click (use find/reveal to locate it; ` +
        `reveal handles virtualized lists).`,
    );
  }
  if (f.code === 'not_found') {
    const avail = f.available
      .map((o) => (o.label && o.label !== o.value ? `${o.value} (${o.label})` : o.value))
      .join(', ');
    return new BridgeError(
      'not_found',
      `select_option: no <option> matched ${JSON.stringify(f.missing)}. Available: [${avail}]`,
      // Structured echo of the SAME data so the agent can re-issue without
      // regexing the prose. Only the missing keys + each <option>'s static
      // value/label (already capped at 50 in planSelection) — never a field's
      // live `.value`, so no password-readback channel.
      { missing: f.missing, available: f.available },
    );
  }
  // f.code === 'bad_args'
  if (f.reason === 'not_multiple') {
    return new BridgeError(
      'bad_args',
      'select_option: multiple values were given but the target <select> is not a multi-select',
    );
  }
  if (f.target === 'select') {
    return new BridgeError('bad_args', 'select_option: the target <select> is disabled');
  }
  return new BridgeError(
    'bad_args',
    `select_option: the matched option at index ${f.index} is disabled`,
  );
}

export const selectOption: Tool = async (args) => {
  const selector = String(args.selector || '');
  if (!selector) throw new BridgeError('bad_args', 'select_option: selector required');
  const spec = buildSpec(args);
  const waitSpec = parseWaitFor(args.waitFor, 'select_option');
  const observeSpec = parseObserve(args.observe, 'select_option');

  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  const objectId = await resolveSelectorOrRef(tab.id!, selector, 'select_option');

  const out = await cdp<{ result: { value?: ApplyResult } }>(tab.id!, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: SELECT_APPLY_PROBE,
    arguments: [{ value: spec }],
    returnByValue: true,
  });
  const r = out.result.value;
  if (!r) {
    throw new BridgeError('not_found', 'select_option: could not read the target element');
  }
  if (!r.ok) throw planError(r);

  const wait = waitSpec ? await runEmbeddedWait(tab.id!, waitSpec) : null;
  const observed = observeSpec ? await runObserve(tab.id!, observeSpec) : null;
  return {
    tabId: tab.id,
    url: tab.url,
    data: {
      ok: true,
      tag: r.tag,
      multiple: r.multiple,
      // What the element HOLDS, not what was asked for — see SELECT_APPLY_PROBE.
      selected: r.selected,
      applied: r.applied,
      ...(wait ? { wait } : {}),
      ...(observed ? { observed } : {}),
    },
  };
};
