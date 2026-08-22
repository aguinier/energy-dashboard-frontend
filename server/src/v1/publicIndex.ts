import { createPublicApp } from './publicApp.js';
import { openApiKeyDirectory } from './keys/sqliteApiKeyStore.js';
import { openChangelogReader } from './changelog/sqliteChangelogStore.js';
import { openUsageStore } from './usage/sqliteUsageStore.js';
import { createUsageMeter } from './usage/usageMeter.js';
import { startUsageMaintenance } from './usage/usageMaintenance.js';
import { shutDownUsage } from './usage/usageShutdown.js';
import { createPlanGate } from './quota/planGate.js';
import { openEnergyDatabase } from './data/sqliteEnergySource.js';
import { createFreshnessMap } from './data/freshnessMap.js';
import { createCatalogRepo } from './data/catalogRepo.js';
import { resolvePublicBaseUrl } from './data/links.js';
import { ACKNOWLEDGED_VERSIONS } from './modelVersions/acknowledgements.js';
import { readServedVersionLedger } from './modelVersions/servedLedger.js';
import { diffLedger } from './modelVersions/versionGuard.js';

/**
 * Entrypoint for the public process.
 *
 * A second process, not a second mount on the first. `index.ts` keeps port 3001
 * with the dashboard, the ingest `POST`s, `/api/ops/*` and `/api/health`
 * untouched; this one serves `/v1` and nothing else. Two processes is what lets
 * the private surface stay exactly as it is — the reason ABL-293 §2f prices
 * this isolation at 2–3 days now against 3–4× that as a retrofit.
 *
 * ## Schedulers, and what changed here at ABL-301
 *
 * This file used to say it starts **no schedulers**, and that it therefore had
 * no timer that could open a write connection. Half of that is still true and
 * the half that changed is worth stating plainly rather than quietly editing.
 *
 * Still true: `index.ts:41-49` starts the forecast vintage archive and the JAO
 * capture, both of which take a write connection **on the 376 GiB energy
 * database**. Neither is started here, nothing in this process's import graph
 * can reach `config/writeDatabase.ts`, and `publicAppGraph.test.ts` asserts that
 * as a property of the module graph rather than as a claim in a comment.
 *
 * Changed: metering writes, so this process now holds a read-write handle — to
 * the **key store file**, reaching nothing but the three usage tables, in a file
 * `resolveApiKeysDbPath` refuses to let be the energy database. The maintenance
 * timer that aggregates and applies retention runs against that same handle.
 * "No write capability at all" was the old shape; "no write capability on data
 * this process does not own" is the one that survives an API you can invoice
 * for, and it is the property the graph test actually enforces.
 *
 * The key store handle is still opened **readonly**, so the serving process
 * cannot alter a key record even now. Two handles on one file, and only one of
 * them can write.
 *
 * ## Binding
 *
 * Defaults to `127.0.0.1`. `PUBLIC_BIND_HOST` exists so the bind address is
 * build-time configuration rather than a code change — but choosing a value
 * other than loopback is a network-exposure decision, and per ABL-291 and this
 * agent's charter that decision needs its own Board-approved issue. Nothing in
 * this repository sets it, and ABL-304 neither deploys this process nor starts
 * it anywhere.
 *
 * The private app binds `0.0.0.0` (`index.ts:19`) and keeps doing so; that is
 * the existing LAN dashboard and is out of scope here.
 *
 * ## The key store
 *
 * This is the one place a concrete key store is chosen. `openApiKeyDirectory`
 * opens `API_KEYS_DB_PATH` **readonly**, so the serving process cannot write to
 * a key record at all — issuance, rotation and revocation are the keys CLI's,
 * over a read-write handle this process never holds
 * (`v1/keys/sqliteApiKeyStore.ts`).
 *
 * It is a **separate SQLite file from the energy database**, which is 376 GiB,
 * is owned by `energy-data-gathering` and is opened readonly by the private
 * server. `resolveApiKeysDbPath` refuses to start if the two are pointed at the
 * same file. The full reasoning is at the top of `sqliteApiKeyStore.ts`.
 *
 * Opening it before `listen` is deliberate: a misconfigured or missing key
 * store must be a startup failure. The alternative is a process that binds a
 * port and then answers `key_invalid` to every customer, which is the most
 * confusing way this could break.
 */

const PORT = Number(process.env.PUBLIC_PORT) || 3002;
const HOST = process.env.PUBLIC_BIND_HOST || '127.0.0.1';

const apiKeyDirectory = openApiKeyDirectory();

// Opened before `listen`, like the key store and for the same reason: a process
// that binds a port and then cannot record what it served is a process quietly
// giving the API away. `openUsageStore` requires the file to exist and to be a
// real key store, so a path typo is a startup failure rather than a month of
// metering into a database nobody looks in.
const usageStore = openUsageStore();
const usageMeter = createUsageMeter({ sink: usageStore });
const usageMaintenance = startUsageMaintenance({ store: usageStore });

// The plan gate (ABL-302), reading the same store the meter writes.
//
// It is handed `usageStore` where a `MonthlyUsageReader` is expected, so the gate
// sees a one-method capability that reads an integer — the widening to the full
// `UsageAdminStore` happens nowhere, because structural typing means the gate's
// parameter type *is* the narrowing. That is what makes the ABL-297 §6.5
// commitment checkable: `setAccountDisabled` lives on `ApiKeyAdminStore`, this
// process never holds one (`openApiKeyDirectory` is readonly), and nothing in
// `quota/`'s import graph could reach it if it did.
//
// No lifecycle to shut down. The gate's state is two in-memory maps, and losing
// them on exit resets the rate windows to empty and re-seeds the month counters
// from the store on the next request — which is the whole reason the counter
// reconciles with durable storage rather than trusting a number it kept.
const planGate = createPlanGate({ usage: usageStore });

// The energy database, and the two memoized maps built over it (ABL-303).
//
// Opened before `listen` for the third time and the third reason: the key store
// so an unconfigured process cannot answer `key_invalid` to every customer, the
// usage store so it cannot give the API away unmetered, and this one so a bad
// `ENERGY_DB_PATH` is a startup failure rather than a 500 on the first paid
// request. `fileMustExist` makes a typo fail here rather than creating an empty
// database and serving `coverage: "out_of_scope"` for every zone on earth.
//
// `createFreshnessMap` builds its first snapshot **synchronously**, which is
// deliberate: a process that starts serving before the map exists would answer
// its first minute of requests with `status: "none"` fleet-wide — telling every
// early customer that every zone had stopped publishing. The build is ~180 ms
// against the local replica, paid once, before the port is bound.
const energySource = openEnergyDatabase();
const freshness = createFreshnessMap({ source: energySource });
const catalog = createCatalogRepo({ source: energySource });
// Same argument, applied to the model catalogue: its first build is the one
// that pays for a cold page cache, and paying it inside a request blocks the
// process for whoever happened to arrive first after a restart.
catalog.warm();

// The served-version audit (ABL-529), before `listen` and once per start.
//
// The *enforcement* is not here — it is the version gate the forecast routes
// build per request from `ACKNOWLEDGED_VERSIONS`, which is static source and
// costs no query. This is the **notification**: the guard withholds an
// unacknowledged artifact silently and correctly, and a mechanism that refuses
// without telling anyone is how a pair stays frozen for a month while everyone
// assumes it is current.
//
// Boot rather than a timer, deliberately. The audit is a ~2.9 s query against
// the 9.4 GB replica, and the event it watches for — a promotion writing a new
// `model_version` — is not one that needs catching within minutes: the guard has
// already stopped it reaching a subscriber, and what remains is a 30-day notice
// somebody has to start. A restart is also the moment an operator is looking.
//
// It never throws. A monitoring read that can take the process down with it is
// worse than one that stays quiet, and this one runs before the port is bound.
try {
  const diff = diffLedger(readServedVersionLedger(energySource), ACKNOWLEDGED_VERSIONS, new Date());
  for (const row of diff.unacknowledged) {
    console.error(
      `[v1] WITHHELD: ${row.zone}/${row.forecast_type}/${row.model} is serving model_version ` +
        `'${row.model_version}', which no acknowledgement covers. The previously acknowledged ` +
        `artifact keeps serving. Under ToS §9.3.1 this is a material change and needs 30 days' ` +
        `notice — or, if it corrects values that are wrong, a §9.3.2 correction entry. ` +
        `Run: npm run modelversions -- status`
    );
  }
  for (const row of diff.embargoed) {
    console.warn(
      `[v1] embargoed: ${row.zone}/${row.forecast_type}/${row.model} model_version ` +
        `'${row.model_version}' is acknowledged but inside its notice period.`
    );
  }
  for (const pair of diff.withdrawn.filter((p) => p.triple_gone)) {
    console.warn(
      `[v1] withdrawn: ${pair.zone}/${pair.forecast_type}/${pair.model} produces no rows at all. ` +
        `Ceasing to cover a zone is material under ToS §9.3.1 (M4) and cannot be withheld — ` +
        `it needs a notice, not a guard.`
    );
  }
} catch (error) {
  console.error('[v1] served-version audit could not run:', error);
}

// Configuration, never `req.get('host')` — trap 1 from the ABL-291 brief. Unset
// is the safe and current state: `links.next` then comes back relative, which is
// correct against whatever origin the client already used and cannot bake a
// `192.168.x` address into a subscriber's stored URL.
const publicBaseUrl = resolvePublicBaseUrl(process.env);

// The change log (ABL-532), opened before `listen` for the fourth time and the
// fourth reason: §9.3 points a subscriber at this page for advance notice of a
// material model change, so a process that binds a port and then 500s on
// `/changelog` is answering a contractual URL with an error. `fileMustExist`
// makes a wrong path a startup failure rather than an empty change log, which is
// the more dangerous shape — an empty page looks like "we have never changed
// anything" and nothing about it reads as broken.
//
// **Readonly**, like the key directory and for the same kind of reason: this
// process publishes nothing. A published entry is a statement we made at a time
// we recorded, and the serving process should not be able to alter one even by
// mistake. `npm run changelog -- entries:publish` holds the only read-write
// handle, and it is that command — not a deploy — that is the publish path.
const changelog = openChangelogReader();

const app = createPublicApp({
  apiKeyDirectory,
  usageMeter,
  planGate,
  data: {
    source: energySource,
    freshness,
    catalog,
    acknowledgedVersions: ACKNOWLEDGED_VERSIONS,
    publicBaseUrl,
    now: () => new Date(),
  },
  changelog,
});

const server = app.listen(PORT, HOST, () => {
  console.log(`
⚡ Energy Dashboard — PUBLIC API (/v1)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔒 Public composition: internal routes are absent, not filtered
🔑 API-key auth: Authorization: Bearer able_<env>_<prefix>_<secret>
📈 Usage metering: on — every authenticated request is counted per key
🚦 Plan limits: on — per-account monthly quota and per-minute rate limit, 429 only
🚀 Listening on http://${HOST}:${PORT}
📊 API base URL: http://${HOST}:${PORT}/v1
📜 Change log:   http://${HOST}:${PORT}/changelog   (and /changelog.json) — outside /v1, no key
🔗 Pagination links: ${publicBaseUrl ?? 'relative (PUBLIC_BASE_URL unset)'}

Not on this surface, by composition: /api/*, /api/ops/*, /api/health,
/api/dashboard/*, /api/weather/*, and every write/ingest route.
`);
});

// Close the handles on the way out. `config/database.ts` registers the same
// pair for the private app; doing it in the entrypoint rather than inside the
// store module keeps the store a plain object with no global side effects,
// which is what lets `sqliteApiKeyStore.test.ts` open and close a dozen of them
// in one process.
//
// `server.close()` first, so requests still in flight get to finish and emit the
// `close` event that puts them in the meter's buffer at all; then
// `shutDownUsage`, which flushes that buffer, runs a final aggregation pass and
// closes the store. The sequence lives in its own module because this one cannot
// be imported by a test — it opens databases and binds a port at import time —
// and "a clean shutdown loses nothing" is a billing claim that should be checked
// rather than asserted. `usageShutdown.test.ts` checks it.
//
// **`SIGTERM` is listed but does not arrive on Windows.** Node accepts the
// listener and the OS terminates the process outright, so a `taskkill` on this
// platform loses whatever is buffered — at most one flush interval, under-count,
// which is the documented and chosen direction. `SIGINT` (Ctrl-C) is emulated
// and does arrive; on Linux both do. Verified against a running server rather
// than assumed, which is also how the sequence below stopped being untested.
//
// What is deliberately *not* here: a handler for `uncaughtException`, `SIGKILL`
// or a power cut. Those lose the buffer, they under-count by design, and that is
// the direction this whole module errs in. See `usageMeter.ts`.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // Two Ctrl-Cs must not run the sequence twice. `meter.close()` is idempotent
    // by itself, but the maintenance pass is not free and a second signal is
    // usually somebody impatient rather than somebody with new information.
    if (shuttingDown) return;
    shuttingDown = true;

    server.close(() => {
      shutDownUsage({ meter: usageMeter, maintenance: usageMaintenance, store: usageStore });
      apiKeyDirectory.close();
      changelog.close();
      // Nothing is buffered behind these two — the map is a read cache and the
      // handle is readonly — so closing them loses no data and is only about
      // not leaving a file handle and a timer behind.
      freshness.close();
      energySource.close();
      process.exit(0);
    });
  });
}

export default app;
