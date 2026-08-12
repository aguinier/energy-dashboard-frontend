import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkModuleGraph } from './importGraph.js';

/**
 * The structural half of ABL-304: not "does the public app 404 an ops path"
 * but "is the ops handler in this app at all".
 *
 * **This file deliberately never imports `publicApp.ts`.** It reads it as text.
 * Two reasons, and the second one was found by breaking it on purpose:
 *
 * 1. Importing the module would prove reachability by executing the code under
 *    test, and would open the shared database and start any scheduler that had
 *    been wired in — the exact side effects this is meant to detect.
 * 2. When the isolation *is* violated, the app module often stops being
 *    importable at all: `config/database.ts` opens SQLite at import time, so a
 *    public app that reaches the internal router takes every test file that
 *    imports it down with a load error and no named assertion. A control whose
 *    output is "no tests ran" is a control nobody can act on. This file still
 *    runs, and still says which module arrived and by which path.
 *
 * `publicApp.test.ts` covers the behavioural half — that the composed app
 * really does answer 404 — and the two together are the claim. Neither alone
 * is: a filter would satisfy the behavioural half until someone reordered it,
 * and an app with no routes at all would satisfy it forever.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '..');

/**
 * Modules whose presence in the public graph is the defect ABL-304 names.
 *
 * Matched as path prefixes against repo-relative module paths, so `routes/ops`
 * catches `routes/opsStatus.ts` and anything added beside it. The `why` is the
 * ABL-293 §1.2 finding that makes each one a leak rather than merely untidy.
 */
const FORBIDDEN_PREFIXES: ReadonlyArray<{ prefix: string; why: string }> = [
  { prefix: 'routes/index.ts', why: 'the internal router tree — all 52 handlers' },
  { prefix: 'routes/ops', why: 'ops status: host telemetry, disk free, db_path' },
  { prefix: 'routes/weather', why: 'third-party data, uncapped, SELECT *-shaped, plus a write route' },
  { prefix: 'routes/netPositionIngest', why: 'write/ingest' },
  { prefix: 'routes/dashboard', why: 'UI render plans we must not freeze into a public contract' },
  { prefix: 'middleware/writeAuth', why: 'the shared-secret write gate' },
  { prefix: 'config/writeDatabase', why: 'getWriteDb() — a writable handle on the shared database' },
  { prefix: 'services/opsStatusService', why: 'host telemetry' },
  { prefix: 'services/combinedOpsStatusService', why: 'raw exception text in a 200 body' },
  { prefix: 'services/peerOpsStatus', why: 'peer host names' },
  { prefix: 'services/forecastVintageArchiveScheduler', why: 'holds a write connection' },
  { prefix: 'services/coreNetPositionScheduler', why: 'holds a write connection' },
  { prefix: 'services/jaoCoreNetPositionCapture', why: 'ingest' },
  { prefix: 'lib/healthProvenance', why: 'db_path, commit SHA, runtime kind' },
  { prefix: 'release/', why: 'git state: branch names and unmerged-work status' },
];

/** Both entry points: the factory, and the process that actually runs. */
const ENTRIES = [
  { label: 'createPublicApp', file: 'publicApp.ts' },
  { label: 'the public entrypoint', file: 'publicIndex.ts' },
] as const;

describe.each(ENTRIES)('$label', ({ file }) => {
  const graph = walkModuleGraph(path.join(HERE, file), SRC_ROOT);

  it('resolves every specifier it followed', () => {
    // An unresolvable import means the walk stopped early and everything below
    // it is missing — which would make every assertion here pass for the wrong
    // reason. Assert it first, so a broken walk reads as a broken walk.
    expect(graph.unresolved).toEqual([]);
  });

  it.each(FORBIDDEN_PREFIXES)('cannot reach $prefix — $why', ({ prefix }) => {
    expect(graph.modules.filter((m) => m.startsWith(prefix))).toEqual([]);
  });

  it('reaches nothing under routes/ outside v1', () => {
    // The catch-all for the table above: a handler added to the internal tree
    // and pulled in here fails this even if nobody updates FORBIDDEN_PREFIXES.
    expect(graph.modules.filter((m) => m.startsWith('routes/'))).toEqual([]);
  });

  it('reaches no database handle at all, readonly or writable', () => {
    expect(graph.modules.filter((m) => m.startsWith('config/'))).toEqual([]);
    expect(graph.packages).not.toContain('better-sqlite3');
  });

  it('reaches only v1 modules', () => {
    expect(graph.modules.filter((m) => !m.startsWith('v1/'))).toEqual([]);
  });
});

describe('the exact public module graph', () => {
  const graph = walkModuleGraph(path.join(HERE, 'publicApp.ts'), SRC_ROOT);

  it('is these four modules and no others', () => {
    // Pinned as an exact set on purpose. Any new edge out of the public app —
    // to a shared service, a middleware, the database config — shows up here as
    // a failing diff and gets justified in review rather than noticed later.
    // Update this list deliberately, never reflexively: an edge added here is
    // the moment the isolation stops being free.
    expect(graph.modules).toEqual([
      'v1/publicApp.ts',
      'v1/publicEnv.ts',
      'v1/publicErrors.ts',
      'v1/routes/index.ts',
    ]);
  });

  it('depends on no package the private app does not already have', () => {
    // The public surface should not be how a new dependency arrives; if one is
    // needed, that is a decision, not a side effect. These four are already in
    // `server/package.json` — better-sqlite3 is the fifth and is absent above.
    expect(graph.packages).toEqual(['compression', 'cors', 'express', 'helmet']);
  });
});
