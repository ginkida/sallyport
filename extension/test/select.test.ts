import { describe, expect, it } from 'vitest';

import { BridgeError } from '../src/tools/errors.js';
import {
  buildSpec,
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
