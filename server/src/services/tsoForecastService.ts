import db from '../config/database.js';
import { Granularity } from '../types/index.js';
import { timestampRange, rangeClause, rangeArgs } from '../utils/timestamp.js';
import { measuredLoadClause } from './loadQuality.js';
import { applyLoadForecastBasis } from './loadForecastBasis.js';
import { wape } from './wape.js';

// Valid generation types for SQL column interpolation - prevents injection
const VALID_GENERATION_TYPES = ['solar', 'wind_onshore', 'wind_offshore'] as const;
type ValidGenerationType = typeof VALID_GENERATION_TYPES[number];

export interface TSOLoadForecastDataPoint {
  timestamp: string;
  forecast_value_mw: number;
  forecast_min_mw: number | null;
  forecast_max_mw: number | null;
  forecast_type: string;
  publication_timestamp_utc: string | null;
}

export interface TSOGenerationForecastDataPoint {
  timestamp: string;
  solar_mw: number | null;
  wind_onshore_mw: number | null;
  wind_offshore_mw: number | null;
  total_forecast_mw: number | null;
}

export interface ForecastAccuracyDataPoint {
  timestamp: string;
  forecast_value: number;
  actual_value: number;
  error: number;
  error_pct: number | null;
}

export type TSOForecastType = 'day_ahead' | 'week_ahead' | 'all';

/**
 * Get TSO load forecasts for a country
 */
export function getLoadForecast(
  countryCode: string,
  start: string,
  end: string,
  forecastType: TSOForecastType = 'day_ahead',
  granularity: Granularity = 'hourly'
): TSOLoadForecastDataPoint[] {
  const upperCode = countryCode.toUpperCase();
  const range = timestampRange(start, end);

  // Week-ahead forecasts have daily granularity with min/max values
  if (forecastType === 'week_ahead') {
    const stmt = db.prepare(`
      SELECT
        date(target_timestamp_utc) || 'T12:00:00Z' as timestamp,
        ROUND(AVG(forecast_value_mw), 2) as forecast_value_mw,
        ROUND(MIN(forecast_min_mw), 2) as forecast_min_mw,
        ROUND(MAX(forecast_max_mw), 2) as forecast_max_mw,
        forecast_type,
        MAX(publication_timestamp_utc) as publication_timestamp_utc
      FROM energy_load_forecast
      WHERE country_code = ?
        AND ${rangeClause('target_timestamp_utc')}
        AND forecast_type = 'week_ahead'
      GROUP BY date(target_timestamp_utc)
      ORDER BY timestamp
    `);
    return stmt.all(upperCode, ...rangeArgs(range)) as TSOLoadForecastDataPoint[];
  }

  // Day-ahead forecasts: no min/max
  let whereClause = `country_code = ? AND ${rangeClause('target_timestamp_utc')}`;
  const params: (string | number)[] = [upperCode, ...rangeArgs(range)];

  if (forecastType !== 'all') {
    whereClause += ' AND forecast_type = ?';
    params.push(forecastType);
  }

  if (granularity === 'hourly') {
    // For hourly, aggregate 15-min data to hourly
    const stmt = db.prepare(`
      SELECT
        strftime('%Y-%m-%dT%H:00:00Z', target_timestamp_utc) as timestamp,
        ROUND(AVG(forecast_value_mw), 2) as forecast_value_mw,
        NULL as forecast_min_mw,
        NULL as forecast_max_mw,
        forecast_type,
        MAX(publication_timestamp_utc) as publication_timestamp_utc
      FROM energy_load_forecast
      WHERE ${whereClause}
      GROUP BY strftime('%Y-%m-%dT%H:00:00Z', target_timestamp_utc), forecast_type
      ORDER BY timestamp, forecast_type
    `);
    return stmt.all(...params) as TSOLoadForecastDataPoint[];
  }

  // For daily/weekly/monthly aggregation
  const groupByClause = getGroupByClause(granularity);
  const stmt = db.prepare(`
    SELECT
      ${groupByClause} as timestamp,
      ROUND(AVG(forecast_value_mw), 2) as forecast_value_mw,
      NULL as forecast_min_mw,
      NULL as forecast_max_mw,
      forecast_type,
      MAX(publication_timestamp_utc) as publication_timestamp_utc
    FROM energy_load_forecast
    WHERE ${whereClause}
    GROUP BY ${groupByClause}, forecast_type
    ORDER BY timestamp, forecast_type
  `);
  return stmt.all(...params) as TSOLoadForecastDataPoint[];
}

/**
 * Get TSO generation forecasts (solar + wind) for a country
 */
export function getGenerationForecast(
  countryCode: string,
  start: string,
  end: string,
  granularity: Granularity = 'hourly'
): TSOGenerationForecastDataPoint[] {
  const upperCode = countryCode.toUpperCase();
  const range = timestampRange(start, end);

  if (granularity === 'hourly') {
    const stmt = db.prepare(`
      SELECT
        REPLACE(target_timestamp_utc, ' ', 'T') as timestamp,
        ROUND(solar_mw, 2) as solar_mw,
        ROUND(wind_onshore_mw, 2) as wind_onshore_mw,
        ROUND(wind_offshore_mw, 2) as wind_offshore_mw,
        ROUND(total_forecast_mw, 2) as total_forecast_mw
      FROM energy_generation_forecast
      WHERE country_code = ?
        AND ${rangeClause('target_timestamp_utc')}
      ORDER BY target_timestamp_utc
    `);
    return stmt.all(upperCode, ...rangeArgs(range)) as TSOGenerationForecastDataPoint[];
  }

  // For aggregated granularity
  const groupByClause = getGroupByClause(granularity);
  const stmt = db.prepare(`
    SELECT
      ${groupByClause} as timestamp,
      ROUND(AVG(solar_mw), 2) as solar_mw,
      ROUND(AVG(wind_onshore_mw), 2) as wind_onshore_mw,
      ROUND(AVG(wind_offshore_mw), 2) as wind_offshore_mw,
      ROUND(AVG(total_forecast_mw), 2) as total_forecast_mw
    FROM energy_generation_forecast
    WHERE country_code = ?
      AND ${rangeClause('target_timestamp_utc')}
    GROUP BY ${groupByClause}
    ORDER BY timestamp
  `);
  return stmt.all(upperCode, ...rangeArgs(range)) as TSOGenerationForecastDataPoint[];
}

/**
 * Get load forecast accuracy by comparing forecast vs actual
 */
export function getLoadForecastAccuracy(
  countryCode: string,
  start: string,
  end: string,
  forecastType: TSOForecastType = 'day_ahead',
  granularity: Granularity = 'hourly'
): ForecastAccuracyDataPoint[] {
  const upperCode = countryCode.toUpperCase();
  const range = timestampRange(start, end);

  let forecastTypeFilter = '';
  const params: (string | number)[] = [upperCode, ...rangeArgs(range)];

  if (forecastType !== 'all') {
    forecastTypeFilter = 'AND forecast_type = ?';
    params.push(forecastType);
  }

  if (granularity === 'hourly') {
    // Join forecast with actual load data, aggregating 15-min to hourly
    const stmt = db.prepare(`
      WITH hourly_forecast AS (
        SELECT
          strftime('%Y-%m-%dT%H:00:00Z', target_timestamp_utc) as timestamp,
          ROUND(AVG(forecast_value_mw), 2) as forecast_value
        FROM energy_load_forecast
        WHERE country_code = ?
          AND ${rangeClause('target_timestamp_utc')}
          ${forecastTypeFilter}
        GROUP BY strftime('%Y-%m-%dT%H:00:00Z', target_timestamp_utc)
      ),
      hourly_actual AS (
        SELECT
          strftime('%Y-%m-%dT%H:00:00Z', timestamp_utc) as timestamp,
          ROUND(AVG(load_mw), 2) as actual_value
        FROM energy_load
        WHERE country_code = ?
          AND ${measuredLoadClause()}
          AND ${rangeClause('timestamp_utc')}
        GROUP BY strftime('%Y-%m-%dT%H:00:00Z', timestamp_utc)
      )
      SELECT
        f.timestamp,
        f.forecast_value,
        a.actual_value,
        ROUND(a.actual_value - f.forecast_value, 2) as error,
        CASE
          WHEN a.actual_value > 0 THEN ROUND(100.0 * ABS(a.actual_value - f.forecast_value) / a.actual_value, 2)
          ELSE NULL
        END as error_pct
      FROM hourly_forecast f
      INNER JOIN hourly_actual a ON f.timestamp = a.timestamp
      ORDER BY f.timestamp
    `);
    // Need to add country and date range params twice (for forecast and actual CTEs)
    return stmt.all(...params, upperCode, ...rangeArgs(range)) as ForecastAccuracyDataPoint[];
  }

  // For aggregated granularity
  const groupByClause = getGroupByClause(granularity);
  const stmt = db.prepare(`
    WITH agg_forecast AS (
      SELECT
        ${groupByClause.replace('timestamp_utc', 'target_timestamp_utc')} as timestamp,
        ROUND(AVG(forecast_value_mw), 2) as forecast_value
      FROM energy_load_forecast
      WHERE country_code = ?
        AND ${rangeClause('target_timestamp_utc')}
        ${forecastTypeFilter}
      GROUP BY ${groupByClause.replace('timestamp_utc', 'target_timestamp_utc')}
    ),
    agg_actual AS (
      SELECT
        ${groupByClause} as timestamp,
        ROUND(AVG(load_mw), 2) as actual_value
      FROM energy_load
      WHERE country_code = ?
        AND ${measuredLoadClause()}
        AND ${rangeClause('timestamp_utc')}
      GROUP BY ${groupByClause}
    )
    SELECT
      f.timestamp,
      f.forecast_value,
      a.actual_value,
      ROUND(a.actual_value - f.forecast_value, 2) as error,
      CASE
        WHEN a.actual_value > 0 THEN ROUND(100.0 * ABS(a.actual_value - f.forecast_value) / a.actual_value, 2)
        ELSE NULL
      END as error_pct
    FROM agg_forecast f
    INNER JOIN agg_actual a ON f.timestamp = a.timestamp
    ORDER BY f.timestamp
  `);
  return stmt.all(...params, upperCode, ...rangeArgs(range)) as ForecastAccuracyDataPoint[];
}

/**
 * Get generation forecast accuracy for a specific type (solar, wind_onshore, wind_offshore)
 *
 * ## Why `energy_generation` and not `energy_renewable` (ABL-324, tranche 3 of 3)
 *
 * Both queries below used to pair `energy_generation_forecast` against the
 * frozen `energy_renewable`. That table is the wrong actuals source for an
 * accuracy metric in three independent ways, each measured on the replica
 * 2026-08-13 and each removed by the move:
 *
 * 1. **It fabricates the actual.** `energy_renewable` carries `DEFAULT 0` on
 *    every `*_mw` column, so a type a country does not report is stored as a
 *    literal `0.0` rather than as NULL. `energy_generation` deliberately has no
 *    such default. Fleet-wide, over full history, **477,846 pairs** existed
 *    only because of that default — 477,838 of them (99.998%) with the frozen
 *    table holding exactly `0.0` — and the pathology is concentrated in
 *    `wind_offshore_mw`, where **436,069 of 661,077 pairs (66%) were
 *    fabricated**. For 23 countries with no offshore fleet at all (AT, CZ, HU,
 *    LT, RO, SE, SK, …) *every* pair was a fabricated `0.0` actual against a
 *    `0.0` forecast, which `calculateMetrics` published as
 *    `mae: 0, rmse: 0` over thousands of `dataPoints` — a flawless
 *    offshore-wind forecast for a landlocked country. Those pairs now do not
 *    exist, so the endpoint reports `dataPoints: 0` and null metrics: we did
 *    not measure it.
 * 2. **It silently drops variant-spelled actuals.** `energy_renewable` holds
 *    90,636 rows whose `timestamp_utc` is `T`-separated or carries a trailing
 *    offset, while `energy_generation_forecast` is 100% space-form. A string
 *    equality cannot match those, so the pair was dropped from the join with no
 *    error and no empty state — silent sample loss from an accuracy figure.
 *    Measured on the 90,636 rows themselves: **60,494 solar / 69,056
 *    wind_onshore / 70,408 wind_offshore** pairs across **28 countries** were
 *    being discarded this way.
 * 3. **It covers far less.** 829,568 rows against `energy_generation`'s
 *    3,178,270.
 *
 * ## Why the plain equality join below is correct, and when it would stop being
 *
 * `mlForecastService` and `crossCountryMetricsService` join their actuals
 * through `timestampFormOnClause` as two LEFT JOINs plus a `COALESCE`, because
 * their actuals tables hold both separator forms and a naive `IN (...)` join
 * would fan out across a conflicting pair. Neither condition holds here once
 * the actuals come from `energy_generation`, measured 2026-08-13:
 *
 *  - `energy_generation` is **0 `T`-form / 0 non-19-length rows out of
 *    3,178,270**, and `energy_generation_forecast` is **0 / 0 out of
 *    3,050,001**. Both sides of this join are space-form by construction, so
 *    there is no second spelling to be agnostic about.
 *  - Both tables have **zero** duplicate `(country_code, instant)` keys, so the
 *    join is one-to-at-most-one and cannot fan out.
 *
 * Adding the two-LEFT-JOIN shape would therefore cost the index seek and buy
 * nothing today. That is a claim about a measurement, not a guarantee: if a
 * future ingest change reintroduces `T`-form rows into either table, this join
 * silently drops them again and needs the `timestampFormOnClause` pair.
 * `routes/tsoForecast.test.ts` pins the shape that would catch it.
 *
 * ## Two costs, both signed off under ABL-324 and both visible here
 *
 *  - `energy_generation` lacks hours `energy_renewable` has — measured, FR
 *    2026-07-01..07-22 (2,073 rows) and BA (92). An `INNER JOIN` renders those
 *    as **absent points**, never as a zero, which is the required behaviour.
 *  - No NULL-aware total is involved at either site. `solar` / `wind_onshore` /
 *    `wind_offshore` are single columns carrying identical names in both
 *    tables, so this is a table swap, not a re-derivation, and
 *    `renewableTotal.ts`'s `sumOrNull` has nothing to reduce here. It is
 *    deliberately not imported rather than threaded through a one-element sum.
 */
export function getGenerationForecastAccuracy(
  countryCode: string,
  start: string,
  end: string,
  generationType: 'solar' | 'wind_onshore' | 'wind_offshore',
  granularity: Granularity = 'hourly'
): ForecastAccuracyDataPoint[] {
  // Validate generation type to prevent SQL injection via column interpolation
  if (!VALID_GENERATION_TYPES.includes(generationType)) {
    throw new Error(`Invalid generation type: ${generationType}`);
  }
  
  const upperCode = countryCode.toUpperCase();
  const range = timestampRange(start, end);

  const forecastColumn = `${generationType}_mw`;
  const actualColumn = `${generationType}_mw`;

  if (granularity === 'hourly') {
    const stmt = db.prepare(`
      SELECT
        f.target_timestamp_utc as timestamp,
        ROUND(f.${forecastColumn}, 2) as forecast_value,
        ROUND(a.${actualColumn}, 2) as actual_value,
        ROUND(a.${actualColumn} - f.${forecastColumn}, 2) as error,
        CASE
          WHEN a.${actualColumn} > 0 THEN ROUND(100.0 * ABS(a.${actualColumn} - f.${forecastColumn}) / a.${actualColumn}, 2)
          ELSE NULL
        END as error_pct
      FROM energy_generation_forecast f
      INNER JOIN energy_generation a
        ON f.country_code = a.country_code
        AND f.target_timestamp_utc = a.timestamp_utc
      WHERE f.country_code = ?
        AND ${rangeClause('f.target_timestamp_utc')}
        AND f.${forecastColumn} IS NOT NULL
        AND a.${actualColumn} IS NOT NULL
      ORDER BY f.target_timestamp_utc
    `);
    return stmt.all(upperCode, ...rangeArgs(range)) as ForecastAccuracyDataPoint[];
  }

  // For aggregated granularity
  const groupByClause = getGroupByClause(granularity);
  const stmt = db.prepare(`
    WITH agg_forecast AS (
      SELECT
        ${groupByClause.replace('timestamp_utc', 'target_timestamp_utc')} as timestamp,
        ROUND(AVG(${forecastColumn}), 2) as forecast_value
      FROM energy_generation_forecast
      WHERE country_code = ?
        AND ${rangeClause('target_timestamp_utc')}
        AND ${forecastColumn} IS NOT NULL
      GROUP BY ${groupByClause.replace('timestamp_utc', 'target_timestamp_utc')}
    ),
    agg_actual AS (
      SELECT
        ${groupByClause} as timestamp,
        ROUND(AVG(${actualColumn}), 2) as actual_value
      FROM energy_generation
      WHERE country_code = ?
        AND ${rangeClause('timestamp_utc')}
        AND ${actualColumn} IS NOT NULL
      GROUP BY ${groupByClause}
    )
    SELECT
      f.timestamp,
      f.forecast_value,
      a.actual_value,
      ROUND(a.actual_value - f.forecast_value, 2) as error,
      CASE
        WHEN a.actual_value > 0 THEN ROUND(100.0 * ABS(a.actual_value - f.forecast_value) / a.actual_value, 2)
        ELSE NULL
      END as error_pct
    FROM agg_forecast f
    INNER JOIN agg_actual a ON f.timestamp = a.timestamp
    ORDER BY f.timestamp
  `);
  return stmt.all(upperCode, ...rangeArgs(range), upperCode, ...rangeArgs(range)) as ForecastAccuracyDataPoint[];
}

/**
 * Get aggregate accuracy metrics
 */
/**
 * Aggregate D+1/D+7 load accuracy for a country.
 *
 * The basis check is applied **here**, not in the routes, so that every caller
 * gets it — `/accuracy/load/:cc`, `/metrics/:cc` and anything added later.
 * A country whose realized load and TSO forecast measure different quantities
 * comes back with `mae`/`mape`/`rmse` null and a `basisNote` saying why; see
 * `loadForecastBasis.ts` for the measurement behind that. Putting the rule in
 * the routes would have made it a convention someone has to remember.
 */
export function getLoadForecastAccuracyMetrics(
  countryCode: string,
  start: string,
  end: string,
  forecastType: TSOForecastType = 'day_ahead'
) {
  const data = getLoadForecastAccuracy(countryCode, start, end, forecastType, 'hourly');
  return applyLoadForecastBasis(countryCode, calculateMetrics(data));
}

export function getGenerationForecastAccuracyMetrics(
  countryCode: string,
  start: string,
  end: string,
  generationType: 'solar' | 'wind_onshore' | 'wind_offshore'
) {
  const data = getGenerationForecastAccuracy(countryCode, start, end, generationType, 'hourly');
  return calculateMetrics(data);
}

/**
 * Accuracy metrics over paired forecast/actual points.
 *
 * Returns nulls rather than zeros for an empty window: zeros render as
 * "MAE 0 MW / MAPE 0%", which reads as a flawless forecast when nothing was
 * measured at all.
 *
 * `mape` covers only points with a positive actual — a percentage error is
 * undefined at zero. Those points previously contributed 0, which understated
 * mape wherever actuals legitimately hit zero (solar overnight).
 *
 * ## `wape` is the percentage error to read; `mape` is kept for continuity
 *
 * ABL-388. MAPE divides each point by its own actual, so it is dominated by
 * whichever point had the smallest denominator. On a generation series that
 * passes through near-zero at dawn and dusk every day, that is not a small
 * effect — measured on the replica 2026-08-13 over full history, this exact
 * function reported **HU solar 7,421.87%** and **NL solar 6,866.02%** while
 * the same pairs give a WAPE of 13.12% and (see the caveat below) 1,727.81%.
 * The `actual > 0` guard above prevents division *by zero*; nothing there
 * prevents division by 0.4 MW.
 *
 * `wape` is served **beside** `mape` rather than replacing it, so an existing
 * consumer of this shape keeps the field it reads. `mae` and `rmse` are
 * magnitude measures and were never affected.
 *
 * Three things about the sample, because they differ per measure and a caller
 * comparing them needs to know which rows each covers:
 *
 * - `dataPoints` is WAPE's sample — every paired row, including the
 *   zero-actual ones MAPE must skip. There is no `wapeSamples` field because
 *   it would be `dataPoints` by construction.
 * - `mapeSamples` stays the MAPE sample (`actual > 0`), and is `<= dataPoints`.
 * - `wape` is `null`, never `0`, when the window's actuals sum to zero — a
 *   country must not read as a flawless 0% because it reported nothing.
 *
 * **A WAPE is only forecast skill where both series measure the same
 * population.** Where they do not it is arithmetically correct and still not
 * an accuracy figure: NL solar's ENTSO-E day-ahead forecast sums to 18.28x our
 * metered actuals over full history, which is `solarCoverage.ts`'s established
 * `partial_subset` finding rather than a forecast miss, and it survives the
 * switch to WAPE unchanged. That is a basis question — the generation-side
 * counterpart of what `loadForecastBasis.ts` already suppresses for NL load —
 * and it is deliberately not answered here; see ABL-400.
 */
export function calculateMetrics(data: ForecastAccuracyDataPoint[]) {
  if (data.length === 0) {
    return { mae: null, mape: null, wape: null, rmse: null, dataPoints: 0, mapeSamples: 0 };
  }

  const n = data.length;
  const round2 = (x: number) => Math.round(x * 100) / 100;

  const mae = data.reduce((sum, d) => sum + Math.abs(d.error), 0) / n;
  const rmse = Math.sqrt(data.reduce((sum, d) => sum + d.error * d.error, 0) / n);

  const pctPoints = data.filter((d) => d.error_pct != null);
  const mape = pctPoints.length
    ? pctPoints.reduce((sum, d) => sum + (d.error_pct as number), 0) / pctPoints.length
    : null;

  // The one WAPE definition, shared with the cross-country heatmap. It does
  // its own null/non-finite handling, so this passes every paired row.
  const wapeValue = wape(
    data.map((d) => ({ actual: d.actual_value, forecast: d.forecast_value }))
  );

  return {
    mae: round2(mae),
    mape: mape == null ? null : round2(mape),
    wape: wapeValue,
    rmse: round2(rmse),
    dataPoints: n,
    mapeSamples: pctPoints.length,
  };
}

function getGroupByClause(granularity: Granularity): string {
  switch (granularity) {
    case 'daily':
      return "date(timestamp_utc)";
    case 'weekly':
      return "strftime('%Y-W%W', timestamp_utc)";
    case 'monthly':
      return "strftime('%Y-%m', timestamp_utc)";
    default:
      return "timestamp_utc";
  }
}
