import db from '../config/database.js';
import { ForecastDataPoint, ForecastType, Granularity } from '../types/index.js';
import { timestampRange, rangeClause, rangeArgs } from '../utils/timestamp.js';
import { resolveModelCandidates } from '../config/forecastModels.js';
import { loadActualGuard } from './loadQuality.js';
import { actualsSourceFor } from './actualsSource.js';
import {
  classifyForecastSeriesBasis,
  withholdDivergentBasisSeries,
  type WithheldForecastSeries,
} from './loadForecastBasis.js';

// There used to be a second normalizer here, `normalizeForForecastsTable`,
// which kept the 'T' separator "for the forecasts table". It had the mirror of
// the ABL-21 defect: `forecasts` is 99.7% 'T' but the two chronos models write
// a space, so a 'T'-form lower bound dropped every space-form row later in the
// start day, and a 'T'-form upper bound pulled in every space-form row later in
// the end day. Neither single form is right — see `timestampRange`.

/**
 * The raw row fetch: the candidate ladder, and no rule about whether the rows
 * may be drawn.
 *
 * **Not exported.** `getForecastSeries` below is the served entry point, and
 * the only way to reach these rows from outside this module — so a caller
 * cannot get a forecast series without also getting the verdict on whether it
 * is on the same basis as the actuals it is about to be plotted against
 * (ABL-501). That is a structural version of the property
 * `loadForecastBasis.ts` states as a rule: put the rule where every consumer
 * inherits it, because a rule a caller has to remember is one somebody will
 * not. It cost ABL-493 to learn once already, when the metric-level rule sat
 * in one service and the endpoint that mattered most lived in another.
 */
function getForecastData(
  countryCode: string,
  forecastType: ForecastType,
  start: string,
  end: string,
  granularity: Granularity = 'hourly',
  horizon?: number,
  modelId?: string
): ForecastDataPoint[] {
  const upperCode = countryCode.toUpperCase();
  // Try the production model first, then the other registered ml models.
  // catboost and xgboost cover disjoint country sets, so an absolute pin would
  // blank AT/BE/FR for load rather than harmonise them. Callers can read
  // model_name off the returned rows to label what actually served.
  const candidates = resolveModelCandidates(forecastType, modelId)
    .filter((m) => m.modelName)
    .map((m) => m.modelName as string);

  for (const candidate of candidates) {
    const rows = queryForecasts(
      upperCode, forecastType, start, end, granularity, horizon, candidate
    );
    if (rows.length > 0) return rows;
  }
  return [];
}

function queryForecasts(
  upperCode: string,
  forecastType: ForecastType,
  start: string,
  end: string,
  granularity: Granularity,
  horizon: number | undefined,
  modelName: string
): ForecastDataPoint[] {
  const range = timestampRange(start, end);

  const modelClause = 'AND model_name = ?';

  // Build horizon filter clause (D+1 = 0-30h, D+2 = 24-54h)
  let horizonClause = '';
  if (horizon === 1) {
    horizonClause = 'AND horizon_hours BETWEEN 0 AND 30';
  } else if (horizon === 2) {
    horizonClause = 'AND horizon_hours BETWEEN 24 AND 54';
  }

  if (granularity === 'hourly') {
    // Use subquery to get only the most recent forecast for each timestamp
    // This deduplicates when multiple model runs exist for the same target time
    const stmt = db.prepare(`
      SELECT
        target_timestamp_utc as timestamp,
        forecast_value as value,
        forecast_type as type,
        generated_at,
        horizon_hours,
        model_name,
        model_version
      FROM forecasts f1
      WHERE country_code = ?
        AND forecast_type = ?
        AND ${rangeClause('target_timestamp_utc')}
        ${modelClause}
        ${horizonClause}
        AND generated_at = (
          SELECT MAX(f2.generated_at)
          FROM forecasts f2
          WHERE f2.country_code = f1.country_code
            AND f2.forecast_type = f1.forecast_type
            AND f2.target_timestamp_utc = f1.target_timestamp_utc
            ${modelClause.replace('model_name', 'f2.model_name')}
            ${horizonClause}
        )
      ORDER BY target_timestamp_utc
    `);
    return stmt.all(
      upperCode, forecastType, ...rangeArgs(range), modelName, modelName
    ) as ForecastDataPoint[];
  }

  // Aggregated queries for daily/weekly/monthly
  const groupByClause = getGroupByClause(granularity);
  const stmt = db.prepare(`
    SELECT
      ${groupByClause} as timestamp,
      ROUND(AVG(forecast_value), 2) as value,
      forecast_type as type,
      MAX(generated_at) as generated_at,
      ROUND(AVG(horizon_hours), 0) as horizon_hours
    FROM forecasts
    WHERE country_code = ?
      AND forecast_type = ?
      AND ${rangeClause('target_timestamp_utc')}
      ${modelClause}
      ${horizonClause}
    GROUP BY ${groupByClause}
    ORDER BY timestamp
  `);
  return stmt.all(
    upperCode, forecastType, ...rangeArgs(range), modelName
  ) as ForecastDataPoint[];
}

export interface ServedForecastSeries extends WithheldForecastSeries<ForecastDataPoint> {
  /**
   * Which model produced these rows — or produced the rows that were withheld.
   *
   * Read **before** the withholding, deliberately. Naming who produced an
   * unusable series is the honest half of the answer and it is what separates
   * this from the no-rows case, where there is no model to name; the
   * degenerate net-position forecast keeps `model_name` for exactly the same
   * reason (`netPositionService.ts`). Taking it off `data[0]` after the fact
   * would silently turn "catboost's 96 rows are withheld" into "nothing
   * served", which is the collapse `withheldPoints` exists to prevent.
   */
  model: string | null;
}

/**
 * A forecast series as it may be served: the ladder's rows, minus any the
 * divergent-basis rule withholds, plus the reason and who produced them.
 *
 * Every route that hands a forecast series to a caller goes through here.
 */
export function getForecastSeries(
  countryCode: string,
  forecastType: ForecastType,
  start: string,
  end: string,
  granularity: Granularity = 'hourly',
  horizon?: number,
  modelId?: string
): ServedForecastSeries {
  const rows = getForecastData(countryCode, forecastType, start, end, granularity, horizon, modelId);
  return {
    ...withholdDivergentBasisSeries(countryCode, forecastType, rows),
    model: rows[0]?.model_name ?? null,
  };
}

export function getLatestForecast(
  countryCode: string,
  forecastType?: ForecastType
) {
  const upperCode = countryCode.toUpperCase();

  // Get the most recent forecast batch
  const latestGenerated = db.prepare(`
    SELECT MAX(generated_at) as generated_at
    FROM forecasts
    WHERE country_code = ?
    ${forecastType ? 'AND forecast_type = ?' : ''}
  `);

  const params = forecastType ? [upperCode, forecastType] : [upperCode];
  const { generated_at } = latestGenerated.get(...params) as { generated_at: string | null };

  if (!generated_at) {
    return [];
  }

  // Fetch all forecasts from that batch
  const stmt = db.prepare(`
    SELECT
      target_timestamp_utc as timestamp,
      forecast_value as value,
      forecast_type as type,
      generated_at,
      horizon_hours,
      model_name,
      model_version
    FROM forecasts
    WHERE country_code = ?
      AND generated_at = ?
      ${forecastType ? 'AND forecast_type = ?' : ''}
    ORDER BY forecast_type, target_timestamp_utc
  `);

  const fetchParams = forecastType
    ? [upperCode, generated_at, forecastType]
    : [upperCode, generated_at];

  return stmt.all(...fetchParams) as ForecastDataPoint[];
}

export function getAvailableForecastTypes(countryCode: string): string[] {
  const upperCode = countryCode.toUpperCase();

  const stmt = db.prepare(`
    SELECT DISTINCT forecast_type
    FROM forecasts
    WHERE country_code = ?
    ORDER BY forecast_type
  `);

  const result = stmt.all(upperCode) as Array<{ forecast_type: string }>;
  return result.map(r => r.forecast_type);
}

export function getForecastWithActuals(
  countryCode: string,
  forecastType: ForecastType,
  start: string,
  end: string
) {
  const upperCode = countryCode.toUpperCase();
  const range = timestampRange(start, end);

  // Which table and value an actual is read from is `actualsSource.ts`
  // (ABL-399). This function used to carry its own copy of that mapping under a
  // comment promising it was "kept identical to the mapping every other
  // consumer already uses … so the three cannot drift apart again" — three
  // literals and a comment, which is the arrangement that comment describes the
  // risk of. There is now one mapping and no promise to keep.
  //
  // That copy also asserted that the hydro sum was "deliberately not COALESCE'd
  // to 0: if either component is NULL the total is unknown, and `NULL + 30`
  // reading as 30 would invent a measurement". True of a bare COALESCE, and not
  // true of the guarded reduction that replaces it — see `actualsSource.ts` for
  // why, and for the measurement (BE reports no reservoir hydro at all, in all
  // 49,213 rows, so NULL-propagation made Belgium's hydro unmeasurable rather
  // than unknown).
  const source = actualsSourceFor(forecastType);
  if (!source) {
    return {
      forecasts: [],
      actuals: [],
      ...classifyForecastSeriesBasis(countryCode, forecastType),
      withheldPoints: 0,
    };
  }

  // Get forecasts
  const forecastStmt = db.prepare(`
    SELECT
      target_timestamp_utc as timestamp,
      forecast_value as value,
      generated_at,
      horizon_hours
    FROM forecasts
    WHERE country_code = ?
      AND forecast_type = ?
      AND ${rangeClause('target_timestamp_utc')}
    ORDER BY target_timestamp_utc
  `);
  const forecasts = forecastStmt.all(upperCode, forecastType, ...rangeArgs(range));

  // Get actuals
  //
  // `loadActualGuard` and not a bare `> 0`: this query is generic over forecast
  // type, and a `0.0` is impossible only for `load`. It is completely ordinary
  // for `solar` overnight, for `wind_*` in still air, and for a `price` hour
  // that cleared at zero — BE's fixture day is negative throughout. A blanket
  // floor here would delete real measurements and bias every renewable metric
  // upward, which is the same defect pointing the other way.
  //
  // `IS NOT NULL` is new with ABL-399 and is load-bearing now that the actuals
  // come from `energy_generation`. The frozen table's `DEFAULT 0` meant a value
  // always existed, so this filter would have been dead; `energy_generation`
  // stores NULL for a production type a country does not report, and an
  // unfiltered read would serve `{ timestamp, value: null }` points — an
  // invitation for any consumer writing `value ?? 0` to turn "we hold no
  // reading" into "it generated nothing". A gap is expressed by the point's
  // absence, which is what the accuracy joins beside this one already do with
  // their `WHERE ... IS NOT NULL`, and what the FR 2026-07-01..22
  // `energy_generation` coverage hole (ABL-323/ABL-328) has to render as.
  //
  // This site was the last unguarded `energy_load` read (ABL-262). It is the
  // ABL-60 shape again: measured read-only against prod 2026-08-12, a
  // `?country=MK&type=load` window over 2026-08-01..03 returned 24 actuals of
  // which all 24 were exactly `0` MW, against MK's documented 543-717 MW daily
  // peak — served as real measurements by a live public endpoint that the Load
  // tab already fetches on every render.
  const actualStmt = db.prepare(`
    SELECT
      timestamp_utc as timestamp,
      ${source.valueExpr('')} as value
    FROM ${source.table}
    WHERE country_code = ?
      AND ${rangeClause('timestamp_utc')}
      AND ${source.valueExpr('')} IS NOT NULL
      ${loadActualGuard(forecastType, source.valueExpr(''))}
    ORDER BY timestamp_utc
  `);
  const actuals = actualStmt.all(upperCode, ...rangeArgs(range));

  // The forecasts go, the actuals stay. This endpoint's whole point is that
  // the two arrays are the same window of the same quantity, so on a
  // divergent-basis pair it is the *pairing* that is the false claim — the
  // realized series is a true measurement and withholding it would assert a
  // gap in data we hold in full (ABL-501). `withheldPoints` says how many
  // forecast rows are being held back, so a consumer can tell this apart from
  // a country that simply has no forecast.
  const withheld = withholdDivergentBasisSeries(countryCode, forecastType, forecasts);
  return {
    forecasts: withheld.data,
    actuals,
    basis: withheld.basis,
    basisNote: withheld.basisNote,
    withheldPoints: withheld.withheldPoints,
  };
}

function getGroupByClause(granularity: Granularity): string {
  switch (granularity) {
    case 'daily':
      return "date(target_timestamp_utc)";
    case 'weekly':
      return "strftime('%Y-W%W', target_timestamp_utc)";
    case 'monthly':
      return "strftime('%Y-%m', target_timestamp_utc)";
    default:
      return "target_timestamp_utc";
  }
}

export interface MultiHorizonDataPoint {
  timestamp: string;
  forecast_d1?: number;
  forecast_d2?: number;
}

/**
 * Get multi-horizon forecasts (D+1 and D+2) for overlay view
 */
export function getMultiHorizonForecastData(
  countryCode: string,
  forecastType: ForecastType,
  start: string,
  end: string
): WithheldForecastSeries<MultiHorizonDataPoint> {
  const upperCode = countryCode.toUpperCase();
  const range = timestampRange(start, end);

  // Get D+1 forecasts (horizon 0-30 hours)
  const d1Stmt = db.prepare(`
    SELECT
      target_timestamp_utc as timestamp,
      forecast_value as value
    FROM forecasts f1
    WHERE country_code = ?
      AND forecast_type = ?
      AND ${rangeClause('target_timestamp_utc')}
      AND horizon_hours BETWEEN 0 AND 30
      AND generated_at = (
        SELECT MAX(f2.generated_at)
        FROM forecasts f2
        WHERE f2.country_code = f1.country_code
          AND f2.forecast_type = f1.forecast_type
          AND f2.target_timestamp_utc = f1.target_timestamp_utc
          AND f2.horizon_hours BETWEEN 0 AND 30
      )
    ORDER BY target_timestamp_utc
  `);
  const d1Data = d1Stmt.all(upperCode, forecastType, ...rangeArgs(range)) as Array<{ timestamp: string; value: number }>;

  // Get D+2 forecasts (horizon 24-54 hours)
  const d2Stmt = db.prepare(`
    SELECT
      target_timestamp_utc as timestamp,
      forecast_value as value
    FROM forecasts f1
    WHERE country_code = ?
      AND forecast_type = ?
      AND ${rangeClause('target_timestamp_utc')}
      AND horizon_hours BETWEEN 24 AND 54
      AND generated_at = (
        SELECT MAX(f2.generated_at)
        FROM forecasts f2
        WHERE f2.country_code = f1.country_code
          AND f2.forecast_type = f1.forecast_type
          AND f2.target_timestamp_utc = f1.target_timestamp_utc
          AND f2.horizon_hours BETWEEN 24 AND 54
      )
    ORDER BY target_timestamp_utc
  `);
  const d2Data = d2Stmt.all(upperCode, forecastType, ...rangeArgs(range)) as Array<{ timestamp: string; value: number }>;

  // Merge into a map by timestamp
  const dataMap = new Map<string, MultiHorizonDataPoint>();

  for (const item of d1Data) {
    dataMap.set(item.timestamp, { timestamp: item.timestamp, forecast_d1: item.value });
  }

  for (const item of d2Data) {
    const existing = dataMap.get(item.timestamp);
    if (existing) {
      existing.forecast_d2 = item.value;
    } else {
      dataMap.set(item.timestamp, { timestamp: item.timestamp, forecast_d2: item.value });
    }
  }

  // Convert to array and sort by timestamp
  const merged = Array.from(dataMap.values()).sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Same series, split by horizon — so the divergent-basis rule applies for
  // the same reason it applies to `getForecastSeries`, and splitting a
  // gross-basis forecast into D+1 and D+2 does not make either half comparable
  // with a net-basis actual.
  return withholdDivergentBasisSeries(countryCode, forecastType, merged);
}
