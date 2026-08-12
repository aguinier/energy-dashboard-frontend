import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { collectImportSpecifiers, walkModuleGraph, type ImportGraphIo } from './importGraph.js';

/**
 * The walker is the mechanism behind ABL-304's structural claim, so it gets its
 * own tests against a synthetic tree rather than only being exercised through
 * the real one. A checker that quietly misses an edge would make
 * `publicApp.test.ts` pass for the wrong reason — the single worst outcome
 * available here.
 */

/** A fake source tree keyed by absolute path, POSIX-style for readability. */
function io(files: Record<string, string>): ImportGraphIo {
  const normalize = (p: string) => path.resolve(p).split(path.sep).join('/');
  const tree = new Map(Object.entries(files).map(([k, v]) => [normalize(k), v]));
  return {
    readFile: (p) => {
      const found = tree.get(normalize(p));
      if (found === undefined) throw new Error(`fixture has no file at ${p}`);
      return found;
    },
    isFile: (p) => tree.has(normalize(p)),
  };
}

const ROOT = path.resolve('/src');
const at = (rel: string) => path.join(ROOT, rel);

describe('collectImportSpecifiers', () => {
  it('reads a default, a named and a namespace import', () => {
    const { runtime } = collectImportSpecifiers(`
      import express from 'express';
      import { Router } from 'express';
      import * as fs from 'node:fs';
      import routes from './routes/index.js';
    `);
    expect(runtime.sort()).toEqual(['./routes/index.js', 'express', 'node:fs']);
  });

  it('reads an import clause spread over several lines', () => {
    const { runtime } = collectImportSpecifiers(`
      import {
        alpha,
        beta,
      } from './wide.js';
    `);
    expect(runtime).toEqual(['./wide.js']);
  });

  it('reads a side-effect import, which runs code and binds nothing', () => {
    expect(collectImportSpecifiers(`import './registerEverything.js';`).runtime).toEqual([
      './registerEverything.js',
    ]);
  });

  it('reads a re-export, which is every bit as much an edge', () => {
    const { runtime } = collectImportSpecifiers(`
      export { thing } from './thing.js';
      export * from './everything.js';
    `);
    expect(runtime.sort()).toEqual(['./everything.js', './thing.js']);
  });

  it('reads a dynamic import with a literal specifier', () => {
    const { runtime } = collectImportSpecifiers(`
      const mod = await import('./lazy.js');
      const other = await import("./other.js");
    `);
    expect(runtime.sort()).toEqual(['./lazy.js', './other.js']);
  });

  it('separates a type-only import, which tsc erases', () => {
    // The shape CLAUDE.md recommends: `lib/opsStatusThresholds.ts` imports only
    // types from DB-touching modules so it runs under either Node.
    const { runtime, typeOnly } = collectImportSpecifiers(`
      import type { OpsStatus } from '../services/opsStatusService.js';
      export type { Reading } from './reading.js';
      import { compute } from './compute.js';
    `);
    expect(runtime).toEqual(['./compute.js']);
    expect(typeOnly.sort()).toEqual(['../services/opsStatusService.js', './reading.js']);
  });

  it('counts a module imported for both its type and its value as a runtime edge', () => {
    const { runtime, typeOnly } = collectImportSpecifiers(`
      import type { Thing } from './thing.js';
      import { makeThing } from './thing.js';
    `);
    expect(runtime).toEqual(['./thing.js']);
    expect(typeOnly).toEqual([]);
  });

  it('counts an inline type specifier as an edge — conservatively', () => {
    // TypeScript may elide this. Over-counting can only make the isolation
    // assertion stricter, and guessing wrong in the other direction would let a
    // real edge through.
    expect(collectImportSpecifiers(`import { type Thing } from './thing.js';`).runtime).toEqual([
      './thing.js',
    ]);
  });

  it('ignores a commented-out import', () => {
    const { runtime } = collectImportSpecifiers(`
      // import opsStatus from './routes/opsStatus.js';
      /* import weather from './routes/weather.js'; */
      /**
       * import writeAuth from '../middleware/writeAuth.js';
       */
      import real from './real.js';
    `);
    expect(runtime).toEqual(['./real.js']);
  });

  it('does not mistake a URL in a string for a comment', () => {
    const { runtime } = collectImportSpecifiers(`
      const docs = 'https://example.com/x'; import real from './real.js';
    `);
    expect(runtime).toEqual(['./real.js']);
  });

  it('finds nothing in a module that imports nothing', () => {
    expect(collectImportSpecifiers('export const two = 2;').runtime).toEqual([]);
  });
});

describe('walkModuleGraph', () => {
  it('follows relative edges transitively and reports repo-relative paths', () => {
    const files = {
      [at('v1/publicApp.ts')]: `
        import express from 'express';
        import routes from './routes/index.js';
      `,
      [at('v1/routes/index.ts')]: `import { helper } from '../../utils/helper.js';`,
      [at('utils/helper.ts')]: `export const helper = 1;`,
    };
    const graph = walkModuleGraph(at('v1/publicApp.ts'), ROOT, io(files));

    expect(graph.modules).toEqual(['utils/helper.ts', 'v1/publicApp.ts', 'v1/routes/index.ts']);
    expect(graph.packages).toEqual(['express']);
    expect(graph.unresolved).toEqual([]);
  });

  it('resolves the .js specifier this codebase writes to the .ts file on disk', () => {
    const files = {
      [at('a.ts')]: `import b from './b.js';`,
      [at('b.ts')]: `export default 1;`,
    };
    expect(walkModuleGraph(at('a.ts'), ROOT, io(files)).modules).toEqual(['a.ts', 'b.ts']);
  });

  it('resolves a directory specifier to its index.ts', () => {
    const files = {
      [at('a.ts')]: `import r from './routes';`,
      [at('routes/index.ts')]: `export default 1;`,
    };
    expect(walkModuleGraph(at('a.ts'), ROOT, io(files)).modules).toEqual(['a.ts', 'routes/index.ts']);
  });

  it('terminates on a cycle', () => {
    const files = {
      [at('a.ts')]: `import b from './b.js';`,
      [at('b.ts')]: `import a from './a.js';`,
    };
    expect(walkModuleGraph(at('a.ts'), ROOT, io(files)).modules).toEqual(['a.ts', 'b.ts']);
  });

  it('reports an unresolvable specifier rather than skipping it silently', () => {
    // The failure that would matter: a stopped walk looks exactly like a clean
    // graph unless it is reported.
    const files = { [at('a.ts')]: `import gone from './not-here.js';` };
    const graph = walkModuleGraph(at('a.ts'), ROOT, io(files));

    expect(graph.modules).toEqual(['a.ts']);
    expect(graph.unresolved).toEqual(['a.ts -> ./not-here.js']);
  });

  it('does not follow a bare package specifier into node_modules', () => {
    const files = { [at('a.ts')]: `import x from 'better-sqlite3';` };
    const graph = walkModuleGraph(at('a.ts'), ROOT, io(files));

    expect(graph.modules).toEqual(['a.ts']);
    expect(graph.packages).toEqual(['better-sqlite3']);
  });

  it('catches a forbidden module reached indirectly, three hops down', () => {
    // The case the whole checker exists for: nobody imports the ops service
    // from the public app. A shared helper does, two levels away.
    const files = {
      [at('v1/publicApp.ts')]: `import routes from './routes/index.js';`,
      [at('v1/routes/index.ts')]: `import { fmt } from '../../utils/format.js';`,
      [at('utils/format.ts')]: `import { hostMetrics } from '../services/opsStatusService.js';`,
      [at('services/opsStatusService.ts')]: `export const hostMetrics = 1;`,
    };
    const graph = walkModuleGraph(at('v1/publicApp.ts'), ROOT, io(files));

    expect(graph.modules).toContain('services/opsStatusService.ts');
  });

  it('does not follow a type-only edge, which compiles away', () => {
    const files = {
      [at('a.ts')]: `import type { T } from '../services/opsStatusService.js';`,
      [at('services/opsStatusService.ts')]: `export type T = 1;`,
    };
    expect(walkModuleGraph(at('a.ts'), ROOT, io(files)).modules).toEqual(['a.ts']);
  });
});
