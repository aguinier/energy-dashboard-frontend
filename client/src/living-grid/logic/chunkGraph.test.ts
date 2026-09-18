import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The d3 packages that must ship as one chunk.
 *
 * This is not a preference. `d3-zoom` imports `d3-transition`, `d3-transition`
 * imports `d3-selection`, and `d3-transition`'s whole contribution is the two
 * lines
 *
 *   selection.prototype.interrupt = …
 *   selection.prototype.transition = …
 *
 * run for their side effect. Put `d3-transition` in a different chunk from
 * `d3-selection` and the two chunks import each other; a circular chunk is
 * evaluated innermost-first, so those lines land on the prototype object that
 * `d3-selection` is about to replace with
 *
 *   Selection.prototype = selection.prototype = { constructor: Selection, … }
 *
 * and the augmentation is thrown away. Every selection in a production build
 * then has neither `.transition()` nor `.interrupt()`, while dev is fine
 * because it is unbundled and has no chunks to be circular. That shipped once
 * and took the Living Grid map down in production with
 * `this._svg.interrupt is not a function`.
 */
const MUST_SHIP_TOGETHER = ['d3-selection', 'd3-zoom', 'd3-transition'];

function manualChunks(): Record<string, string[]> {
  const source = readFileSync(resolve(__dirname, '../../../vite.config.ts'), 'utf8');
  const start = source.indexOf('manualChunks:');
  expect(start, 'vite.config.ts no longer declares manualChunks').toBeGreaterThan(-1);

  // Read the object literal by balancing braces, so a renamed or reordered
  // chunk does not quietly turn this test into a no-op.
  const open = source.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (; end < source.length; end++) {
    if (source[end] === '{') depth++;
    else if (source[end] === '}' && --depth === 0) break;
  }
  const body = source.slice(open, end + 1);

  const chunks: Record<string, string[]> = {};
  for (const m of body.matchAll(/'([\w-]+)':\s*\[([^\]]*)\]/g)) {
    chunks[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((p) => p[1]);
  }
  return chunks;
}

describe('the production chunk graph', () => {
  const chunks = manualChunks();

  it('reads the chunk map out of vite.config.ts', () => {
    // If this fails the parser has drifted, and every assertion below is
    // vacuous rather than passing.
    expect(Object.keys(chunks).length).toBeGreaterThan(4);
    expect(chunks['vendor-maps']).toBeDefined();
  });

  it('keeps d3-selection, d3-zoom and d3-transition in one chunk', () => {
    const homes = MUST_SHIP_TOGETHER.map((pkg) => {
      const chunk = Object.keys(chunks).find((name) => chunks[name].includes(pkg));
      return [pkg, chunk] as const;
    });
    for (const [pkg, chunk] of homes) {
      expect(chunk, `${pkg} is in no chunk; it must sit with the other d3 packages`).toBeDefined();
    }
    expect(
      new Set(homes.map(([, chunk]) => chunk)).size,
      `split across chunks: ${homes.map(([p, c]) => `${p} -> ${c}`).join(', ')}`,
    ).toBe(1);
  });

  it('does not reintroduce a d3-only chunk beside the map chunk', () => {
    // The shape that caused it: a second chunk holding part of the d3 graph.
    const d3Only = Object.entries(chunks).filter(
      ([name, pkgs]) => name !== 'vendor-maps' && pkgs.length > 0 && pkgs.every((p) => p.startsWith('d3-')),
    );
    expect(d3Only.map(([name]) => name)).toEqual([]);
  });
});
