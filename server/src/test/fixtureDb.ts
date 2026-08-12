import Database, { type Database as DatabaseType } from 'better-sqlite3';

/**
 * The fixture database the route tests run against.
 *
 * WHY IN-MEMORY, AND NEVER A FILE
 *
 * `config/database.ts` opens `ENERGY_DB_PATH` at import time. Every route test
 * mocks that module out and hands the routers this database instead, so the
 * real shared SQLite file is never opened at all — not readonly, not writable,
 * not even stat'ed. An in-memory handle makes that structurally true rather
 * than a convention someone has to remember, and it keeps the suite fast and
 * free of Windows file-lock flake.
 *
 * WHY THE DDL IS COPIED VERBATIM
 *
 * The CREATE TABLE statements below are byte-for-byte what
 * `energy_dashboard.db` carries (read out of it on 2026-08-05), because the
 * defaults are the thing under test. `energy_generation` deliberately has NO
 * `DEFAULT 0` — a production type a country does not report must stay NULL, and
 * a fixture that quietly defaulted it to 0 would test the opposite of what this
 * dashboard cares about. `energy_renewable`, the older frozen table, DOES carry
 * `DEFAULT 0`; that difference is real and is preserved here.
 *
 * WHAT THE FIXTURE ENCODES
 *
 * Six countries, each standing for one failure shape this codebase has actually
 * shipped a wrong number for:
 *
 * - `DE` — the ordinary case. Full load/price/generation, catboost D+1 and D+2,
 *   TSO day-ahead and week-ahead. Also carries a SUPERSEDED forecast vintage
 *   (an older `generated_at` with an absurd value) so the MAX(generated_at)
 *   dedup is exercised end to end rather than assumed.
 * - `FR` — legitimate negatives. `hydro_pumped_mw` is -300 (pumping) and
 *   `fossil_hard_coal_mw` is -50 (a consumption-only type). `solar_mw` is a
 *   measured 0.0 while `wind_onshore_mw` is NULL: zero and unknown side by side
 *   in one row, which must stay distinguishable on the wire.
 * - `BE` — negative day-ahead prices, and a window whose solar actuals are all a
 *   measured zero. Sum of actuals is 0, so WAPE and MAPE must be null.
 * - `PT` — rows exist but every generation column is NULL (a country reporting
 *   nothing). Must read as "no data", never 0%. On the day after WINDOW it also
 *   carries MK's and SI's live `energy_load` shape: impossible exact-`0.0`
 *   hours *interleaved with real ones*, which must be dropped row by row while
 *   the rest of the day survives.
 * - `GR` — stopped publishing mid-window, the GR/IE shape. Also carries BOTH
 *   degenerate net-position series this codebase has shipped, which are two
 *   different defects that happen to share a signature:
 *     - a FORECAST collapsed to zero (values ~1e-7 MW, band included), the real
 *       series measured on the replica: rows exist and *none is exactly 0.0*,
 *       so an `= 0` guard catches none of them;
 *     - ACTUALS that are *exactly* 0.0, on the day after WINDOW — GR's real
 *       shape since 2025-10-01, where the rows kept coming and the numbers
 *       stopped meaning anything.
 *   Nothing else on the tab contradicts either one, which is why the chart was
 *   the only place the number appeared at all.
 *   GR's `energy_load` on that same day is all-zero too, so the "published a
 *   placeholder instead of a measurement" defect is covered in two tables at
 *   once. `PT` carries the interleaved variant — see below.
 * - `AT` — served by xgboost only, with no catboost row anywhere. The disjoint
 *   catboost/xgboost coverage that makes "no rows for this country" a normal
 *   answer rather than an error.
 *
 * `LU` exists with a single contradictory `net_position` row, the real ingest
 * artifact `dashboardService.getMapNetPositionData` overwrites with DE_LU's.
 */

/** The window every test queries unless it is deliberately looking outside it. */
export const WINDOW = { start: '2026-07-01T00:00:00Z', end: '2026-07-01T03:00:00Z' };

/**
 * A window one day later: forecasts exist here, and the only actuals that do
 * are GR's — its degenerate all-zero `net_position` rows, and its `energy_load`
 * day carrying impossible exact zeros (both below). **DE publishes no actual of
 * any kind on this day**, which is what keeps `no_paired_actuals` testable, so
 * add a DE actual here only if you mean to break that.
 */
export const NEXT_DAY = { start: '2026-07-02T00:00:00Z', end: '2026-07-02T03:00:00Z' };

/** `?start=…&end=…` for WINDOW, ready to concatenate onto a query string. */
export const WINDOW_QS = `start=${WINDOW.start}&end=${WINDOW.end}`;
export const NEXT_DAY_QS = `start=${NEXT_DAY.start}&end=${NEXT_DAY.end}`;

/** The four hours in WINDOW, in the space format every actuals table uses. */
export const HOURS = [0, 1, 2, 3] as const;

/** Actuals-table timestamp: `2026-07-01 02:00:00`. */
export const at = (hour: number, day = 1): string =>
  `2026-07-0${day} ${String(hour).padStart(2, '0')}:00:00`;

/** `forecasts.target_timestamp_utc` timestamp: `2026-07-01T02:00:00`. */
export const atT = (hour: number, day = 1): string => at(hour, day).replace(' ', 'T');

/** The current vintage every non-stale forecast row is generated at. */
const GENERATED_AT = '2026-06-30T18:00:00.000000';
/** An older, superseded vintage. Its values are absurd on purpose. */
const STALE_GENERATED_AT = '2026-06-29T18:00:00.000000';

const SCHEMA = `
CREATE TABLE countries (
    country_code TEXT PRIMARY KEY,
    country_name TEXT NOT NULL,
    entsoe_domain TEXT,
    has_load_data BOOLEAN DEFAULT 0,
    has_price_data BOOLEAN DEFAULT 0,
    has_renewable_data BOOLEAN DEFAULT 0,
    has_weather_data BOOLEAN DEFAULT 0,
    priority INTEGER DEFAULT 2,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE energy_load (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL,
    timestamp_utc TIMESTAMP NOT NULL,
    load_mw REAL NOT NULL,
    data_quality TEXT DEFAULT 'actual',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    publication_timestamp_utc TIMESTAMP
);

CREATE TABLE energy_price (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL,
    timestamp_utc TIMESTAMP NOT NULL,
    price_eur_mwh REAL NOT NULL,
    data_quality TEXT DEFAULT 'actual',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    publication_timestamp_utc TIMESTAMP
);

-- No DEFAULT 0 on any *_mw column. This is deliberate upstream and load-bearing
-- here: NULL means "this country does not report this type", 0.0 means "we
-- measured zero".
CREATE TABLE energy_generation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL,
    timestamp_utc TIMESTAMP NOT NULL,
    solar_mw REAL,
    wind_onshore_mw REAL,
    wind_offshore_mw REAL,
    hydro_run_mw REAL,
    hydro_reservoir_mw REAL,
    hydro_pumped_mw REAL,
    biomass_mw REAL,
    geothermal_mw REAL,
    marine_mw REAL,
    other_renewable_mw REAL,
    energy_storage_mw REAL,
    nuclear_mw REAL,
    fossil_gas_mw REAL,
    fossil_hard_coal_mw REAL,
    fossil_brown_coal_mw REAL,
    fossil_oil_mw REAL,
    fossil_oil_shale_mw REAL,
    fossil_peat_mw REAL,
    fossil_coal_derived_gas_mw REAL,
    waste_mw REAL,
    other_mw REAL,
    data_quality TEXT DEFAULT 'actual',
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    publication_timestamp_utc TIMESTAMP
);

-- The older frozen table. It DOES carry DEFAULT 0; preserved as-is.
CREATE TABLE energy_renewable (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL,
    timestamp_utc TIMESTAMP NOT NULL,
    solar_mw REAL DEFAULT 0,
    wind_onshore_mw REAL DEFAULT 0,
    wind_offshore_mw REAL DEFAULT 0,
    hydro_run_mw REAL DEFAULT 0,
    hydro_reservoir_mw REAL DEFAULT 0,
    biomass_mw REAL DEFAULT 0,
    geothermal_mw REAL DEFAULT 0,
    other_renewable_mw REAL DEFAULT 0,
    total_renewable_mw REAL,
    data_quality TEXT DEFAULT 'actual',
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    publication_timestamp_utc TIMESTAMP
);

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
    renewable_type TEXT,
    UNIQUE(country_code, forecast_type, target_timestamp_utc, horizon_hours, model_name, generated_at)
);

CREATE TABLE forecast_quantiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL,
    forecast_type TEXT NOT NULL,
    target_timestamp_utc TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    quantile REAL NOT NULL,
    forecast_value REAL NOT NULL,
    model_name TEXT NOT NULL
);

CREATE TABLE net_position (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL,
    timestamp_utc TEXT NOT NULL,
    net_position_mw REAL NOT NULL,
    data_quality TEXT DEFAULT 'actual',
    publication_timestamp_utc TEXT,
    fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(country_code, timestamp_utc)
);

CREATE TABLE energy_load_forecast (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL,
    target_timestamp_utc TIMESTAMP NOT NULL,
    forecast_value_mw REAL NOT NULL,
    forecast_type TEXT NOT NULL,
    forecast_run_time TIMESTAMP,
    horizon_hours INTEGER,
    data_quality TEXT DEFAULT 'forecast',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    publication_timestamp_utc TIMESTAMP,
    forecast_min_mw REAL,
    forecast_max_mw REAL
);

CREATE TABLE energy_generation_forecast (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL,
    target_timestamp_utc TIMESTAMP NOT NULL,
    solar_mw REAL,
    wind_onshore_mw REAL,
    wind_offshore_mw REAL,
    total_forecast_mw REAL,
    forecast_type TEXT DEFAULT 'day_ahead',
    data_quality TEXT DEFAULT 'forecast',
    publication_timestamp_utc TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(country_code, target_timestamp_utc, forecast_type)
);
`;

/** Every `*_mw` column on `energy_generation`, in table order. */
const GENERATION_COLUMNS = [
  'solar_mw', 'wind_onshore_mw', 'wind_offshore_mw', 'hydro_run_mw',
  'hydro_reservoir_mw', 'hydro_pumped_mw', 'biomass_mw', 'geothermal_mw',
  'marine_mw', 'other_renewable_mw', 'energy_storage_mw', 'nuclear_mw',
  'fossil_gas_mw', 'fossil_hard_coal_mw', 'fossil_brown_coal_mw',
  'fossil_oil_mw', 'fossil_oil_shale_mw', 'fossil_peat_mw',
  'fossil_coal_derived_gas_mw', 'waste_mw', 'other_mw',
] as const;

type GenerationRow = Partial<Record<typeof GENERATION_COLUMNS[number], number | null>>;

/**
 * Insert one `energy_generation` row. Columns the caller does not name are
 * inserted as NULL, never 0 — writing them as 0 is precisely the bug class
 * these fixtures exist to catch, so the helper cannot express it by accident.
 */
function insertGeneration(db: DatabaseType, country: string, timestamp: string, row: GenerationRow) {
  const stmt = db.prepare(
    `INSERT INTO energy_generation (country_code, timestamp_utc, ${GENERATION_COLUMNS.join(', ')})
     VALUES (?, ?, ${GENERATION_COLUMNS.map(() => '?').join(', ')})`
  );
  stmt.run(country, timestamp, ...GENERATION_COLUMNS.map((c) => row[c] ?? null));
}

function seed(db: DatabaseType): void {
  const country = db.prepare('INSERT INTO countries (country_code, country_name) VALUES (?, ?)');
  for (const [code, name] of [
    ['DE', 'Germany'], ['FR', 'France'], ['BE', 'Belgium'],
    ['PT', 'Portugal'], ['GR', 'Greece'], ['AT', 'Austria'], ['LU', 'Luxembourg'],
  ]) {
    country.run(code, name);
  }

  // ---------------------------------------------------------------- actuals

  const load = db.prepare('INSERT INTO energy_load (country_code, timestamp_utc, load_mw) VALUES (?, ?, ?)');
  // DE: 1000 / 1100 / 1200 / 1300 — avg 1150, peak 1300.
  HOURS.forEach((h, i) => load.run('DE', at(h), 1000 + i * 100));
  HOURS.forEach((h) => load.run('FR', at(h), 800));
  HOURS.forEach((h) => load.run('BE', at(h), 500));
  HOURS.forEach((h) => load.run('PT', at(h), 200));
  // AT: 600 / 620 / 640 / 660.
  HOURS.forEach((h, i) => load.run('AT', at(h), 600 + i * 20));
  // NL — the ABL-277 shape: realized load and the TSO day-ahead forecast are
  // published on different bases (ENTSO-E nets behind-the-meter solar out of
  // the Dutch realized series and not out of the forecast), so their
  // difference is a definitional gap, not forecast error. Every row is a real
  // measurement and no guard drops it; it is the *aggregate accuracy* derived
  // from the pair that must not be published.
  //
  // On NEXT_DAY, not WINDOW, and deliberately: `crossCountryMetricsService`'s
  // ABL-214 test seeds its own NL conflict pair at `2026-07-01 01:00:00` to
  // prove the two-LEFT-JOIN shape cannot fan out. A second NL row at that
  // timestamp here would be an exact `(country_code, timestamp_utc)`
  // duplicate — the one thing that join's no-fan-out property is measured
  // against (verified 2026-08-11: zero such duplicates in the real table) —
  // and would break it for a reason that has nothing to do with separators.
  HOURS.forEach((h, i) => load.run('NL', at(h, 2), 900 - i * 200));
  // GR went silent after 01:00. The last two hours of the window simply are
  // not there — the shape GR and IE have had since 2026-03-14.
  load.run('GR', at(0), 300);
  load.run('GR', at(1), 310);
  // GR's load on NEXT_DAY is exactly `0.0` at every hour — the same shape, in a
  // second table, as its all-zero `net_position` below. A national grid never
  // draws 0 MW, so these are placeholders and not readings, and withholding
  // them is what keeps "GR went silent" true: `currentLoad` has to fall back to
  // 310, the last hour GR really published, and peak demand over this window
  // has to stay null rather than becoming a confident 0.
  HOURS.forEach((h) => load.run('GR', at(h, 2), 0));
  // PT on NEXT_DAY is the OTHER shape, and the live one: impossible zeros
  // interleaved with real hours inside a single day. That is MK's and SI's
  // actual form — measured on the replica 2026-08-06, 543 such rows across 11
  // countries and still arriving (SI 2026-08-06, MK 2026-08-02). It needs the
  // opposite granularity to a degenerate net position: the bad rows are dropped
  // and the day survives, because withholding MK's whole series would destroy
  // 56,510 good readings to suppress 99 bad ones.
  load.run('PT', at(0, 2), 200);
  load.run('PT', at(1, 2), 0);
  load.run('PT', at(2, 2), 220);
  load.run('PT', at(3, 2), 0);

  const price = db.prepare('INSERT INTO energy_price (country_code, timestamp_utc, price_eur_mwh) VALUES (?, ?, ?)');
  // DE: 50 / 60 / 70 / 80 — avg 65.
  HOURS.forEach((h, i) => price.run('DE', at(h), 50 + i * 10));
  // BE: a genuinely negative day-ahead window. Avg is -25, not +25 and not 0.
  HOURS.forEach((h, i) => price.run('BE', at(h), -10 - i * 10));
  HOURS.forEach((h) => price.run('FR', at(h), 5));

  // ------------------------------------------------------------- generation

  // DE — an ordinary mix. Renewable 300 of 1000 positive MW per row => 30.00%.
  HOURS.forEach((h) =>
    insertGeneration(db, 'DE', at(h), {
      solar_mw: 100, wind_onshore_mw: 200, nuclear_mw: 300, fossil_gas_mw: 400,
    })
  );

  // FR — the negatives case, and the 0-vs-NULL case in a single row:
  //   solar_mw = 0.0    measured zero
  //   wind_onshore_mw   absent => NULL, not reported
  //   hydro_pumped_mw   -300, pumping
  //   fossil_hard_coal  -50, consumption-only
  // Renewable numerator = solar 0 + hydro_run 100 = 100 (pumped storage is a
  // store, not primary generation). Denominator clamps each column at 0, so the
  // two negatives contribute nothing rather than shrinking it: 0+100+700 = 800.
  // Share = 100/800 = 12.50%.
  HOURS.forEach((h) =>
    insertGeneration(db, 'FR', at(h), {
      solar_mw: 0, hydro_run_mw: 100, nuclear_mw: 700,
      hydro_pumped_mw: -300, fossil_hard_coal_mw: -50,
    })
  );

  // BE — every generation column a measured zero. Total positive generation is
  // 0, so the share is undefined: null, never 0%.
  HOURS.forEach((h) => insertGeneration(db, 'BE', at(h), { solar_mw: 0, wind_onshore_mw: 0 }));

  // PT — rows exist, but this country reports no production type at all. Every
  // column NULL. Must read as no data, not as 0%.
  HOURS.forEach((h) => insertGeneration(db, 'PT', at(h), {}));

  // GR — generation stops when publication stops.
  insertGeneration(db, 'GR', at(0), { solar_mw: 50, nuclear_mw: 50 });
  insertGeneration(db, 'GR', at(1), { solar_mw: 50, nuclear_mw: 50 });

  // AT — no energy_generation rows at all (still mid-backfill). A different
  // null path than PT's: zero rows, rather than rows summing to nothing.

  // ------------------------------------------------- energy_renewable (frozen)

  const renewable = db.prepare(
    `INSERT INTO energy_renewable
       (country_code, timestamp_utc, solar_mw, wind_onshore_mw, wind_offshore_mw, total_renewable_mw)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  // DE: 100 / 120 / 140 / 160 solar.
  HOURS.forEach((h, i) => renewable.run('DE', at(h), 100 + i * 20, 200, null, 300 + i * 20));
  // BE: solar overnight — a measured zero at every hour. Sum of actuals is 0.
  HOURS.forEach((h) => renewable.run('BE', at(h), 0, 0, null, 0));

  // FR — hydro, the two-column type. `hydro_total` has no column of its own:
  // every consumer sums `hydro_run_mw + hydro_reservoir_mw`. At 02:00 the
  // reservoir reading is NULL, so the sum is NULL — unknown, not 40. A
  // COALESCE anywhere in that chain would turn an unknown into a measurement,
  // and `total_renewable_mw` is NULL in the same row for the same reason.
  const renewableHydro = db.prepare(
    `INSERT INTO energy_renewable
       (country_code, timestamp_utc, solar_mw, wind_onshore_mw, wind_offshore_mw,
        hydro_run_mw, hydro_reservoir_mw, total_renewable_mw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  renewableHydro.run('FR', at(0), 10, 20, null, 30, 70, 130);
  renewableHydro.run('FR', at(1), 10, 20, null, 35, 75, 145);
  renewableHydro.run('FR', at(2), 10, 20, null, 40, null, null);
  renewableHydro.run('FR', at(3), 10, 20, null, 45, 85, 160);

  // ---------------------------------------------------------- net_position

  const netPosition = db.prepare(
    'INSERT INTO net_position (country_code, timestamp_utc, net_position_mw) VALUES (?, ?, ?)'
  );
  // DE: 100 / 150 / 200 / 250 — avg 175.
  HOURS.forEach((h, i) => netPosition.run('DE', at(h), 100 + i * 50));
  HOURS.forEach((h) => netPosition.run('BE', at(h), -200));
  // GR: silent after 01:00, same as its load.
  netPosition.run('GR', at(0), -50);
  netPosition.run('GR', at(1), -60);
  // ...and then, a day later, publishing again but ONLY exact zeros. This is
  // GR's real production shape (ABL-35): its net position did not stop, it
  // turned into 0.0 on 2025-10-01 and has stayed there for every one of the 192
  // rows published since, while its own crossborder_flows show a median net
  // export of 1,142 MW over the same hours. Unlike the degenerate FORECAST
  // below these are exactly 0.0, so the two cases need different guards and a
  // fixture that only had one of them would let either regress.
  //
  // Deliberately outside WINDOW, so the "served" reads above are untouched and
  // the degenerate read is a different query rather than a global mode. It also
  // pins getLastSeen: the newest ROW is now 2026-07-02 03:00, but the newest
  // usable hour is 2026-07-01 01:00, and reporting the former would date the
  // outage ten months late in production.
  HOURS.forEach((h) => netPosition.run('GR', at(h, 2), 0.0));
  // LU's own rows are an ingest artifact from before the DE_LU zone mapping
  // existed. Left alone they render Luxembourg at -6201 MW beside Germany at
  // +175 MW: two contradictory colours for one bidding zone.
  netPosition.run('LU', at(0), -6201);

  // -------------------------------------------------------- ml forecasts

  const forecast = db.prepare(
    `INSERT INTO forecasts
       (country_code, forecast_type, target_timestamp_utc, generated_at, horizon_hours, forecast_value, model_name, model_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // PT load on NEXT_DAY, paired against PT's interleaved impossible zeros
  // above. This is the accuracy half of the same defect: an actual of 0.0 is
  // not a bad forecast, it is a missing measurement, and scoring against it
  // charges the model a 100% error for a number nobody took. Measured on the
  // replica 2026-08-06, this really happens — 104 ES and 8 SI hours pair with a
  // stored ML load forecast, and SI's fall inside the default 30-day window.
  HOURS.forEach((h) =>
    forecast.run('PT', 'load', atT(h, 2), GENERATED_AT, 12, 210, 'catboost', 'v1')
  );

  // DE load, catboost, D+1 (horizon 12 falls in the 0-30 band). Forecast is
  // 100 MW under the actual at every hour => MAE 100, bias +100, RMSE 100.
  HOURS.forEach((h, i) =>
    forecast.run('DE', 'load', atT(h), GENERATED_AT, 12, 900 + i * 100, 'catboost', 'v1')
  );
  // The same targets from a SUPERSEDED run. If the MAX(generated_at) dedup ever
  // stops working, these 1 MW values land in the metrics and MAE explodes — the
  // failure is loud rather than a plausible-looking drift.
  HOURS.forEach((h) =>
    forecast.run('DE', 'load', atT(h), STALE_GENERATED_AT, 12, 1, 'catboost', 'v0')
  );
  // DE load, catboost, D+2 (horizon 36 falls in the 24-54 band, and outside
  // D+1's). 200 MW under the actual => MAE 200.
  HOURS.forEach((h, i) =>
    forecast.run('DE', 'load', atT(h), GENERATED_AT, 36, 800 + i * 100, 'catboost', 'v1')
  );
  // DE load one day later: forecasts with no actual to pair against. This is
  // `no_paired_actuals`, which must not be confused with `no_model_coverage`.
  HOURS.forEach((h, i) =>
    forecast.run('DE', 'load', atT(h, 2), GENERATED_AT, 12, 900 + i * 100, 'catboost', 'v1')
  );

  // AT load, xgboost ONLY — no catboost row exists for AT anywhere in this
  // database. Asking for catboost's accuracy in AT is a well-formed question
  // whose answer is "that model does not serve this country".
  HOURS.forEach((h, i) =>
    forecast.run('AT', 'load', atT(h), GENERATED_AT, 12, 540 + i * 20, 'xgboost', 'v1')
  );

  // BE solar, catboost: forecasts 5 MW against actuals that are all a measured
  // zero. Error is real (MAE 5) but every percentage is undefined, so MAPE is
  // null and WAPE is null — never a flawless 0%.
  HOURS.forEach((h) =>
    forecast.run('BE', 'solar', atT(h), GENERATED_AT, 12, 5, 'catboost', 'v1')
  );

  // FR hydro_total and renewable, catboost. These are the two forecast types
  // whose actual-column mapping in forecastService named a column that does not
  // exist (`hydro_mw`, `total_mw`), so /forecasts/compare 500'd for both. Paired
  // against FR's rows above, including the NULL-component hour.
  HOURS.forEach((h, i) =>
    forecast.run('FR', 'hydro_total', atT(h), GENERATED_AT, 12, 95 + i * 10, 'catboost', 'v1')
  );
  HOURS.forEach((h, i) =>
    forecast.run('FR', 'renewable', atT(h), GENERATED_AT, 12, 125 + i * 10, 'catboost', 'v1')
  );
  // Two more FR hydro_total rows, PAST the end of WINDOW (04:00 and 05:00 on the
  // same day) and deliberately stored in the SPACE form, which the chronos
  // models really do write. They are the trap for the obvious-looking fix to
  // ABL-21: bounding the window with a plain 'T'-form upper bound admits every
  // space-form row later in the end day, because ' ' sorts below 'T'. Nothing
  // may return these for WINDOW.
  [4, 5].forEach((h, i) =>
    forecast.run('FR', 'hydro_total', at(h), GENERATED_AT, 12, 500 + i * 10, 'chronos-2-V010', 'V010')
  );

  // BE net position, the registered Chronos run, with a p10/p90 band.
  const quantile = db.prepare(
    `INSERT INTO forecast_quantiles
       (country_code, forecast_type, target_timestamp_utc, generated_at, quantile, forecast_value, model_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  HOURS.forEach((h) => {
    forecast.run('BE', 'net_position', at(h), '2026-06-30 18:00:00', 40, -190, 'chronos-2-V010', 'V010');
    quantile.run('BE', 'net_position', at(h), '2026-06-30 18:00:00', 0.1, -260, 'chronos-2-V010');
    quantile.run('BE', 'net_position', at(h), '2026-06-30 18:00:00', 0.9, -120, 'chronos-2-V010');
  });

  // GR net position, the same registered run, COLLAPSED TO ZERO — the values
  // are lifted from the replica (2026-08-06: 168 rows, every median between
  // 2.3e-11 and 4.6e-7 MW, band p10 -3.5e-6 to p90 0.0038 MW). Not one is
  // exactly 0.0, so an `= 0` guard misses all of them, and charted they are a
  // flat line at 0 MW under a hairline band — which reads as an unusually
  // CONFIDENT forecast. GR is the right country for this: it publishes no
  // actuals to disagree (silent after 01:00 here, since 2026-07-24 in
  // production) and pairs no points into any accuracy metric, so the chart is
  // the only place the number appears at all.
  const GR_DEGENERATE_P50 = [4.582052497426048e-7, -1.7743546720794257e-7, 2.3065367324437425e-11, -8.861614553268282e-9];
  HOURS.forEach((h, i) => {
    forecast.run('GR', 'net_position', at(h), '2026-06-30 18:00:00', 40, GR_DEGENERATE_P50[i], 'chronos-2-V010', 'V010');
    quantile.run('GR', 'net_position', at(h), '2026-06-30 18:00:00', 0.1, -0.0000034854574550990947, 'chronos-2-V010');
    quantile.run('GR', 'net_position', at(h), '2026-06-30 18:00:00', 0.9, 0.003754783421754837, 'chronos-2-V010');
  });

  // BE net position, the same window, from the registered challenger
  // baseline-V012 (ABL-177) — distinct values from the chronos-2-V010 run
  // above so a route test can prove `?model=baseline-V012` actually changes
  // which row set comes back rather than the server silently keeping
  // whatever the unpinned ladder already picked.
  HOURS.forEach((h) => {
    forecast.run('BE', 'net_position', at(h), '2026-06-30 18:00:00', 40, -170, 'baseline-V012', 'V012');
  });

  // ------------------------------------------------------- tso forecasts

  const loadForecast = db.prepare(
    `INSERT INTO energy_load_forecast
       (country_code, target_timestamp_utc, forecast_value_mw, forecast_type, forecast_min_mw, forecast_max_mw)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  // DE day-ahead: 50 MW under the actual at every hour => MAE 50.
  HOURS.forEach((h, i) => loadForecast.run('DE', at(h), 950 + i * 100, 'day_ahead', null, null));
  // DE week-ahead: 200 MW under, with the daily min/max band the D+7 series
  // carries and the day-ahead one does not.
  HOURS.forEach((h, i) =>
    loadForecast.run('DE', at(h), 800 + i * 100, 'week_ahead', 700 + i * 100, 900 + i * 100)
  );
  // NL day-ahead, ~2x the realized load at every hour. Pairs perfectly — four
  // points, no gaps — so the ONLY thing that can suppress its MAE/MAPE/RMSE is
  // the divergent-basis rule, not an empty window (ABL-277). Deliberately far
  // outside any plausible forecast error, mirroring the measured 73% MAPE.
  HOURS.forEach((h, i) =>
    loadForecast.run('NL', at(h, 2), 2 * (900 - i * 200), 'day_ahead', null, null)
  );

  const generationForecast = db.prepare(
    `INSERT INTO energy_generation_forecast
       (country_code, target_timestamp_utc, solar_mw, wind_onshore_mw, wind_offshore_mw, total_forecast_mw, forecast_type)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  // DE solar day-ahead: 10 MW under the actual at every hour => MAE 10.
  HOURS.forEach((h, i) =>
    generationForecast.run('DE', at(h), 90 + i * 20, 190, null, 280 + i * 20, 'day_ahead')
  );
  // BE solar day-ahead against the all-zero overnight actuals.
  HOURS.forEach((h) => generationForecast.run('BE', at(h), 3, 0, null, 3, 'day_ahead'));
}

/**
 * A fresh, fully-seeded in-memory fixture database.
 *
 * Call once per test file and hand it to `vi.mock('../config/database.js')`.
 * Nothing here touches the filesystem.
 */
export function buildFixtureDb(): DatabaseType {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  seed(db);
  return db;
}
