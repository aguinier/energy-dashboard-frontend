import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectImportSpecifiers, walkModuleGraph } from './importGraph.js';

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
 *
 * ## What ABL-300 changed here, and why it is not a loosening
 *
 * ABL-304 could assert the flat statement "`better-sqlite3` is not in this
 * graph", because the public app had no storage of its own. ABL-300 gives it
 * one — a key store — so that statement can no longer be both true and
 * correct, and the exact-module pin below invited exactly this: *"an edge added
 * here is the moment the isolation stops being free."*
 *
 * The blanket ban is replaced by three narrower assertions that together say
 * more than it did:
 *
 * - **`config/` is still unreachable from both entrypoints.** That was always
 *   the real control. `config/database.ts` and `config/writeDatabase.ts` are
 *   the handles on the 376 GiB energy database owned by `energy-data-gathering`
 *   — readonly and writable — and neither is reachable from the public process
 *   now any more than before.
 * - **`better-sqlite3` is still absent from `createPublicApp`'s graph.** The
 *   composition names the *shape* of a key store and the entrypoint picks the
 *   implementation, so the app that serves requests still chooses no storage.
 * - **From the entrypoint it is reachable through exactly one module**, and
 *   that module is named. A second module opening a database on this surface
 *   is a failing diff, which is stricter than "there is a database somewhere in
 *   here" would have been.
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
  { prefix: 'config/database', why: 'the readonly handle on the 376 GiB shared energy database' },
  { prefix: 'services/opsStatusService', why: 'host telemetry' },
  { prefix: 'services/combinedOpsStatusService', why: 'raw exception text in a 200 body' },
  { prefix: 'services/peerOpsStatus', why: 'peer host names' },
  { prefix: 'services/opsHistory', why: 'ops history: the same telemetry, over time' },
  { prefix: 'services/opsSnapshot', why: 'ops snapshots; the scheduler holds a write connection' },
  { prefix: 'services/ingest', why: 'ingest log and ingest freshness' },
  { prefix: 'services/netPositionIngestService', why: 'ingest' },
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

  it('reaches no handle on the shared energy database, readonly or writable', () => {
    // Both handles live under `config/`, so the whole directory being
    // unreachable is the claim. This is the assertion ABL-304 wrote and it is
    // unchanged: ABL-300's key store is a *different file*, opened by a module
    // under `v1/keys/`, and `resolveApiKeysDbPath` refuses to start if the two
    // paths are ever the same.
    expect(graph.modules.filter((m) => m.startsWith('config/'))).toEqual([]);
  });

  it('reaches only v1 modules', () => {
    // The real catch-all, and the reason the table above can afford to be a
    // readable inventory rather than an exhaustive one: a module added to
    // `services/` next year is covered by this without anyone remembering to
    // list it. The named cases exist to say *why* each is a leak, so a failure
    // reads as a finding instead of as a rule.
    expect(graph.modules.filter((m) => !m.startsWith('v1/'))).toEqual([]);
  });

  it('reaches no operator-only or test-only module', () => {
    // Four real modules in `v1/`, so the "only v1 modules" rule above does not
    // catch them — this is the line that keeps "test-only" and "operator-only"
    // checked properties rather than comments.
    //
    // - `keysCli.ts` holds the only read-write handle on the *key* rows.
    // - `usageCli.ts` closes months and deletes request records; neither belongs
    //   on a request path, and `usage:close-months` is irreversible.
    // - the two `memory*` fakes would authenticate against nothing and meter
    //   into an array that disappears with the process.
    for (const operatorOnly of [
      'v1/keys/keysCli',
      'v1/keys/memoryApiKeyDirectory',
      'v1/usage/usageCli',
      'v1/usage/memoryUsageSink',
    ]) {
      expect(graph.modules.filter((m) => m.startsWith(operatorOnly))).toEqual([]);
    }
  });
});

describe('the exact public module graph', () => {
  const graph = walkModuleGraph(path.join(HERE, 'publicApp.ts'), SRC_ROOT);

  it('is these eight modules and no others', () => {
    // Pinned as an exact set on purpose. Any new edge out of the public app —
    // to a shared service, a middleware, the database config — shows up here as
    // a failing diff and gets justified in review rather than noticed later.
    // Update this list deliberately, never reflexively: an edge added here is
    // the moment the isolation stops being free.
    //
    // ABL-300 added four: the gate, the router that holds the unauthenticated
    // discovery root, and the two key modules the gate needs — the format
    // (`keyFormat.ts`, pure crypto) and the record types plus `resolveKeyState`
    // (`apiKeyStore.ts`, pure). Note what is *not* here: `sqliteApiKeyStore.ts`.
    // `publicApp.ts` imports only the `ApiKeyDirectory` **type**, which `tsc`
    // erases, so the composition still chooses no storage.
    //
    // **ABL-301 adds none**, which is worth a sentence because it is not what
    // you would guess from the diff: `createPublicApp` now mounts a meter and
    // requires one to be passed. It takes it as `import type { UsageMeter }`,
    // and `tsc` erases a type-only import, so the composition names the *shape*
    // of a meter exactly as it names the shape of a key store and reaches
    // neither implementation. The whole of ABL-301's runtime graph — the meter,
    // the store, the maintenance timer — hangs off `publicIndex.ts` below.
    //
    // The consequence worth keeping: the module that serves requests still has
    // no metering code in it that could fail, and no database driver behind it.
    expect(graph.modules).toEqual([
      'v1/auth/apiKeyAuth.ts',
      'v1/keys/apiKeyStore.ts',
      'v1/keys/keyFormat.ts',
      'v1/publicApp.ts',
      'v1/publicEnv.ts',
      'v1/publicErrors.ts',
      'v1/routes/index.ts',
      'v1/routes/root.ts',
    ]);
  });

  it('depends on no package the private app does not already have', () => {
    // The public surface should not be how a new dependency arrives; if one is
    // needed, that is a decision, not a side effect. `node:crypto` is a Node
    // builtin and not a dependency at all — ABL-300 adds no package to
    // `server/package.json`, and the keys CLI is hand-rolled rather than taking
    // an argument parser for the same reason.
    expect(graph.packages).toEqual(['compression', 'cors', 'express', 'helmet', 'node:crypto']);
  });

  it('does not choose a key store or a usage store, only name the shape of each', () => {
    // The composition takes an `ApiKeyDirectory` and a `UsageMeter`, and
    // `publicIndex.ts` decides what implements them. That is what keeps a
    // database driver out of the module that serves requests, even though this
    // app now both authenticates and meters against one.
    expect(graph.packages).not.toContain('better-sqlite3');
    expect(graph.modules).not.toContain('v1/keys/sqliteApiKeyStore.ts');
    expect(graph.modules).not.toContain('v1/usage/sqliteUsageStore.ts');
  });
});

describe('the entrypoint chooses the key store, and only there', () => {
  const graph = walkModuleGraph(path.join(HERE, 'publicIndex.ts'), SRC_ROOT);

  it('is these fifteen modules and no others', () => {
    expect(graph.modules).toEqual([
      'v1/auth/apiKeyAuth.ts',
      'v1/keys/apiKeyStore.ts',
      'v1/keys/keyFormat.ts',
      'v1/keys/sqliteApiKeyStore.ts',
      'v1/publicApp.ts',
      'v1/publicEnv.ts',
      'v1/publicErrors.ts',
      'v1/publicIndex.ts',
      'v1/routes/index.ts',
      'v1/routes/root.ts',
      'v1/usage/sqliteUsageStore.ts',
      'v1/usage/usageMaintenance.ts',
      'v1/usage/usageMeter.ts',
      'v1/usage/usageShutdown.ts',
      'v1/usage/usageStore.ts',
    ]);
  });

  it('opens a database in exactly two modules, and both are named here', () => {
    // ABL-300 wrote this as "exactly one module, and that module is the key
    // store", and predicted its own change in the next sentence: *"if a future
    // issue needs another store — ABL-301's usage tables are the obvious
    // candidate — this fails and the new module gets named here on purpose."*
    // This is that issue, and this is the naming.
    //
    // Two rather than one, and the second is not a loosening:
    //
    // - Both open the **same file**, `API_KEYS_DB_PATH`, which
    //   `resolveApiKeysDbPath` refuses to let be the 376 GiB energy database.
    //   `sqliteUsageStore.ts` reuses that resolver rather than reading the
    //   variable itself, so there is still exactly one decision about what the
    //   path is and exactly one guard to keep true.
    // - They open it with **different capabilities**. The key store handle is
    //   readonly, so the serving process still cannot alter a key record;
    //   the usage handle is read-write and can reach nothing but the three
    //   usage tables. That split is the property worth having, and "one module"
    //   was only ever a proxy for it.
    //
    // A *third* fails this test, which is the point. Naming them individually
    // rather than asserting a count is deliberate: a count would pass if
    // somebody deleted one and added another.
    const importers = graph.modules.filter((module) =>
      collectImportSpecifiers(fs.readFileSync(path.join(SRC_ROOT, module), 'utf8')).runtime.includes(
        'better-sqlite3'
      )
    );

    expect(importers).toEqual(['v1/keys/sqliteApiKeyStore.ts', 'v1/usage/sqliteUsageStore.ts']);
  });

  it('opens the usage store through the key store path resolver, not its own variable', () => {
    // The one line that keeps the "never the energy database" guard singular.
    // If `sqliteUsageStore.ts` ever read `API_KEYS_DB_PATH` itself, the guard
    // would exist in one module and be bypassed in the other, and the metering
    // writes — the highest-volume writes this surface will ever make — are the
    // ones that must not land in a file we do not own.
    const source = fs.readFileSync(path.join(SRC_ROOT, 'v1/usage/sqliteUsageStore.ts'), 'utf8');

    expect(source).toContain('resolveApiKeysDbPath');
    expect(source).not.toMatch(/env\.API_KEYS_DB_PATH/);
  });

  it('adds no package beyond the driver and two Node builtins', () => {
    expect(graph.packages).toEqual([
      'better-sqlite3',
      'compression',
      'cors',
      'express',
      'helmet',
      'node:crypto',
      'node:path',
    ]);
  });
});
