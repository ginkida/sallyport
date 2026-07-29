import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Structural check on the popup: every element id `popup.ts` reaches for must
 * exist in `popup.html`.
 *
 * The `$` helper is `document.querySelector(sel) as T` — it returns null for a
 * missing id and TypeScript is told otherwise by the cast, so a typo or a
 * half-landed HTML edit compiles, type-checks, lints, and then throws
 * `TypeError: null is not an object` the moment that panel is opened. That is
 * exactly what happened while adding the close-on-disconnect toggle: the
 * `popup.ts` half landed and the `popup.html` half did not, and nothing caught
 * it until the file was read by hand. Nothing else in the suite touches the
 * popup markup (it needs a DOM), so this pairing is otherwise unverified.
 */

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function idsInHtml(html: string): Set<string> {
  return new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
}

/** Ids `popup.ts` looks up via the `$('#id')` helper. Only plain literal
 * selectors — a computed one could not be checked statically anyway. */
function idsUsedInTs(ts: string): Set<string> {
  return new Set([...ts.matchAll(/\$\(\s*'#([A-Za-z0-9_-]+)'/g)].map((m) => m[1]));
}

describe('popup.ts <-> popup.html wiring', () => {
  it('every id popup.ts looks up exists in popup.html', () => {
    const html = read('../popup.html');
    const ts = read('../src/popup.ts');

    const available = idsInHtml(html);
    const used = idsUsedInTs(ts);

    // Sanity: the extractors actually found something, so a regex that silently
    // stops matching can't make this test vacuously pass.
    expect(available.size).toBeGreaterThan(20);
    expect(used.size).toBeGreaterThan(20);

    const missing = [...used].filter((id) => !available.has(id)).sort();
    expect(missing).toEqual([]);
  });
});
