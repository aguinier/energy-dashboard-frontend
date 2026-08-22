import Database from 'better-sqlite3';
import { wrapDatabase } from './sqliteEnergySource.js';
import { createFreshnessMap } from './freshnessMap.js';
import { createCatalogRepo } from './catalogRepo.js';
import type { EnergyDataSource } from './energySource.js';
import type { V1DataContext } from './context.js';
import type { AcknowledgementLedger } from '../modelVersions/acknowledgements.js';

/**
 * A **real** SQLite database, in memory, with the energy schema — for tests.
 *
 * Test-only, and named in `publicAppGraph.test.ts` alongside
 * `memoryApiKeyDirectory` and `memoryUsageSink` so that it cannot reach a
 * serving path: a data source seeded by a test would answer a customer's
 * question with a fixture.
 *
 * ## Why a real database rather than a stub returning canned rows
 *
 * Because the interesting bugs in `v1/data/` are *SQL* bugs, and a stub proves
 * nothing about them. Every one of these is a real defect this repository has
 * already paid for, and each is only reproducible against an engine that
 * compares text the way SQLite does:
 *
 * - **Two separators in one column.** `'T'`(84) sorts above `' '`(32), so a
 *   space-form upper bound drops the whole end day (ABL-21). A stub would return
 *   whatever rows the test author remembered to put in it, in whatever order
 *   they wrote them.
 * - **The `+02:00` rows.** `LENGTH(timestamp_utc) = 19` is only an exclusion if
 *   something actually evaluates `LENGTH`.
 * - **`NULL` versus `0`.** `energy_generation` carries no `DEFAULT 0`, which is
 *   what makes an unreported production type come back as `null`; that
 *   distinction lives in the DDL, not in the query.
 * - **The correlated `MAX(generated_at)` dedupe.** Whether it picks one vintage
 *   per target hour is a question about SQLite's evaluation, not about our code.
 *
 * The schema below is copied from the live database rather than invented —
 * column names, types and the absence of defaults all match, and the two indexes
 * that the repo layer's query plans depend on are created so that a test
 * exercises the same plan shape production does.
 */

const SCHEMA = `
CREATE TABLE countries (
  country_code TEXT PRIMARY KEY,
  country_name TEXT NOT NULL
);

CREATE TABLE energy_load (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country_code TEXT NOT NULL,
  timestamp_utc TIMESTAMP NOT NULL,
  load_mw REAL NOT NULL,
  data_quality TEXT DEFAULT 'actual',
  publication_timestamp_utc TIMESTAMP
);
CREATE INDEX idx_load_country_time ON energy_load(country_code, timestamp_utc);

CREATE TABLE energy_price (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country_code TEXT NOT NULL,
  timestamp_utc TIMESTAMP NOT NULL,
  price_eur_mwh REAL NOT NULL,
  data_quality TEXT DEFAULT 'actual',
  publication_timestamp_utc TIMESTAMP
);
CREATE INDEX idx_price_country_time ON energy_price(country_code, timestamp_utc);

-- Every *_mw column is nullable with no default, exactly as in production. That
-- is the whole NULL contract: a production type a zone does not report arrives
-- as SQL NULL and leaves as JSON null.
CREATE TABLE energy_generation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country_code TEXT NOT NULL,
  timestamp_utc TIMESTAMP NOT NULL,
  solar_mw REAL, wind_onshore_mw REAL, wind_offshore_mw REAL,
  hydro_run_mw REAL, hydro_reservoir_mw REAL, hydro_pumped_mw REAL,
  biomass_mw REAL, geothermal_mw REAL, marine_mw REAL,
  other_renewable_mw REAL, energy_storage_mw REAL, nuclear_mw REAL,
  fossil_gas_mw REAL, fossil_hard_coal_mw REAL, fossil_brown_coal_mw REAL,
  fossil_oil_mw REAL, fossil_oil_shale_mw REAL, fossil_peat_mw REAL,
  fossil_coal_derived_gas_mw REAL, waste_mw REAL, other_mw REAL,
  data_quality TEXT DEFAULT 'actual',
  publication_timestamp_utc TIMESTAMP
);
CREATE INDEX idx_generation_country_time ON energy_generation(country_code, timestamp_utc);

CREATE TABLE forecasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country_code TEXT NOT NULL,
  forecast_type TEXT NOT NULL,
  target_timestamp_utc TIMESTAMP NOT NULL,
  generated_at TIMESTAMP NOT NULL,
  horizon_hours INTEGER NOT NULL,
  forecast_value REAL NOT NULL,
  model_name TEXT NOT NULL,
  model_version TEXT,
  renewable_type TEXT
);
CREATE INDEX idx_forecasts_model_lookup
  ON forecasts(country_code, forecast_type, model_name, target_timestamp_utc);

CREATE TABLE data_ingestion_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_type TEXT NOT NULL,
  country_code TEXT,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP,
  status TEXT NOT NULL,
  records_inserted INTEGER DEFAULT 0,
  records_updated INTEGER DEFAULT 0,
  records_failed INTEGER DEFAULT 0
);
CREATE INDEX idx_ingestion_log_pipeline ON data_ingestion_log(pipeline_type, start_time DESC);
`;

export interface MemoryEnergySource extends EnergyDataSource {
  zones(...codes: string[]): void;
  load(zone: string, timestamp: string, mw: number): void;
  price(zone: string, timestamp: string, eurMwh: number): void;
  generation(zone: string, timestamp: string, values: Record<string, number | null>): void;
  forecast(row: {
    zone: string;
    type: string;
    target: string;
    generatedAt: string;
    horizonHours: number;
    value: number;
    model: string;
    /**
     * The artifact identity (ABL-529). Optional, and left unset by almost every
     * fixture, which is correct: a test that says nothing about `model_version`
     * is a test about something else, and the default context acknowledges
     * nothing, so no version filter applies to it.
     */
    modelVersion?: string;
  }): void;
  /**
   * One ingest pass.
   *
   * `status` defaults to `'completed'` because **every** row in the real table
   * is `'completed'` — 114,982 of 114,983, with no failure value in the
   * vocabulary at all. `recordsFailed` is the parameter that actually matters,
   * and defaulting the useless field while requiring nothing of it is how this
   * fixture keeps a test from accidentally asserting against the wrong column.
   */
  ingestPass(row: {
    pipelineType: string;
    zone: string | null;
    startTime: string;
    endTime: string | null;
    recordsFailed?: number;
    status?: string;
  }): void;
}

/**
 * A whole {@link V1DataContext} over a seeded in-memory database.
 *
 * `refreshIntervalMs: 0` and an explicit `now` on purpose: a test that waits for
 * a timer is a flaky test, and a `generated_at` read from the wall clock is an
 * unassertable field. Both are the same argument the meter makes with
 * `flushIntervalMs: 0` — make the timing a thing the test does rather than a
 * thing it hopes for.
 *
 * `publicBaseUrl` defaults to `null`, which is the LAN's configuration today and
 * therefore the state most worth exercising: it is where `links.next` comes back
 * relative rather than carrying a host.
 */
export function createMemoryDataContext(
  source: MemoryEnergySource,
  {
    now = () => new Date('2026-08-12T12:00:00Z'),
    publicBaseUrl = null as string | null,
    acknowledgedVersions = [] as AcknowledgementLedger,
  } = {}
): V1DataContext {
  return {
    source,
    freshness: createFreshnessMap({ source, refreshIntervalMs: 0, now }),
    catalog: createCatalogRepo({ source, now }),
    // Empty, not `ACKNOWLEDGED_VERSIONS`. An empty ledger means every triple is
    // one we have never served, which under ToS §9.3.1 is additive and serves
    // unfiltered — so a fixture that says nothing about model versions behaves
    // exactly as it did before ABL-529. Importing the real ledger here would
    // instead make every fixture's `DE`/`load`/`catboost` rows fail a filter
    // against production artifact names, which is a test asserting the wrong
    // thing. Tests *about* the guard pass their own ledger.
    acknowledgedVersions,
    publicBaseUrl,
    now,
  };
}

export function createMemoryEnergySource(): MemoryEnergySource {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const wrapped = wrapDatabase(db);

  return {
    ...wrapped,
    zones(...codes) {
      const insert = db.prepare('INSERT INTO countries (country_code, country_name) VALUES (?, ?)');
      for (const code of codes) insert.run(code, `Zone ${code}`);
    },
    load(zone, timestamp, mw) {
      db.prepare('INSERT INTO energy_load (country_code, timestamp_utc, load_mw) VALUES (?, ?, ?)').run(
        zone,
        timestamp,
        mw
      );
    },
    price(zone, timestamp, eurMwh) {
      db.prepare(
        'INSERT INTO energy_price (country_code, timestamp_utc, price_eur_mwh) VALUES (?, ?, ?)'
      ).run(zone, timestamp, eurMwh);
    },
    generation(zone, timestamp, values) {
      const columns = Object.keys(values);
      const placeholders = columns.map(() => '?').join(', ');
      db.prepare(
        `INSERT INTO energy_generation (country_code, timestamp_utc${
          columns.length ? `, ${columns.join(', ')}` : ''
        }) VALUES (?, ?${columns.length ? `, ${placeholders}` : ''})`
      ).run(zone, timestamp, ...columns.map((column) => values[column]));
    },
    forecast({ zone, type, target, generatedAt, horizonHours, value, model, modelVersion }) {
      db.prepare(
        `INSERT INTO forecasts
           (country_code, forecast_type, target_timestamp_utc, generated_at,
            horizon_hours, forecast_value, model_name, model_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(zone, type, target, generatedAt, horizonHours, value, model, modelVersion ?? null);
    },
    ingestPass({ pipelineType, zone, startTime, endTime, recordsFailed = 0, status = 'completed' }) {
      db.prepare(
        `INSERT INTO data_ingestion_log
           (pipeline_type, country_code, start_time, end_time, status, records_failed)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(pipelineType, zone, startTime, endTime, status, recordsFailed);
    },
  };
}
