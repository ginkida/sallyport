/**
 * What a read of the page cannot see. `frameOrigins` is pure over a
 * `Page.getFrameTree` response; the chrome-bound half is exercised through
 * `snapshot` and `read_text` in their own files.
 */

import { describe, expect, it } from 'vitest';

import { frameOrigins } from '../src/tools/frames.js';

describe('frameOrigins', () => {
  const tree = (childFrames: unknown[]) => ({
    frameTree: { frame: { url: 'https://main.example/' }, childFrames },
  });

  it('excludes the main frame — the caller already knows the page', () => {
    expect(frameOrigins(tree([]))).toEqual([]);
  });

  it('walks nested frames and de-duplicates by origin', () => {
    expect(
      frameOrigins(
        tree([
          {
            frame: { url: 'https://a.example/one' },
            childFrames: [{ frame: { url: 'https://b.example/deep' } }],
          },
          { frame: { url: 'https://a.example/two' } },
        ]),
      ),
    ).toEqual(['https://a.example', 'https://b.example']);
  });

  it('drops the page own scaffolding', () => {
    expect(
      frameOrigins(
        tree([
          { frame: { url: 'about:blank' } },
          { frame: { url: 'data:text/html,hi' } },
          { frame: { url: 'not a url' } },
          { frame: {} },
        ]),
      ),
    ).toEqual([]);
  });

  it('is bounded, and tolerates a malformed response without throwing', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      frame: { url: `https://f${i}.example/` },
    }));
    expect(frameOrigins(tree(many), 3)).toHaveLength(3);
    expect(frameOrigins(undefined)).toEqual([]);
    expect(frameOrigins({ frameTree: 'nope' })).toEqual([]);
  });
});
