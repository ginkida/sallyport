import { describe, expect, it } from 'vitest';

import { BridgeError } from '../src/tools/errors.js';
import {
  buildSpec,
  planError,
  planSelection,
  SELECT_APPLY_PROBE,
  type OptionLike,
  type SelectInput,
} from '../src/tools/select.js';

function opt(value: string, label: string, index: number, disabled = false): OptionLike {
  return { value, label, index, disabled };
}

function select(
  options: OptionLike[],
  opts: { multiple?: boolean; disabled?: boolean } = {},
): SelectInput {
  return { tagName: 'SELECT', disabled: !!opts.disabled, multiple: !!opts.multiple, options };
}

const COUNTRIES = select([
  opt('UA', 'Ukraine', 0),
  opt('PL', 'Poland', 1),
  opt('DE', 'Germany', 2),
]);

/** Run `fn` and return the thrown BridgeError, asserting it is one. */
function caught(fn: () => unknown): BridgeError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError);
    return e as BridgeError;
  }
  throw new Error('expected a BridgeError to be thrown');
}

describe('planSelection', () => {
  it('matches by value', () => {
    expect(planSelection(COUNTRIES, { by: 'value', values: ['PL'] })).toEqual({
      ok: true,
      indices: [1],
      multiple: false,
    });
  });

  it('matches by label, trimming the query', () => {
    expect(planSelection(COUNTRIES, { by: 'label', values: ['  Germany '] })).toEqual({
      ok: true,
      indices: [2],
      multiple: false,
    });
  });

  it('matches by index', () => {
    expect(planSelection(COUNTRIES, { by: 'index', indices: [0] })).toEqual({
      ok: true,
      indices: [0],
      multiple: false,
    });
  });

  it('reports not_found with the available options when nothing matches', () => {
    const plan = planSelection(COUNTRIES, { by: 'value', values: ['ZZ'] });
    expect(plan).toEqual({
      ok: false,
      code: 'not_found',
      missing: ['ZZ'],
      available: [
        { value: 'UA', label: 'Ukraine' },
        { value: 'PL', label: 'Poland' },
        { value: 'DE', label: 'Germany' },
      ],
    });
  });

  it('caps the available list at 50 entries', () => {
    const many = select(Array.from({ length: 60 }, (_, i) => opt(`v${i}`, `Label ${i}`, i)));
    const plan = planSelection(many, { by: 'value', values: ['nope'] });
    expect(plan.ok).toBe(false);
    if (!plan.ok && plan.code === 'not_found') {
      expect(plan.available).toHaveLength(50);
    }
  });

  it('flags a non-<select> target as wrong_element', () => {
    const div = { ...COUNTRIES, tagName: 'DIV' };
    expect(planSelection(div, { by: 'value', values: ['UA'] })).toEqual({
      ok: false,
      code: 'wrong_element',
      tag: 'DIV',
    });
  });

  it('refuses a disabled <select>', () => {
    const disabled = select(COUNTRIES.options, { disabled: true });
    expect(planSelection(disabled, { by: 'value', values: ['UA'] })).toEqual({
      ok: false,
      code: 'bad_args',
      reason: 'disabled',
      target: 'select',
    });
  });

  it('refuses multiple values against a single-select', () => {
    expect(planSelection(COUNTRIES, { by: 'value', values: ['UA', 'PL'] })).toEqual({
      ok: false,
      code: 'bad_args',
      reason: 'not_multiple',
    });
  });

  it('accepts a single-element array on a single-select', () => {
    expect(planSelection(COUNTRIES, { by: 'value', values: ['UA'] })).toEqual({
      ok: true,
      indices: [0],
      multiple: false,
    });
  });

  it('selects several options in order on a <select multiple>, preserving spec order', () => {
    const multi = select(COUNTRIES.options, { multiple: true });
    expect(planSelection(multi, { by: 'value', values: ['DE', 'UA'] })).toEqual({
      ok: true,
      indices: [2, 0],
      multiple: true,
    });
  });

  it('refuses a matched-but-disabled option', () => {
    const withDisabled = select([opt('UA', 'Ukraine', 0), opt('PL', 'Poland', 1, true)]);
    expect(planSelection(withDisabled, { by: 'value', values: ['PL'] })).toEqual({
      ok: false,
      code: 'bad_args',
      reason: 'disabled',
      target: 'option',
      index: 1,
    });
  });

  it('serialises to a self-contained literal (no imports/closures)', () => {
    const src = planSelection.toString();
    expect(src).not.toMatch(/\brequire\b|\bimport\b/);
    const revived = (0, eval)('(' + src + ')') as typeof planSelection;
    expect(revived(COUNTRIES, { by: 'index', indices: [2] })).toEqual({
      ok: true,
      indices: [2],
      multiple: false,
    });
  });
});

describe('SELECT_APPLY_PROBE', () => {
  it('inlines planSelection and interpolates no agent data', () => {
    expect(SELECT_APPLY_PROBE).not.toMatch(/\brequire\b|\bimport\b/);
    expect(SELECT_APPLY_PROBE).toContain('planSelection');
    expect(SELECT_APPLY_PROBE).toContain("tagName === 'SELECT'");
    // The spec is a callFunctionOn parameter, not baked into the source.
    expect(SELECT_APPLY_PROBE.startsWith('function(spec)')).toBe(true);
  });
});

describe('buildSpec', () => {
  it('parses a single value', () => {
    expect(buildSpec({ value: 'UA' })).toEqual({ by: 'value', values: ['UA'] });
  });

  it('parses a value array (multi-select)', () => {
    expect(buildSpec({ value: ['UA', 'PL'] })).toEqual({ by: 'value', values: ['UA', 'PL'] });
  });

  it('parses a single label', () => {
    expect(buildSpec({ label: 'Ukraine' })).toEqual({ by: 'label', values: ['Ukraine'] });
  });

  it('parses a single index', () => {
    expect(buildSpec({ index: 2 })).toEqual({ by: 'index', indices: [2] });
  });

  it('parses an index array', () => {
    expect(buildSpec({ index: [0, 2] })).toEqual({ by: 'index', indices: [0, 2] });
  });

  it('coerces a non-string value to its string form', () => {
    expect(buildSpec({ value: 2 })).toEqual({ by: 'value', values: ['2'] });
  });

  it('ignores explicitly-null/undefined siblings', () => {
    expect(buildSpec({ value: 'UA', label: undefined, index: null })).toEqual({
      by: 'value',
      values: ['UA'],
    });
  });

  it('rejects no spec at all', () => {
    expect(caught(() => buildSpec({})).code).toBe('bad_args');
  });

  it('rejects more than one of value/label/index', () => {
    expect(caught(() => buildSpec({ value: 'UA', index: 1 })).code).toBe('bad_args');
  });

  it('rejects a negative index', () => {
    expect(caught(() => buildSpec({ index: -1 })).code).toBe('bad_args');
  });

  it('rejects a non-integer index', () => {
    expect(caught(() => buildSpec({ index: 1.5 })).code).toBe('bad_args');
  });

  it('rejects an empty index array', () => {
    expect(caught(() => buildSpec({ index: [] })).code).toBe('bad_args');
  });

  it('rejects an empty value array', () => {
    expect(caught(() => buildSpec({ value: [] })).code).toBe('bad_args');
  });
});

describe('planError → structured detail (select_option)', () => {
  it('not_found carries {missing, available} so the agent can re-issue programmatically', () => {
    const err = planError({
      ok: false,
      code: 'not_found',
      missing: ['x'],
      available: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.code).toBe('not_found');
    expect(err.detail).toEqual({
      missing: ['x'],
      available: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
  });

  it('attaches NO detail to wrong_element / bad_args failures', () => {
    expect(planError({ ok: false, code: 'wrong_element', tag: 'DIV' }).detail).toBeUndefined();
    expect(
      planError({ ok: false, code: 'bad_args', reason: 'not_multiple' }).detail,
    ).toBeUndefined();
    expect(
      planError({ ok: false, code: 'bad_args', reason: 'disabled', target: 'select' }).detail,
    ).toBeUndefined();
    expect(
      planError({ ok: false, code: 'bad_args', reason: 'disabled', target: 'option', index: 2 })
        .detail,
    ).toBeUndefined();
  });

  it('detail mirrors only static <option> value/label — never a field value (by construction)', () => {
    const err = planError({
      ok: false,
      code: 'not_found',
      missing: ['nope'],
      available: [{ value: 'us', label: 'United States' }],
    });
    const detail = err.detail as { available: { value: string; label: string }[] };
    for (const o of detail.available) {
      expect(Object.keys(o).sort()).toEqual(['label', 'value']);
    }
  });
});

describe('BridgeError detail (by construction)', () => {
  it('defaults to undefined when not provided (so password gates carry none)', () => {
    expect(
      new BridgeError('password_field', 'refusing to type into a password field').detail,
    ).toBeUndefined();
    expect(new BridgeError('bad_args', 'x').detail).toBeUndefined();
  });

  it('stores a provided structural detail', () => {
    expect(new BridgeError('not_found', 'x', { available: [] }).detail).toEqual({ available: [] });
  });
});

describe('SELECT_APPLY_PROBE — the result must describe the ELEMENT, not the plan', () => {
  type Opt = {
    value: string;
    label?: string;
    text?: string;
    selected: boolean;
    disabled?: boolean;
  };

  /** A `<select>` faithful enough for the probe: options that record their own
   * `selected` flag, a prototype value setter, and event dispatch a test can
   * hook to simulate a page that fights back. */
  function fakeSelect(
    opts: Array<Partial<Opt> & { value: string }>,
    over: Record<string, unknown> = {},
  ) {
    const options = opts.map((o) => ({
      label: o.value,
      text: o.value,
      selected: false,
      disabled: false,
      ...o,
    }));
    const el: Record<string, unknown> = {
      tagName: 'SELECT',
      disabled: false,
      multiple: false,
      isConnected: true,
      options,
      get value() {
        const sel = options.find((o) => o.selected);
        return sel ? sel.value : '';
      },
      dispatchEvent: () => true,
      ...over,
    };
    return { el, options };
  }

  /** Run the probe against a fake element, with the globals it reaches for. */
  function runProbe(el: unknown, spec: unknown): Record<string, unknown> {
    const setValue = function (this: { options: Opt[] }, v: string) {
      for (const o of this.options) o.selected = o.value === v;
    };
    const win = {
      HTMLSelectElement: { prototype: {} },
    } as unknown as { HTMLSelectElement: { prototype: Record<string, unknown> } };
    Object.defineProperty(win.HTMLSelectElement.prototype, 'value', {
      set: setValue,
      configurable: true,
    });
    const fn = new Function('window', 'Event', `return (${SELECT_APPLY_PROBE});`)(
      win,
      class {
        constructor(readonly type: string) {}
      },
    ) as (this: unknown, spec: unknown) => Record<string, unknown>;
    return fn.call(el, spec);
  }

  it('reports applied:yes and the element own selection on a normal change', () => {
    const { el } = fakeSelect([{ value: 'UA' }, { value: 'PL' }]);
    const out = runProbe(el, { by: 'value', values: ['PL'] });
    expect(out).toMatchObject({
      ok: true,
      applied: 'yes',
      selected: [{ index: 1, value: 'PL' }],
    });
  });

  it('catches a page that resets the value in its own change handler', () => {
    // The failure this exists for: the old result echoed the PLAN, so a select
    // that snapped back still answered ok:true with the option you asked for
    // while the page showed the old one.
    const { el, options } = fakeSelect([{ value: 'UA' }, { value: 'PL' }]);
    (el as { dispatchEvent: () => boolean }).dispatchEvent = () => {
      for (const o of options) o.selected = o.value === 'UA'; // the page says no
      return true;
    };
    const out = runProbe(el, { by: 'value', values: ['PL'] });
    expect(out.applied).toBe('no');
    // ...and it says what is actually selected now, which is the useful fact.
    expect(out.selected).toEqual([{ index: 0, value: 'UA', label: 'UA' }]);
  });

  it('claims nothing when the node was detached by the change handler', () => {
    const { el } = fakeSelect([{ value: 'UA' }, { value: 'PL' }]);
    (el as { dispatchEvent: () => boolean }).dispatchEvent = () => {
      (el as { isConnected: boolean }).isConnected = false; // re-rendered away
      return true;
    };
    const out = runProbe(el, { by: 'value', values: ['PL'] });
    // 'unclear' means UNVERIFIED, not failed: the write may well have landed on
    // a node the page has since replaced. The plan is echoed, nothing claimed.
    expect(out.applied).toBe('unclear');
    expect(out.selected).toEqual([{ index: 1, value: 'PL', label: 'PL' }]);
  });

  it('reads a multi-select back as a set, not as the plan', () => {
    const { el, options } = fakeSelect([{ value: 'A' }, { value: 'B' }, { value: 'C' }], {
      multiple: true,
    });
    (el as { dispatchEvent: () => boolean }).dispatchEvent = () => {
      options[2].selected = true; // the page adds one of its own
      return true;
    };
    const out = runProbe(el, { by: 'value', values: ['A', 'B'] });
    expect(out.applied).toBe('no');
    expect((out.selected as Array<{ value: string }>).map((o) => o.value)).toEqual(['A', 'B', 'C']);
  });

  it('still refuses a non-select before touching anything', () => {
    const out = runProbe({ tagName: 'DIV' }, { by: 'value', values: ['x'] });
    expect(out).toMatchObject({ ok: false, code: 'wrong_element' });
  });
});
