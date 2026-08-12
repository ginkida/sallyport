/**
 * The tool graph must stay acyclic.
 *
 * This project keeps breaking cycles by hand — `poll.ts` exists to break
 * dom↔wait, `resolve.ts` and `tab-resolve.ts` exist to keep `snapshot.ts` off
 * `dom.ts` and `tabs.ts` so the action tools can import the snapshot-building
 * `observe.ts`. Each of those was a comment claiming the graph was fixed, and
 * one of them was wrong for a while: extracting the resolver left
 * snapshot.ts → tabs.ts → observe.ts → snapshot.ts intact, because `tabs.ts`
 * had by then grown an import of `observe.ts`.
 *
 * ES modules tolerate cycles, which is exactly why this needs a test: nothing
 * fails loudly, it just becomes fragile — a binding used at module-init time
 * lands in the temporal dead zone and the failure surfaces far from its cause.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = new URL('../src/', import.meta.url).pathname;

/** Every local import of a file, as repo-relative module keys. */
function localImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+'(\.[^']+)'/g;
  for (const m of text.matchAll(re)) {
    out.push(m[1].replace(/\.js$/, '').replace(/^\.\//, ''));
  }
  return out;
}

function buildGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith('.ts')) {
        const key = `${prefix}${entry.name.replace(/\.ts$/, '')}`;
        const deps = localImports(join(dir, entry.name)).map((d) =>
          d.startsWith('../') ? d.slice(3) : `${prefix}${d}`,
        );
        graph.set(key, deps);
      }
    }
  };
  walk(SRC, '');
  return graph;
}

/** Every cycle reachable in the graph, each reported as a readable path. */
function findCycles(graph: Map<string, string[]>): string[] {
  const cycles: string[] = [];
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const visit = (node: string) => {
    if (state.get(node) === 'done') return;
    if (state.get(node) === 'open') {
      cycles.push([...stack.slice(stack.indexOf(node)), node].join(' → '));
      return;
    }
    state.set(node, 'open');
    stack.push(node);
    for (const dep of graph.get(node) ?? []) visit(dep);
    stack.pop();
    state.set(node, 'done');
  };
  for (const node of graph.keys()) visit(node);
  return cycles;
}

describe('module graph', () => {
  it('sees the real modules (guards against a broken parser passing trivially)', () => {
    const graph = buildGraph();
    expect(graph.has('tools/observe')).toBe(true);
    expect(graph.get('tools/observe')).toContain('tools/snapshot');
    expect(graph.get('tools/dom')).toContain('tools/observe');
  });

  it('has no import cycles', () => {
    expect(findCycles(buildGraph())).toEqual([]);
  });

  it('keeps the leaf modules leaves — they are what the cycle-breaking rests on', () => {
    const graph = buildGraph();
    for (const leaf of ['tools/text', 'tools/resolve', 'tools/tab-resolve']) {
      // A leaf may lean on errors/cdp/refs, but must never reach a tool module
      // that could climb back up through snapshot/observe.
      for (const dep of graph.get(leaf) ?? []) {
        expect(['tools/errors', 'tools/cdp', 'tools/refs', 'tools/text']).toContain(dep);
      }
    }
  });
});
