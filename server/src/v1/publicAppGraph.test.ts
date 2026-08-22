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

/**
 * Shared modules the public graph may reach, and nothing else outside `v1/`.
 *
 * ABL-304 wrote the rule as "reaches only `v1/` modules", and predicted its own
 * revision in the sentence next to the exact-module pin: *"an edge added here is
 * the moment the isolation stops being free."* ABL-303 is that moment, and the
 * three edges below are paid for deliberately rather than waived.
 *
 * Each one holds a rule that **must not exist in two places**, and each has a
 * scar behind it:
 *
 * - `utils/timestamp.ts` — the two-separator window predicate. A space-form
 *   upper bound silently drops the whole end day (ABL-21, a lost day of
 *   forecasts) and a `T`-form one over-reads. ABL-293 §2a says every `/v1` query
 *   must use this helper "without exception"; a second copy under `v1/` would be
 *   a second thing to get right, and the first one was got wrong once already.
 * - `services/loadQuality.ts` — `load_mw > 0`. 543 stored zeros across 11 zones
 *   are the ingest writing a placeholder; MK reads `0.0` for whole days against
 *   a real 543-717 MW peak. A public API serving one as a measurement is the
 *   dashboard's `0 MW` header defect sold to a customer.
 * - `services/freshness.ts` — the measured/day-ahead classifier split. ABL-293
 *   §2g says to reuse it "verbatim" precisely so that `/v1` and the dashboard
 *   cannot reach different conclusions about the same zone.
 * - `services/wape.ts` (ABL-373) — the one definition of a weighted percentage
 *   error, `100 * sum|a-f| / sum|a|`. It already has two internal callers
 *   (`mlForecastService` and `tsoForecastService`, ABL-388) and `/v1/accuracy`
 *   is the third. A private copy under `v1/` would let the public "WAPE" and the
 *   dashboard's come to mean different things under the same column heading —
 *   and this one carries three properties that are easy to re-derive wrongly:
 *   `null` rather than `0` when the actuals sum to zero, `|actual|` in the
 *   denominator so a negative price cannot cancel it, and non-finite pairs
 *   skipped rather than counted. ABL-19 (BE solar MAPE 148,458%) and ABL-388
 *   (HU solar 7,421.87%) are what the shared definition exists to stop.
 *
 * The exception is narrow and **checked rather than asserted**: the test below
 * requires each of them to be a *leaf* — to import nothing at runtime at all. A
 * leaf cannot become a path to `config/database.ts` later without failing this
 * file, which is the property that makes the allowance safe rather than the
 * start of a slope. Anything else outside `v1/` still fails.
 */
const SHARED_LEAVES = [
  'utils/timestamp.ts',
  'services/freshness.ts',
  'services/loadQuality.ts',
  'services/wape.ts',
] as const;

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

  it('reaches only v1 modules and the three named shared leaves', () => {
    // The real catch-all, and the reason the table above can afford to be a
    // readable inventory rather than an exhaustive one: a module added to
    // `services/` next year is covered by this without anyone remembering to
    // list it. The named cases exist to say *why* each is a leak, so a failure
    // reads as a finding instead of as a rule.
    //
    // ABL-303 narrows "only v1" to "only v1, plus three modules named in
    // SHARED_LEAVES" — see the note there for what each one buys and why the
    // leaf requirement below is what keeps the exception from widening.
    const outside = graph.modules.filter((m) => !m.startsWith('v1/'));
    expect(outside.sort()).toEqual([...SHARED_LEAVES].sort());
  });

  it.each(SHARED_LEAVES)('%s is a leaf — it imports nothing at runtime', (leaf) => {
    // The load-bearing half of the allowance. A shared module that imports
    // nothing cannot become a path into `config/`, `services/opsStatus*` or a
    // scheduler holding a write handle; one that imports something can, one edit
    // at a time and without anyone noticing, because the module would already be
    // on the allowlist. Checking emptiness rather than checking what it imports
    // means this test needs no update when the leaf's *contents* change.
    const source = fs.readFileSync(path.join(SRC_ROOT, leaf), 'utf8');
    expect(collectImportSpecifiers(source).runtime).toEqual([]);
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
    // - `memoryEnergySource.ts` (ABL-303) is a real SQLite database seeded by a
    //   test. On a serving path it would answer a customer's question with a
    //   fixture — the same class of mistake as the other two, with the failure
    //   pointed at the data rather than at the auth.
    // - `memoryAuthFailureSink.ts` (ABL-530) would record a credential attack
    //   into an array that disappears with the process. It is listed by name for
    //   the same reason the other fakes are, and with one extra edge: it exports
    //   `createTestAuthFailureRecorder`, which every test that mounts the gate
    //   now imports, so it is the fake most likely to be reached for by
    //   accident.
    // - `changelogCli.ts` (ABL-532) holds the only read-write handle on published
    //   change-log entries, and `exampleEntries.ts` describes no real change. An
    //   entry, like a key, is published by a person running a command; a serving
    //   path that could reach either could rewrite a notice we have already given
    //   or put an example on the page a subscriber is pointed at.
    for (const operatorOnly of [
      'v1/keys/keysCli',
      'v1/keys/memoryApiKeyDirectory',
      'v1/usage/usageCli',
      'v1/usage/memoryUsageSink',
      'v1/data/memoryEnergySource',
      'v1/security/memoryAuthFailureSink',
      'v1/changelog/changelogCli',
      'v1/changelog/exampleEntries',
    ]) {
      expect(graph.modules.filter((m) => m.startsWith(operatorOnly))).toEqual([]);
    }
  });

  it('reaches no billing module at all — the whole directory, not a named list', () => {
    // ABL-307. Asserted as a directory rather than module by module, which is
    // stricter than the list above and is affordable here because **nothing**
    // under `v1/billing/` has a request-path role. A subscription is never
    // consulted to serve a request: ABL-302 gates on `accounts.plan`, which the
    // gate already reads through the key store, so billing has no read the
    // request path needs and no capability worth exposing to it.
    //
    // Two things this keeps true. `sqliteBillingStore.ts` opens its own handle
    // on `API_KEYS_DB_PATH`, and it must never appear in the "exactly four
    // modules open a database" assertion below — it is reached from
    // `billingCli.ts` alone. And `invoice.ts` decides amounts of money; a
    // pricing module on a serving path is a latency and a failure mode taken on
    // for nothing.
    expect(graph.modules.filter((m) => m.startsWith('v1/billing/'))).toEqual([]);
  });
});

describe('the exact public module graph', () => {
  const graph = walkModuleGraph(path.join(HERE, 'publicApp.ts'), SRC_ROOT);

  it('is these thirty-two modules and no others', () => {
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
    //
    // **ABL-303 adds seventeen** — eight endpoints' worth of routing and the
    // contract kernel behind them — and this is the diff where the list stops
    // being short enough to eyeball, so what to look for when it changes again:
    //
    // - Everything new is under `v1/data/` or `v1/routes/`, plus the three
    //   `SHARED_LEAVES`. Nothing else outside `v1/` appears, and `config/` still
    //   does not.
    // - `v1/data/energySource.ts` and `v1/data/context.ts` are **absent**, and
    //   that absence is the point: both are imported as types only, so `tsc`
    //   erases them. The app names the shape of a data source and of the maps
    //   built over it; `publicIndex.ts` picks the implementations.
    // - `v1/data/sqliteEnergySource.ts` is absent for the same reason
    //   `sqliteApiKeyStore.ts` is. The module that serves requests still opens
    //   no database.
    //
    // **ABL-373 adds three** — the ninth endpoint: a route, the join
    // (`accuracyRepo.ts`), the arithmetic (`accuracyMetrics.ts`) — plus the
    // fourth shared leaf, `services/wape.ts`. What to look for: the accuracy
    // join reads its actuals through `data/series.ts`'s `STREAMS`, the same
    // constant `/v1/observations` reads, so `services/mlForecastService.ts` and
    // the frozen `energy_renewable` table it maps to are **not** in this graph
    // and must not become so.
    //
    // **ABL-532 adds three**, all under `v1/changelog/`: the router, the entry
    // model and the page renderer. Two things to look for if this part of the
    // list changes again:
    //
    // - `v1/changelog/changelogStore.ts` is **absent**, and that absence is the
    //   point — `publicApp.ts` and the router both import only the
    //   `ChangelogReader` *type*, which `tsc` erases. The composition names the
    //   shape of a change log and chooses no storage, exactly as it does for the
    //   key store, the meter and the data source.
    // - `v1/changelog/sqliteChangelogStore.ts` is absent for the same reason, and
    //   so is `changelogCli.ts`: the module that serves requests can read a
    //   published notice and has no way to write one.
    expect(graph.modules).toEqual([
      'services/freshness.ts',
      'services/loadQuality.ts',
      'services/wape.ts',
      'utils/timestamp.ts',
      'v1/auth/apiKeyAuth.ts',
      'v1/changelog/changelogEntry.ts',
      'v1/changelog/changelogHtml.ts',
      'v1/changelog/changelogRoutes.ts',
      'v1/data/accuracyMetrics.ts',
      'v1/data/accuracyRepo.ts',
      'v1/data/attribution.ts',
      'v1/data/catalogRepo.ts',
      'v1/data/cursor.ts',
      'v1/data/envelope.ts',
      'v1/data/forecastsRepo.ts',
      'v1/data/freshnessMap.ts',
      'v1/data/links.ts',
      'v1/data/models.ts',
      'v1/data/observationsRepo.ts',
      'v1/data/params.ts',
      'v1/data/series.ts',
      'v1/keys/apiKeyStore.ts',
      'v1/keys/keyFormat.ts',
      'v1/publicApp.ts',
      'v1/publicEnv.ts',
      'v1/publicErrors.ts',
      'v1/routes/accuracy.ts',
      'v1/routes/catalog.ts',
      'v1/routes/forecasts.ts',
      'v1/routes/index.ts',
      'v1/routes/observations.ts',
      'v1/routes/root.ts',
    ]);
  });

  it('does not reach the frozen energy_renewable read path', () => {
    // ABL-373's largest correctness decision, checked structurally rather than
    // left in a comment. `mlForecastService.ACTUAL_DATA_MAPPING` points the
    // accuracy join at `energy_renewable`, which carries `DEFAULT 0` on every
    // `*_mw` column and so cannot express "not reported" — it stores an
    // unreported type as a literal `0.0`. ABL-353 measured the result on the TSO
    // accuracy route: 477,846 pairs existed only because of that default, and 23
    // countries that report no offshore wind at all scored a flawless
    // `mae: 0, rmse: 0` over thousands of points. `/v1/accuracy` reads
    // `STREAMS` instead, so its actuals are the rows `/v1/observations` serves.
    //
    // Reusing that mapping is the single most likely "simplification" a future
    // edit makes here, and it is one import away. This is the line that fails.
    for (const frozen of [
      'services/mlForecastService',
      'services/crossCountryMetricsService',
      'services/forecastService',
      'services/tsoForecastService',
    ]) {
      expect(graph.modules.filter((m) => m.startsWith(frozen))).toEqual([]);
    }
  });

  it('depends on no package the private app does not already have', () => {
    // The public surface should not be how a new dependency arrives; if one is
    // needed, that is a decision, not a side effect. `node:crypto` is a Node
    // builtin and not a dependency at all — ABL-300 adds no package to
    // `server/package.json`, and the keys CLI is hand-rolled rather than taking
    // an argument parser for the same reason.
    //
    // **ABL-303 adds none either**, which is worth checking rather than
    // assuming: eight endpoints with cursor pagination, ISO-8601 duration
    // formatting and opaque token encoding are exactly the shape of change that
    // arrives with a date library, a query builder and a base64 helper. The
    // cursor uses `node:crypto` (already here for key hashing) and `Buffer`;
    // durations are four modulo tests; the window parser is two regexes.
    expect(graph.packages).toEqual(['compression', 'cors', 'express', 'helmet', 'node:crypto']);
  });

  it('does not choose a key store, a usage store or a data source — only name each shape', () => {
    // The composition takes an `ApiKeyDirectory`, a `UsageMeter` and a
    // `V1DataContext`, and `publicIndex.ts` decides what implements them. That
    // is what keeps a database driver out of the module that serves requests,
    // even though this app now authenticates, meters *and* reads a 9.4 GB
    // SQLite file.
    expect(graph.packages).not.toContain('better-sqlite3');
    expect(graph.modules).not.toContain('v1/keys/sqliteApiKeyStore.ts');
    expect(graph.modules).not.toContain('v1/usage/sqliteUsageStore.ts');
    expect(graph.modules).not.toContain('v1/data/sqliteEnergySource.ts');
    expect(graph.modules).not.toContain('v1/changelog/sqliteChangelogStore.ts');
  });
});

describe('the entrypoint chooses the key store, and only there', () => {
  const graph = walkModuleGraph(path.join(HERE, 'publicIndex.ts'), SRC_ROOT);

  it('is these forty-eight modules and no others', () => {
    // **ABL-530 adds three**, all under `v1/security/`, and — like ABL-301's
    // metering and ABL-302's quota before them — they are here and *not* in
    // `createPublicApp`'s graph above. That is the property worth checking rather
    // than the count: the gate takes an `AuthFailureRecorder` as a type, this
    // file constructs one, and the module that serves requests still contains no
    // recording code that could fail and no database driver behind it. The
    // twenty-eight-module assertion above is unchanged by this issue.
    //
    // What to look for if this list changes again: nothing under `v1/security/`
    // should import a store. The recorder is handed an `AuthFailureSink` — one
    // method, appends rows — so it cannot read a key, close a month or delete a
    // record, and `sqliteAuthFailureStore.ts` is handed an already-open handle
    // rather than opening one, which is why it appears in this list without
    // appearing in the database-opening assertion below. That assertion names
    // its modules rather than counting them, so what ABL-530 leaves true is the
    // membership, not a total: `v1/security/sqliteAuthFailureStore.ts` is not in
    // it. (The total did move under this branch, and not for any reason of ours
    // — ABL-532's `sqliteChangelogStore.ts` opens a fourth handle. That is the
    // hazard of quoting a count: this comment claimed three while it was four.)
    //
    // **ABL-302 adds four**, all under `v1/quota/`, and they are here rather than
    // in the app's graph above for the same reason the whole of ABL-301's
    // metering is: `publicApp.ts` takes a `PlanGate` as a type and this file
    // constructs one. The gate ultimately counts rows in a SQLite file and none
    // of that is in the module that serves requests.
    //
    // What to look for if this list changes again: nothing under `v1/quota/`
    // should ever import a store. The gate is handed a `MonthlyUsageReader` —
    // one method, reads one integer — and `quota/planGate.test.ts` asserts that
    // its graph cannot reach `sqliteApiKeyStore.ts` or the keys CLI, which is
    // what makes ABL-297 §6.5's "suspension is never fully automated" a property
    // of the build rather than a promise in a comment.
    expect(graph.modules).toEqual([
      'services/freshness.ts',
      'services/loadQuality.ts',
      'services/wape.ts',
      'utils/timestamp.ts',
      'v1/auth/apiKeyAuth.ts',
      'v1/changelog/changelogEntry.ts',
      'v1/changelog/changelogHtml.ts',
      'v1/changelog/changelogRoutes.ts',
      'v1/changelog/sqliteChangelogStore.ts',
      'v1/data/accuracyMetrics.ts',
      'v1/data/accuracyRepo.ts',
      'v1/data/attribution.ts',
      'v1/data/catalogRepo.ts',
      'v1/data/cursor.ts',
      'v1/data/envelope.ts',
      'v1/data/forecastsRepo.ts',
      'v1/data/freshnessMap.ts',
      'v1/data/links.ts',
      'v1/data/models.ts',
      'v1/data/observationsRepo.ts',
      'v1/data/params.ts',
      'v1/data/series.ts',
      'v1/data/sqliteEnergySource.ts',
      'v1/keys/apiKeyStore.ts',
      'v1/keys/keyFormat.ts',
      'v1/keys/sqliteApiKeyStore.ts',
      'v1/publicApp.ts',
      'v1/publicEnv.ts',
      'v1/publicErrors.ts',
      'v1/publicIndex.ts',
      'v1/quota/monthlyQuota.ts',
      'v1/quota/planGate.ts',
      'v1/quota/planLimits.ts',
      'v1/quota/rateLimiter.ts',
      'v1/routes/accuracy.ts',
      'v1/routes/catalog.ts',
      'v1/routes/forecasts.ts',
      'v1/routes/index.ts',
      'v1/routes/observations.ts',
      'v1/routes/root.ts',
      'v1/security/authFailureRecorder.ts',
      'v1/security/requestTarget.ts',
      'v1/security/sqliteAuthFailureStore.ts',
      'v1/usage/sqliteUsageStore.ts',
      'v1/usage/usageMaintenance.ts',
      'v1/usage/usageMeter.ts',
      'v1/usage/usageShutdown.ts',
      'v1/usage/usageStore.ts',
    ]);
  });

  it('opens a database in exactly four modules, and all four are named here', () => {
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
    //
    // ## ABL-303 is that third, and it is a different file, not a third handle
    //    on the same one
    //
    // The two above open `API_KEYS_DB_PATH` — a small file this project owns.
    // `v1/data/sqliteEnergySource.ts` opens `ENERGY_DB_PATH`, the 9.4 GB energy
    // database owned by `energy-data-gathering`, which is the file the previous
    // two exist to stay out of. That looks like the guard being reversed, so
    // here is why it is not:
    //
    // - It is **readonly**, so this process still cannot write to a database it
    //   does not own. The write capability added at ABL-301 remains confined to
    //   the usage tables in our own file.
    // - It is opened **only from the entrypoint**, so `createPublicApp` still
    //   chooses no storage — the assertion in the block above still passes with
    //   this module absent from the app's graph.
    // - `resolveEnergyDbPath` reuses `resolveApiKeysDbPath` rather than reading
    //   `API_KEYS_DB_PATH` itself, so the "these two files are never the same
    //   file" rule is still decided in one place and now guarded from both
    //   directions.
    //
    // What would be a real loosening, and what this test still catches: a
    // *fourth* module, a non-readonly handle on the energy database, or this
    // module appearing in `createPublicApp`'s graph.
    //
    // ## ABL-532 is that fourth, and it named itself here on purpose
    //
    // The sentence above predicted the shape of the next diff and asked for it
    // to be argued rather than absorbed. So, the argument:
    //
    // - It opens **no new file**. `v1/changelog/sqliteChangelogStore.ts` resolves
    //   its path through `resolveApiKeysDbPath`, like the usage store, so the
    //   "never the 376 GiB energy database" guard is still a single decision in a
    //   single module — three of these four handles are the same small file we
    //   own, and the fourth is the readonly energy handle explained above.
    // - The handle this process holds on it is **readonly**, and that is the
    //   property worth having rather than the count. A published change-log entry
    //   is a statement we made to a subscriber at a time we recorded; the serving
    //   process can render one and cannot alter one. The read-write handle is
    //   `changelogCli.ts`'s alone, and the block above asserts that module is
    //   unreachable from here.
    // - It is opened **only from the entrypoint**, so `createPublicApp` still
    //   chooses no storage.
    //
    // A *fifth* fails this test, which is still the point.
    const importers = graph.modules.filter((module) =>
      collectImportSpecifiers(fs.readFileSync(path.join(SRC_ROOT, module), 'utf8')).runtime.includes(
        'better-sqlite3'
      )
    );

    expect(importers).toEqual([
      'v1/changelog/sqliteChangelogStore.ts',
      'v1/data/sqliteEnergySource.ts',
      'v1/keys/sqliteApiKeyStore.ts',
      'v1/usage/sqliteUsageStore.ts',
    ]);
  });

  it('records auth failures into the key store file, on a handle it is given', () => {
    // ABL-530's table lives in `API_KEYS_DB_PATH` beside `usage_events`, because
    // it holds `client_ip` and `user_agent` and has to be scrubbed by the same
    // retention job on the same boundary. The obvious way to write it — one more
    // module calling `new Database(...)` — would have failed the named-module
    // assertion above, and rightly: it would also be a second place
    // `resolveApiKeysDbPath` had to be remembered, on the one file that must
    // never become the energy database.
    //
    // So the security store is handed an open handle and imports the driver for
    // its *type* only. Checked as text, like everything else in this file,
    // because the claim is about what the module says and importing it would open
    // a database to find out.
    const source = fs.readFileSync(
      path.join(SRC_ROOT, 'v1/security/sqliteAuthFailureStore.ts'),
      'utf8'
    );
    const specifiers = collectImportSpecifiers(source);

    expect(specifiers.runtime).not.toContain('better-sqlite3');
    expect(specifiers.typeOnly).toContain('better-sqlite3');
    expect(source).not.toContain('new Database(');
  });

  it('opens the change log readonly, and through the key store path resolver', () => {
    // The two properties that make the fourth handle safe, checked as text for
    // the same reason the rest of this file is.
    const source = fs.readFileSync(
      path.join(SRC_ROOT, 'v1/changelog/sqliteChangelogStore.ts'),
      'utf8'
    );

    expect(source).toContain('resolveApiKeysDbPath');
    expect(source).not.toMatch(/env\.API_KEYS_DB_PATH/);
    // `openChangelogReader` — the one the entrypoint calls — opens it readonly.
    // `openChangelogAdminStore` in the same module does not, and is reached only
    // from the CLI, which the block above asserts is not in this graph.
    expect(source).toMatch(/readonly: true, fileMustExist: true/);
  });

  it('opens the energy database readonly, and through the key store path resolver', () => {
    // The two properties that make the third handle safe, checked as text for
    // the same reason the rest of this file is: the claim is about what the
    // module *says*, and importing it would open a 9.4 GB database to find out.
    const source = fs.readFileSync(path.join(SRC_ROOT, 'v1/data/sqliteEnergySource.ts'), 'utf8');

    expect(source).toContain('readonly: true');
    expect(source).toContain('resolveApiKeysDbPath');
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
    // Unchanged by ABL-303 and unchanged by ABL-302. Eight endpoints, cursor
    // pagination, a freshness map, a sliding-window rate limiter and a monthly
    // quota counter, and the dependency list is the same seven entries — worth
    // pinning, because "we needed a date library" is how a public surface
    // quietly becomes the place new dependencies enter a codebase, and a rate
    // limiter is the single most reached-for package in this class of change.
    // The window is an array of numbers and one `splice`.
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
