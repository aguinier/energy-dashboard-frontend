// Adapters that turn the existing time-series API response shapes into the
// shapes the able-prototype SVG charts expect.

import type { AbleSeriesPoint } from '@/components/charts/AbleLineChart';
import type { AbleStackedMixPoint } from '@/components/charts/AbleStackedMix';
import type { AbleHeatmapPoint } from '@/components/charts/AblePriceHeatmap';
import type {
  LoadDataPoint,
  PriceDataPoint,
  ForecastDataPoint,
  RenewableDataPoint,
  TSOLoadForecastDataPoint,
} from '@/types';

const HOUR_MS = 60 * 60 * 1000;

/** Pluck a usable timestamp string out of any record shape we deal with. */
function tsOf(p: { timestamp?: string; date?: string }): string | null {
  return p.timestamp ?? p.date ?? null;
}

/** Bucket a date down to its hour boundary. */
function hourKey(ts: string): number {
  const ms = new Date(ts).getTime();
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/**
 * Build an hourly grid spanning [actualStart, max(actualEnd, forecastEnd)],
 * placing actual + forecast values into the right hour bins. Used by the
 * line charts in Price/Load tabs.
 */
export function buildSeriesGrid<TActual extends { timestamp?: string; date?: string }>(opts: {
  actual: TActual[] | undefined;
  actualValue: (p: TActual) => number | null | undefined;
  forecast: ForecastDataPoint[] | undefined;
  /** Optional second forecast source (e.g. TSO when ML is off). */
  forecastAlt?: TSOLoadForecastDataPoint[];
  forecastAltValue?: (p: TSOLoadForecastDataPoint) => number | null;
  forecastAltMin?: (p: TSOLoadForecastDataPoint) => number | null;
  forecastAltMax?: (p: TSOLoadForecastDataPoint) => number | null;
  now?: Date;
}): { series: AbleSeriesPoint[]; nowIndex: number } {
  const { actual = [], actualValue, forecast = [], forecastAlt = [], forecastAltValue, forecastAltMin, forecastAltMax } = opts;
  const now = opts.now ?? new Date();

  // Find time range
  const allTs: number[] = [];
  for (const p of actual) {
    const ts = tsOf(p);
    if (ts) allTs.push(hourKey(ts));
  }
  for (const p of forecast) {
    if (p.timestamp) allTs.push(hourKey(p.timestamp));
  }
  for (const p of forecastAlt) {
    if (p.timestamp) allTs.push(hourKey(p.timestamp));
  }
  if (allTs.length === 0) return { series: [], nowIndex: 0 };
  const tStart = Math.min(...allTs);
  const tEnd = Math.max(...allTs);
  const points: AbleSeriesPoint[] = [];
  for (let t = tStart; t <= tEnd; t += HOUR_MS) {
    points.push({ ts: new Date(t).toISOString(), future: t > now.getTime(), value: null, forecast: null });
  }
  const idxOf = (ts: number) => Math.round((ts - tStart) / HOUR_MS);

  for (const p of actual) {
    const ts = tsOf(p);
    if (!ts) continue;
    const i = idxOf(hourKey(ts));
    if (i < 0 || i >= points.length) continue;
    const v = actualValue(p);
    if (v != null && Number.isFinite(v)) points[i].value = v;
  }
  for (const p of forecast) {
    if (!p.timestamp) continue;
    const i = idxOf(hourKey(p.timestamp));
    if (i < 0 || i >= points.length) continue;
    if (Number.isFinite(p.value)) points[i].forecast = p.value;
  }
  if (forecastAltValue) {
    for (const p of forecastAlt) {
      if (!p.timestamp) continue;
      const i = idxOf(hourKey(p.timestamp));
      if (i < 0 || i >= points.length) continue;
      const v = forecastAltValue(p);
      // Don't clobber an ML forecast already present unless ML is empty here.
      if (v != null && Number.isFinite(v) && points[i].forecast == null) {
        points[i].forecast = v;
      }
      if (forecastAltMin) {
        const mn = forecastAltMin(p);
        if (mn != null && Number.isFinite(mn)) points[i].min = mn;
      }
      if (forecastAltMax) {
        const mx = forecastAltMax(p);
        if (mx != null && Number.isFinite(mx)) points[i].max = mx;
      }
    }
  }
  const nowMs = now.getTime();
  let nowIndex = points.findIndex((p) => new Date(p.ts).getTime() > nowMs);
  if (nowIndex === -1) nowIndex = points.length - 1;
  else nowIndex = Math.max(0, nowIndex - 1);
  return { series: points, nowIndex };
}

/** Price-specific shortcut. */
export function adaptPriceSeries(
  priceData: PriceDataPoint[] | undefined,
  forecast: ForecastDataPoint[] | undefined,
): { series: AbleSeriesPoint[]; nowIndex: number } {
  return buildSeriesGrid<PriceDataPoint>({
    actual: priceData,
    actualValue: (p) => p.price,
    forecast,
  });
}

/** Load-specific shortcut: handles ML and/or TSO forecast (with min/max for D+7). */
export function adaptLoadSeries(opts: {
  loadData: LoadDataPoint[] | undefined;
  mlForecast?: ForecastDataPoint[];
  tsoForecast?: TSOLoadForecastDataPoint[];
}): { series: AbleSeriesPoint[]; nowIndex: number } {
  return buildSeriesGrid<LoadDataPoint>({
    actual: opts.loadData,
    actualValue: (p) => p.load ?? p.avg_load ?? null,
    forecast: opts.mlForecast,
    forecastAlt: opts.tsoForecast,
    forecastAltValue: (p) => p.forecast_value_mw,
    forecastAltMin: (p) => p.forecast_min_mw,
    forecastAltMax: (p) => p.forecast_max_mw,
  });
}

/** Renewable mix → stacked series for AbleStackedMix. */
export function adaptRenewableMixSeries(
  data: RenewableDataPoint[] | undefined,
  now: Date = new Date(),
): { series: AbleStackedMixPoint[]; nowIndex: number } {
  if (!data || data.length === 0) return { series: [], nowIndex: 0 };
  const nowMs = now.getTime();
  const series = data
    .filter((d) => d.timestamp)
    .map((d) => ({
      ts: d.timestamp,
      future: new Date(d.timestamp).getTime() > nowMs,
      solar: d.solar || 0,
      wind: (d.wind_onshore || 0) + (d.wind_offshore || 0),
      hydro: d.hydro || 0,
      biomass: d.biomass || 0,
    }));
  let nowIndex = series.findIndex((p) => p.future);
  if (nowIndex === -1) nowIndex = series.length - 1;
  else nowIndex = Math.max(0, nowIndex - 1);
  return { series, nowIndex };
}

/** Build the 7×24 = 168 hourly cells for the heatmap, anchored to today. */
export function buildHeatmapCells<T extends { timestamp?: string; date?: string }>(opts: {
  data: T[] | undefined;
  value: (p: T) => number | null;
  forecast?: ForecastDataPoint[];
  now?: Date;
}): AbleHeatmapPoint[] {
  const { data = [], value, forecast = [] } = opts;
  const now = opts.now ?? new Date();
  // Today's hour-bucketed midnight (today's 00:00 local).
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  // Day 0 in the heatmap = 4 days ago at 00:00. 7 rows × 24 hours.
  const start = today.getTime() - 4 * 24 * HOUR_MS;
  const cells: AbleHeatmapPoint[] = [];
  for (let i = 0; i < 7 * 24; i++) {
    const t = start + i * HOUR_MS;
    cells.push({
      ts: new Date(t).toISOString(),
      value: null,
      future: t > now.getTime(),
    });
  }

  for (const p of data) {
    const ts = tsOf(p);
    if (!ts) continue;
    const tMs = hourKey(ts);
    const i = Math.round((tMs - start) / HOUR_MS);
    if (i < 0 || i >= cells.length) continue;
    const v = value(p);
    if (v != null && Number.isFinite(v)) cells[i].value = v;
  }
  for (const p of forecast) {
    if (!p.timestamp) continue;
    const tMs = hourKey(p.timestamp);
    const i = Math.round((tMs - start) / HOUR_MS);
    if (i < 0 || i >= cells.length) continue;
    if (cells[i].value == null && Number.isFinite(p.value)) cells[i].value = p.value;
  }
  return cells;
}
