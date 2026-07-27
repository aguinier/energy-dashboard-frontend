import type { ForecastComparisonSummary } from '@/types';

export interface HorizonBar {
  label: string;
  v: number;
  /**
   * Present only for structural compatibility with `AbleAccuracyBars`' `Datum`
   * (which draws hollow bars when true). `bar()` below never sets it — every
   * bar this module produces is measured, never extrapolated.
   */
  extrapolated?: boolean;
}

/** The per-horizon metric shape shared by TSOProviderMetrics and MLProviderMetrics. */
interface MetricLike {
  mape?: number | null;
  dataPoints?: number | null;
}

/** A bar only exists when a measurement backs it: a mape AND at least one sample. */
function bar(label: string, m: MetricLike | undefined): HorizonBar | null {
  if (!m || m.mape == null || !m.dataPoints) return null;
  return { label, v: m.mape };
}

/**
 * Measured MAPE by horizon.
 *
 * The previous version multiplied a measured D+1 figure by fixed factors
 * [1, 1.15, 1.3, 1.55, 1.9] to produce D+2/D+3/D+5/D+7. `forecasts.horizon_hours`
 * tops out at 63h, so anything past D+2 has no underlying forecast and cannot be
 * measured at all. Only horizons with stored samples appear.
 */
export function buildHorizonBars(
  summary: ForecastComparisonSummary | undefined,
  forecastType: string,
): HorizonBar[] {
  const t = summary?.[forecastType];
  if (!t) return [];

  return [
    bar('ML D+1', t.ml?.d1),
    bar('ML D+2', t.ml?.d2),
    bar('TSO D+1', t.tso?.dayAhead),
    bar('TSO D+7', t.tso?.weekAhead),
  ].filter((b): b is HorizonBar => b !== null);
}
