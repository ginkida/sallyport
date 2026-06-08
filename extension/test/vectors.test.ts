/**
 * Cross-language canonical-JSON / HMAC vectors.
 *
 * Reads the SAME `fixtures/canonical-vectors.json` file that the daemon's
 * pytest suite reads, then asserts the extension's canonicalJson() and a
 * Node `createHmac` (used as a stand-in for any HMAC-SHA256) produce byte-
 * identical output.
 *
 * If this file goes red against an unchanged fixture, our TS code drifted.
 * If the fixture itself is regenerated, both this and the matching pytest
 * file must re-pin in lock-step.
 */

import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/protocol.js';

type Vector = {
  name: string;
  input: unknown;
  canonical: string;
  mac_b64: string;
};

const VECTORS_PATH = resolve(__dirname, '..', '..', 'fixtures', 'canonical-vectors.json');
const VECTORS: Vector[] = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));

const SECRET = Buffer.alloc(32, 0); // 32 zero bytes, same as the daemon side.

describe('cross-language canonical-JSON vectors', () => {
  it('the fixture file is non-empty and has unique names', () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(10);
    const names = VECTORS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(VECTORS.map((v) => [v.name, v]))(
    'canonicalJson(%s) matches the pinned fixture',
    (_name, vec) => {
      expect(canonicalJson(vec.input)).toBe(vec.canonical);
    },
  );

  it.each(VECTORS.map((v) => [v.name, v]))(
    'HMAC-SHA256(%s) over canonical bytes matches the pinned MAC',
    (_name, vec) => {
      const mac = createHmac('sha256', SECRET).update(vec.canonical, 'utf8').digest('base64');
      expect(mac).toBe(vec.mac_b64);
    },
  );
});
