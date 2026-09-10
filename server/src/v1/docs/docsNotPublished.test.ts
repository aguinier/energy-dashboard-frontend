import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkModuleGraph } from '../importGraph.js';

/**
 * ABL-522 Constraint 3, as a test that says so.
 *
 * The Board scheduled this site on 2026-09-03 as **build-and-hold**: built,
 * previewed locally and reviewed now; deployed to a public URL only after the
 * ABL-349 gate lifts, as a separate Board-gated act. This file is the mechanism
 * behind the second half of that sentence.
 *
 * ## Why a graph test and not a flag
 *
 * A feature flag defaulting to off would have been the obvious lock and it is
 * the weaker one, in two ways that both matter here.
 *
 * First, a flag makes publishing a runtime decision made by whoever sets an
 * environment variable, at a moment nobody reviews. Composition makes it a diff.
 *
 * Second — and this is the failure that would actually have happened — a docs
 * site mounted on `createPublicApp` behind a flag is one deploy of an unrelated
 * change away from being live. The site would go public as a **side effect of
 * deploying the API**, which is exactly the "arrives by default rather than by
 * decision" failure Constraint 1 is written to prevent, pointed at Constraint 3
 * instead. There is no environment in which this app serves a docs page,
 * because the handlers are not in its dependency graph — the same argument
 * ABL-304 makes for the internal routes.
 *
 * ## Why this file exists when `publicAppGraph.test.ts` pins the exact set
 *
 * That test would also fail, and its message would say a module count changed.
 * This one names the constraint, so whoever sees it red learns *which decision*
 * they are about to reverse and who has to agree to it. When the gate lifts,
 * deleting this file is part of the diff that publishes the site — which is the
 * point: it is a marker that has to be removed on purpose.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '../..');

const PUBLIC_ENTRIES = [
  { label: 'the public app', file: '../publicApp.ts' },
  { label: 'the public entrypoint', file: '../publicIndex.ts' },
] as const;

describe.each(PUBLIC_ENTRIES)('$label', ({ file }) => {
  const graph = walkModuleGraph(path.join(HERE, file), SRC_ROOT);

  it('resolves every specifier it followed', () => {
    // Asserted first, exactly as publicAppGraph.test.ts does: a walk that
    // stopped early would make the assertion below pass for the wrong reason —
    // "reaches no docs module" is also true of a walk that reached nothing.
    expect(graph.unresolved).toEqual([]);
  });

  it('reaches a module that is not the docs site, so the walk is a real one', () => {
    // The positive control on the same risk, from the other side.
    expect(graph.modules.length).toBeGreaterThan(1);
  });

  it('cannot reach the documentation site — ABL-349 is open and this site is on hold', () => {
    expect(graph.modules.filter((module) => module.startsWith('v1/docs/'))).toEqual([]);
  });
});

describe('the documentation site', () => {
  const graph = walkModuleGraph(path.join(HERE, 'docsSite.ts'), SRC_ROOT);

  it('resolves every specifier it followed', () => {
    expect(graph.unresolved).toEqual([]);
  });

  it('does not reach the public app either', () => {
    // The other direction, and not symmetry for its own sake. Importing
    // `publicApp.ts` to borrow its CSP header or its error envelope would put
    // the public composition in this module's graph, and the next person to
    // mount the site would find the edge already there and read it as
    // permission. `docsPreview.ts` restates the header instead, and says why.
    expect(graph.modules.filter((module) => module.startsWith('v1/publicApp'))).toEqual([]);
    expect(graph.modules.filter((module) => module.startsWith('v1/publicIndex'))).toEqual([]);
  });

  it('opens no database and starts no server', () => {
    // The site is a pure function from one committed file to a Map of strings.
    // Anything here that touched SQLite or bound a port would make building it
    // an operation rather than a render, and would make this test file — which
    // imports nothing it walks — the only safe way to touch it.
    for (const forbidden of ['config/database', 'config/writeDatabase', 'better-sqlite3']) {
      expect(graph.modules.filter((module) => module.includes(forbidden))).toEqual([]);
      expect(graph.packages.filter((pkg) => pkg.includes(forbidden))).toEqual([]);
    }
  });

  it('pulls in no third-party package at all', () => {
    // Not express, not helmet, not a Markdown library, not a template engine —
    // node builtins only. The rendering is strings, and that is what lets
    // `default-src 'none'` stay the deployment property ABL-522 Constraint 1
    // relies on: there is no package here that could decide a page needs a
    // stylesheet, a webfont or a search index.
    expect(graph.packages.filter((pkg) => !pkg.startsWith('node:'))).toEqual([]);
  });
});
