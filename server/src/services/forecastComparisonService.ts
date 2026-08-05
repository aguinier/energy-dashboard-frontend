import { ForecastType } from '../types/index.js';
import * as tsoForecastService from './tsoForecastService.js';
import * as mlForecastService from './mlForecastService.js';

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
  mae: number;      // Mean Absolute Error (MW or EUR/MWh)
  mape: number | null; // Mean Absolute Percentage Error (%) — null when no point had a measurable (positive) actual
  rmse: number;     // Root Mean Square Error
  bias: number;     // Mean Error (positive = over-forecast)
  dataPoints: number;
}

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
  metrics: { mae: number | null; mape: number | null; rmse: number | null; dataPoints: number },
  countryCode: string,
  start: string,
  end: string,
  forecastType: 'day_ahead' | 'week_ahead'
): AccuracyMetrics {
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
    rmse: metrics.rmse ?? 0,
    bias: Math.round(bias * 100) / 100,
    dataPoints: metrics.dataPoints,
  };
}

/**
 * Add bias calculation to TSO generation metrics
 */
function addBiasToGenerationMetrics(
  metrics: { mae: number | null; mape: number | null; rmse: number | null; dataPoints: number },
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
    rmse: metrics.rmse ?? 0,
    bias: Math.round(bias * 100) / 100,
    dataPoints: metrics.dataPoints,
  };
}

/**
 * Add bias to ML metrics (already has bias from mlForecastService)
 */
function addBiasToMetrics(metrics: mlForecastService.MLForecastAccuracyMetrics): AccuracyMetrics {
  return {
    // mae/rmse/bias are only null when dataPoints === 0; both callers of this
    // function already checked dataPoints > 0 before calling it.
    mae: metrics.mae ?? 0,
    mape: metrics.mape,
    rmse: metrics.rmse ?? 0,
    bias: metrics.bias ?? 0,
    dataPoints: metrics.dataPoints,
  };
}

// ============================================================================
// Rolling Accuracy Metrics
// ============================================================================

export interface RollingAccuracyDataPoint {
  date: string;  // YYYY-MM-DD format
  tso?: { mape: number | null; mae: number };
  ml_d1?: { mape: number | null; mae: number };
  ml_d2?: { mape: number | null; mae: number };
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
          // mae is only null when dataPoints === 0, excluded by the guard above.
          if (tsoMetrics.dataPoints > 0) {
            dataPoint.tso = { mape: tsoMetrics.mape, mae: tsoMetrics.mae ?? 0 };
          }
        } else {
          const tsoMetrics = tsoForecastService.getGenerationForecastAccuracyMetrics(
            upperCode, windowStartISO, windowEndISO, forecastType as 'solar' | 'wind_onshore' | 'wind_offshore'
          );
          if (tsoMetrics.dataPoints > 0) {
            dataPoint.tso = { mape: tsoMetrics.mape, mae: tsoMetrics.mae ?? 0 };
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
        // mae is only null when dataPoints === 0, excluded by the guard above.
        dataPoint.ml_d1 = { mape: mlD1.mape, mae: mlD1.mae ?? 0 };
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
        // mae is only null when dataPoints === 0, excluded by the guard above.
        dataPoint.ml_d2 = { mape: mlD2.mape, mae: mlD2.mae ?? 0 };
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
