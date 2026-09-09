import { ForecastType } from '../types/index.js';
import * as tsoForecastService from './tsoForecastService.js';
import * as mlForecastService from './mlForecastService.js';
import type { LoadForecastBasis, MeasuresClassified } from './loadForecastBasis.js';

/**
 * Forecast Comparison Service
 *
 * Provides unified comparison between different forecast providers (TSO, ML)
 * and horizons (day-ahead, week-ahead for TSO; D+1, D+2 for ML).
 */

// Forecast types that have corresponding TSO forecasts
const TSO_FORECAST_TYPES = ['load', 'solar', 'wind_onshore', 'wind_offshore'] as const;
type TSOForecastableType = typeof TSO_FORECAST_TYPES[number];

export interface AccuracyMetrics {
  /**
   * Mean Absolute Error (MW or EUR/MWh).
   *
   * Nullable since ABL-277: a country whose actuals and TSO forecast measure
   * different quantities pairs points but has no publishable error, so
   * `dataPoints > 0` no longer implies a number here. It must stay null — the
   * `?? 0` this replaced published the Netherlands as a flawless 0 MW while
   * the two series were 2,435 MW apart on average.
   */
  mae: number | null;
  mape: number | null; // Mean Absolute Percentage Error (%) — null when no point had a measurable (positive) actual
  /**
   * Weighted Absolute Percentage Error — `100 * sum|actual - forecast| / sum|actual|`.
   * The ranking measure (ABL-388): MAPE divides each point by its own actual,
   * so a series that goes to zero nightly is unbounded — measured BE solar at
   * 58,186% MAPE against 62.37% WAPE. Null on a divergent basis and when the
   * window's actuals sum to zero.
   *
   * Optional, not just nullable: this field did not exist on servers built
   * before this branch, which omit the key entirely rather than sending
   * `null` — and a client can deploy ahead of the server in a staged rollout.
   * Every assembly point in this module always sets it; the optionality
   * documents the wire contract for a caller that might be talking to an
   * older server, not this server's own behaviour.
   */
  wape?: number | null;
  rmse: number | null;     // Root Mean Square Error
  /**
   * Mean Error (positive = over-forecast), null on a divergent basis — there
   * the mean difference is the definitional gap between two quantities, and
   * reporting it as forecast bias is the same false claim as reporting MAE.
   */
  bias: number | null;
  dataPoints: number;
  /**
   * Whether this provider's forecast and the actuals it was scored against
   * measure the same quantity (ABL-277).
   *
   * Present on **load** blocks only, on both providers, and absent on every
   * other forecast type — the registry records a load finding, so a verdict
   * stamped on NL's price or solar block would assert a classification nobody
   * made. `'comparable'` is the registry reporting no finding, never "examined
   * and cleared".
   *
   * It exists because blanking alone is ambiguous: `mae: null` with
   * `dataPoints: 4` is indistinguishable from a metric that happened not to
   * compute unless something says the rows were withheld (ABL-628). The client
   * already knows what to do with it — `modelComparison.ts` renders a
   * `divergent_basis` row from exactly these two fields.
   */
  basis?: LoadForecastBasis;
  /** Non-null exactly when `basis` is `divergent_basis`: the sentence to print instead of numbers. */
  basisNote?: string | null;
}

/**
 * Compile-time: every error measure this served shape publishes is one
 * `loadForecastBasis` blanks, or one it deliberately keeps — the ABL-493 idiom,
 * here because this is the shape a sixth measure would actually reach NL
 * through. See `_loadAccuracyMeasuresClassified` (`tsoForecastService.ts:484`).
 */
const _accuracyMetricsMeasuresClassified: MeasuresClassified<AccuracyMetrics> = true;

export interface ProviderMetrics {
  dayAhead?: AccuracyMetrics;  // TSO day-ahead
  weekAhead?: AccuracyMetrics; // TSO week-ahead
}

export interface MLProviderMetrics {
  d1?: AccuracyMetrics;  // D+1 (0-30 hours ahead)
  d2?: AccuracyMetrics;  // D+2 (24-54 hours ahead)
}

export interface UnifiedComparisonResponse {
  tso: ProviderMetrics;
  ml: MLProviderMetrics;
  meta: {
    forecastType: string;
    countryCode: string;
    timeRange: { start: string; end: string };
    /** `forecasts.model_name` the ml side was pinned to; null when unpinned. */
    mlModel: string | null;
    dataAvailability: {
      tso: { dayAhead: boolean; weekAhead: boolean };
      ml: { d1: boolean; d2: boolean };
    };
  };
}

/**
 * Get unified comparison metrics for all providers and horizons
 */
export function getUnifiedComparison(
  countryCode: string,
  forecastType: ForecastType,
  start: string,
  end: string,
  mlModelName?: string
): UnifiedComparisonResponse {
  const upperCode = countryCode.toUpperCase();

  // Initialize response
  const response: UnifiedComparisonResponse = {
    tso: {},
    ml: {},
    meta: {
      forecastType,
      countryCode: upperCode,
      timeRange: { start, end },
      // null means the ml side is unpinned — the latest run per timestamp
      // whichever model produced it. Not a claim that any given model served.
      mlModel: mlModelName ?? null,
      dataAvailability: {
        tso: { dayAhead: false, weekAhead: false },
        ml: { d1: false, d2: false },
      },
    },
  };

  // Get TSO metrics if applicable
  if (isTSOForecastable(forecastType)) {
    const tsoMetrics = getTSOMetrics(upperCode, forecastType, start, end);
    response.tso = tsoMetrics;
    response.meta.dataAvailability.tso = {
      dayAhead: tsoMetrics.dayAhead !== undefined && tsoMetrics.dayAhead.dataPoints > 0,
      weekAhead: tsoMetrics.weekAhead !== undefined && tsoMetrics.weekAhead.dataPoints > 0,
    };
  }

  // Get ML metrics
  const mlMetrics = mlForecastService.getMLForecastMetricsByHorizon(
    upperCode, forecastType, start, end, mlModelName
  );
  response.ml = {
    d1: mlMetrics.d1 ? addBiasToMetrics(mlMetrics.d1) : undefined,
    d2: mlMetrics.d2 ? addBiasToMetrics(mlMetrics.d2) : undefined,
  };
  response.meta.dataAvailability.ml = {
    d1: mlMetrics.d1 !== undefined && mlMetrics.d1.dataPoints > 0,
    d2: mlMetrics.d2 !== undefined && mlMetrics.d2.dataPoints > 0,
  };

  return response;
}

/**
 * Get summary metrics across all forecast types for a country
 */
export function getComparisonSummary(
  countryCode: string,
  start: string,
  end: string
): Record<string, UnifiedComparisonResponse> {
  const forecastTypes: ForecastType[] = ['load', 'price', 'solar', 'wind_onshore', 'wind_offshore'];
  const summary: Record<string, UnifiedComparisonResponse> = {};

  for (const forecastType of forecastTypes) {
    try {
      summary[forecastType] = getUnifiedComparison(countryCode, forecastType, start, end);
    } catch {
      // Skip types that fail (e.g., no data)
    }
  }

  return summary;
}

/**
 * Get the "best" forecast for each type based on MAPE
 */
export function getBestForecastByType(
  countryCode: string,
  forecastType: ForecastType,
  start: string,
  end: string,
  mlModelName?: string
): { provider: 'tso' | 'ml'; horizon: string; mape: number } | null {
  const comparison = getUnifiedComparison(countryCode, forecastType, start, end, mlModelName);

  // Collect all available metrics with their identifiers
  const candidates: Array<{ provider: 'tso' | 'ml'; horizon: string; mape: number }> = [];

  // A null mape (no point had a measurable positive actual) can't be ranked
  // as "best" — it isn't a measurement.
  if (comparison.tso.dayAhead?.dataPoints && comparison.tso.dayAhead.mape != null) {
    candidates.push({ provider: 'tso', horizon: 'day_ahead', mape: comparison.tso.dayAhead.mape });
  }
  if (comparison.tso.weekAhead?.dataPoints && comparison.tso.weekAhead.mape != null) {
    candidates.push({ provider: 'tso', horizon: 'week_ahead', mape: comparison.tso.weekAhead.mape });
  }
  if (comparison.ml.d1?.dataPoints && comparison.ml.d1.mape != null) {
    candidates.push({ provider: 'ml', horizon: 'd1', mape: comparison.ml.d1.mape });
  }
  if (comparison.ml.d2?.dataPoints && comparison.ml.d2.mape != null) {
    candidates.push({ provider: 'ml', horizon: 'd2', mape: comparison.ml.d2.mape });
  }

  if (candidates.length === 0) {
    return null;
  }

  // Return the one with lowest MAPE
  return candidates.reduce((best, current) =>
    current.mape < best.mape ? current : best
  );
}

// Helper functions

function isTSOForecastable(forecastType: ForecastType): forecastType is TSOForecastableType {
  return TSO_FORECAST_TYPES.includes(forecastType as TSOForecastableType);
}

function getTSOMetrics(
  countryCode: string,
  forecastType: TSOForecastableType,
  start: string,
  end: string
): ProviderMetrics {
  const result: ProviderMetrics = {};

  if (forecastType === 'load') {
    // Load has both day-ahead and week-ahead forecasts
    try {
      const dayAhead = tsoForecastService.getLoadForecastAccuracyMetrics(
        countryCode, start, end, 'day_ahead'
      );
      if (dayAhead.dataPoints > 0) {
        result.dayAhead = addBiasToTSOMetrics(dayAhead, countryCode, start, end, 'day_ahead');
      }
    } catch {
      // Day-ahead not available
    }

    try {
      const weekAhead = tsoForecastService.getLoadForecastAccuracyMetrics(
        countryCode, start, end, 'week_ahead'
      );
      if (weekAhead.dataPoints > 0) {
        result.weekAhead = addBiasToTSOMetrics(weekAhead, countryCode, start, end, 'week_ahead');
      }
    } catch {
      // Week-ahead not available
    }
  } else {
    // Generation forecasts (solar, wind_onshore, wind_offshore) only have day-ahead
    try {
      const metrics = tsoForecastService.getGenerationForecastAccuracyMetrics(
        countryCode, start, end, forecastType
      );
      if (metrics.dataPoints > 0) {
        result.dayAhead = addBiasToGenerationMetrics(metrics, countryCode, forecastType, start, end);
      }
    } catch {
      // Not available
    }
  }

  return result;
}

/**
 * Add bias calculation to TSO load metrics
 * TSO service doesn't calculate bias, so we compute it from accuracy data
 */
function addBiasToTSOMetrics(
  metrics: {
    mae: number | null; mape: number | null; wape: number | null; rmse: number | null;
    dataPoints: number;
    basis?: LoadForecastBasis;
    basisNote?: string | null;
  },
  countryCode: string,
  start: string,
  end: string,
  forecastType: 'day_ahead' | 'week_ahead'
): AccuracyMetrics {
  // Nothing derived from the pair survives a divergent basis — including bias,
  // which is the *most* misleading of the four here: for NL it is a clean
  // +2,435 MW that reads as a systematic over-forecast the TSO could correct,
  // when it is the behind-the-meter solar the two series disagree about.
  //
  // The verdict travels with the blanks (ABL-628). Dropping it, as this branch
  // used to, published four nulls beside a healthy `dataPoints` and left the
  // reader no way to tell a withholding from a metric that failed to compute.
  if (metrics.basis === 'divergent_basis') {
    return {
      mae: null, mape: null, wape: null, rmse: null, bias: null,
      dataPoints: metrics.dataPoints,
      basis: metrics.basis,
      basisNote: metrics.basisNote ?? null,
    };
  }

  // Get accuracy data to calculate bias
  const data = tsoForecastService.getLoadForecastAccuracy(
    countryCode, start, end, forecastType, 'hourly'
  );

  let bias = 0;
  if (data.length > 0) {
    // error in TSO service is actual - forecast, so bias = -avg(error)
    bias = -data.reduce((sum, d) => sum + d.error, 0) / data.length;
  }

  return {
    // mae/rmse are only null when dataPoints === 0; every caller of this
    // function already checked dataPoints > 0 before calling it.
    mae: metrics.mae ?? 0,
    mape: metrics.mape,
    // Already computed through the one wape() definition and, for load,
    // already divergent-basis-blanked by applyLoadForecastBasis one call up
    // (getLoadForecastAccuracyMetrics:474) — pass it through rather than
    // re-deriving it from `data` a second time (ABL-388 exists to prevent
    // exactly that duplication).
    wape: metrics.wape,
    rmse: metrics.rmse ?? 0,
    bias: Math.round(bias * 100) / 100,
    dataPoints: metrics.dataPoints,
    // 'comparable' on the way past, so a load block always names its verdict
    // and a consumer is never left to guess whether the build predates the rule.
    ...(metrics.basis ? { basis: metrics.basis, basisNote: metrics.basisNote ?? null } : {}),
  };
}

/**
 * Add bias calculation to TSO generation metrics
 */
function addBiasToGenerationMetrics(
  metrics: {
    mae: number | null; mape: number | null; wape: number | null; rmse: number | null;
    dataPoints: number;
  },
  countryCode: string,
  generationType: 'solar' | 'wind_onshore' | 'wind_offshore',
  start: string,
  end: string
): AccuracyMetrics {
  // Get accuracy data to calculate bias
  const data = tsoForecastService.getGenerationForecastAccuracy(
    countryCode, start, end, generationType, 'hourly'
  );

  let bias = 0;
  if (data.length > 0) {
    // error in TSO service is actual - forecast, so bias = -avg(error)
    bias = -data.reduce((sum, d) => sum + d.error, 0) / data.length;
  }

  return {
    // mae/rmse are only null when dataPoints === 0; every caller of this
    // function already checked dataPoints > 0 before calling it.
    mae: metrics.mae ?? 0,
    mape: metrics.mape,
    // Already computed through the one wape() definition, one call up
    // (getGenerationForecastAccuracyMetrics:493 → calculateMetrics) — pass it
    // through rather than re-deriving it from `data` a second time.
    wape: metrics.wape,
    rmse: metrics.rmse ?? 0,
    bias: Math.round(bias * 100) / 100,
    dataPoints: metrics.dataPoints,
  };
}

/**
 * Reshape ML metrics onto the served envelope (they already carry bias).
 *
 * **Nothing is coerced here.** This function used to read
 * `mae: metrics.mae ?? 0` — with `rmse` and `bias` the same — on the reasoning
 * that those are null only when `dataPoints === 0`, which both callers exclude.
 * That reasoning stopped being true the moment the ml side started routing
 * through the divergent-basis rule (ABL-628): a withheld window pairs its rows,
 * so `dataPoints` is 4 or 721 while every measure is null on purpose, and each
 * `?? 0` would have turned a deliberate blank into a **flawless 0 MW forecast**
 * for the Netherlands — a worse published number than the 25.6% MAPE this issue
 * was filed to remove. It is the ABL-277 trap, one endpoint over.
 */
function addBiasToMetrics(metrics: mlForecastService.MLAccuracyMetricsWithBasis): AccuracyMetrics {
  return {
    mae: metrics.mae,
    mape: metrics.mape,
    wape: metrics.wape,
    rmse: metrics.rmse,
    bias: metrics.bias,
    dataPoints: metrics.dataPoints,
    // Present on load only — the ml service gates the verdict on forecast type,
    // so NL's price and solar blocks stay unstamped as well as unblanked.
    ...(metrics.basis ? { basis: metrics.basis, basisNote: metrics.basisNote ?? null } : {}),
  };
}

// ============================================================================
// Rolling Accuracy Metrics
// ============================================================================

export interface RollingAccuracyDataPoint {
  date: string;  // YYYY-MM-DD format
  /**
   * `mae` is nullable on **every** series here since ABL-277: a country whose
   * realized load and the forecast measure different quantities has its error
   * measures suppressed while still pairing points, so `dataPoints > 0` no
   * longer implies a publishable MAE. It must stay null — the `?? 0` that used
   * to sit here would have rendered the Netherlands as a flawless 0 MW.
   *
   * The two ml series carried that `?? 0` for a year longer than the TSO one,
   * because until ABL-628 the ml side never withheld and the coercion was
   * unreachable. Routing the ml metrics through the basis rule made it live —
   * and strictly worse than the defect it was fixing, since an NL load chart
   * would have drawn a flat zero line for `ml_d1` where it previously drew an
   * honestly-labelled-wrong 25.6%. The type is the guard: widening it is what
   * made the compiler point at both call sites.
   */
  tso?: { mape: number | null; mae: number | null };
  ml_d1?: { mape: number | null; mae: number | null };
  ml_d2?: { mape: number | null; mae: number | null };
}

export interface RollingAccuracyResponse {
  data: RollingAccuracyDataPoint[];
  windowDays: number;
  meta: {
    forecastType: string;
    countryCode: string;
    timeRange: { start: string; end: string };
    /** `forecasts.model_name` the ml side was pinned to; null when unpinned. */
    mlModel: string | null;
  };
}

/**
 * Get rolling accuracy metrics over time
 * Returns daily data points showing MAPE/MAE with a rolling window average
 */
export function getRollingAccuracy(
  countryCode: string,
  forecastType: ForecastType,
  start: string,
  end: string,
  windowDays: number = 7,
  mlModelName?: string
): RollingAccuracyResponse {
  const upperCode = countryCode.toUpperCase();
  const startDate = new Date(start);
  const endDate = new Date(end);

  // Generate list of dates to process
  const dates: string[] = [];
  const current = new Date(startDate);
  while (current <= endDate) {
    dates.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 1);
  }

  // For each date, calculate metrics for the window ending on that date
  const results: RollingAccuracyDataPoint[] = [];

  for (const dateStr of dates) {
    const windowEnd = new Date(dateStr + 'T23:59:59Z');
    const windowStart = new Date(windowEnd);
    windowStart.setDate(windowStart.getDate() - windowDays + 1);
    windowStart.setHours(0, 0, 0, 0);

    // Skip if window start is before data start
    if (windowStart < startDate) continue;

    const windowStartISO = windowStart.toISOString();
    const windowEndISO = windowEnd.toISOString();

    const dataPoint: RollingAccuracyDataPoint = { date: dateStr };

    // Get TSO metrics for load (day-ahead) if applicable
    if (isTSOForecastable(forecastType)) {
      try {
        if (forecastType === 'load') {
          const tsoMetrics = tsoForecastService.getLoadForecastAccuracyMetrics(
            upperCode, windowStartISO, windowEndISO, 'day_ahead'
          );
          // Passed through, never coerced: a divergent-basis country pairs
          // points but publishes no error measure (ABL-277).
          if (tsoMetrics.dataPoints > 0) {
            dataPoint.tso = { mape: tsoMetrics.mape, mae: tsoMetrics.mae };
          }
        } else {
          const tsoMetrics = tsoForecastService.getGenerationForecastAccuracyMetrics(
            upperCode, windowStartISO, windowEndISO, forecastType as 'solar' | 'wind_onshore' | 'wind_offshore'
          );
          if (tsoMetrics.dataPoints > 0) {
            dataPoint.tso = { mape: tsoMetrics.mape, mae: tsoMetrics.mae };
          }
        }
      } catch {
        // TSO data not available for this window
      }
    }

    // Get ML D+1 metrics
    try {
      const mlD1 = mlForecastService.getMLForecastAccuracyMetrics(
        upperCode, forecastType, windowStartISO, windowEndISO, 1, mlModelName
      );
      if (mlD1.dataPoints > 0) {
        // Passed through, never coerced — same rule as the TSO branch above,
        // and live on the ml side since ABL-628.
        dataPoint.ml_d1 = { mape: mlD1.mape, mae: mlD1.mae };
      }
    } catch {
      // ML D+1 not available
    }

    // Get ML D+2 metrics
    try {
      const mlD2 = mlForecastService.getMLForecastAccuracyMetrics(
        upperCode, forecastType, windowStartISO, windowEndISO, 2, mlModelName
      );
      if (mlD2.dataPoints > 0) {
        // Passed through, never coerced — see ml_d1 above.
        dataPoint.ml_d2 = { mape: mlD2.mape, mae: mlD2.mae };
      }
    } catch {
      // ML D+2 not available
    }

    // Only add if we have at least some data
    if (dataPoint.tso || dataPoint.ml_d1 || dataPoint.ml_d2) {
      results.push(dataPoint);
    }
  }

  return {
    data: results,
    windowDays,
    meta: {
      forecastType,
      countryCode: upperCode,
      timeRange: { start, end },
      mlModel: mlModelName ?? null,
    },
  };
}
