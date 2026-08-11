// Adapters that turn the existing time-series API response shapes into the
// shapes the able-prototype SVG charts expect.

import type { AbleSeriesPoint, AbleForecastSeriesSpec } from '@/components/charts/AbleLineChart';
import type { AbleHeatmapPoint } from '@/components/charts/AblePriceHeatmap';
import type {
  LoadDataPoint,
  PriceDataPoint,
  ForecastDataPoint,
  TSOLoadForecastDataPoint,
  NetPositionResponse,
  WindGenerationSeriesPoint,
  TSOGenerationForecastDataPoint,
} from '@/types';
import { dayLabelByVintage } from './netPositionProvenance';

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
export function buildSeriesGrid<
  TActual extends { timestamp?: string; date?: string },
  TAlt extends { timestamp?: string } = TSOLoadForecastDataPoint,
>(opts: {
  actual: TActual[] | undefined;
  actualValue: (p: TActual) => number | null | undefined;
  forecast: ForecastDataPoint[] | undefined;
  /** Optional second forecast source (e.g. TSO when ML is off). */
  forecastAlt?: TAlt[];
  forecastAltValue?: (p: TAlt) => number | null;
  forecastAltMin?: (p: TAlt) => number | null;
  forecastAltMax?: (p: TAlt) => number | null;
  /**
   * Bounds the rendered hourly grid, independently of any deliberately wider
   * fetch. For example, price requests include tomorrow's published auction
   * rows, but a selected "Today" chart must still finish at today's 23:00
   * bucket rather than stretching its x-axis into tomorrow.
   */
  window?: { start: Date; end: Date };
  now?: Date;
}): { series: AbleSeriesPoint[]; nowIndex: number } {
  const { actual = [], actualValue, forecast = [], forecastAlt = [], forecastAltValue, forecastAltMin, forecastAltMax, window } = opts;
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
  const tStart = window ? hourKey(window.start.toISOString()) : Math.min(...allTs);
  const tEnd = window ? hourKey(window.end.toISOString()) : Math.max(...allTs);
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
  window?: { start: Date; end: Date },
): { series: AbleSeriesPoint[]; nowIndex: number } {
  return buildSeriesGrid<PriceDataPoint>({
    actual: priceData,
    actualValue: (p) => p.price,
    forecast,
    window,
  });
}

/** Load-specific shortcut: handles ML and/or TSO forecast (with min/max for D+7). */
export function adaptLoadSeries(opts: {
  loadData: LoadDataPoint[] | undefined;
  mlForecast?: ForecastDataPoint[];
  tsoForecast?: TSOLoadForecastDataPoint[];
  window?: { start: Date; end: Date };
}): { series: AbleSeriesPoint[]; nowIndex: number } {
  return buildSeriesGrid<LoadDataPoint>({
    actual: opts.loadData,
    actualValue: (p) => p.load ?? p.avg_load ?? null,
    forecast: opts.mlForecast,
    forecastAlt: opts.tsoForecast,
    forecastAltValue: (p) => p.forecast_value_mw,
    forecastAltMin: (p) => p.forecast_min_mw,
    forecastAltMax: (p) => p.forecast_max_mw,
    window: opts.window,
  });
}

/**
 * Wind-specific shortcut (ABL-235): onshore/offshore actuals against ml
 * and/or TSO D+1 forecast. Both the actuals response and the bundled TSO
 * generation forecast carry both wind types on the same row — `windType`
 * picks out the one column this chart draws, the same way `LoadSelectionView`
 * lets a caller pick a field out of a shared response shape.
 */
export function adaptWindSeries(opts: {
  windData: WindGenerationSeriesPoint[] | undefined;
  windType: 'wind_onshore' | 'wind_offshore';
  mlForecast?: ForecastDataPoint[];
  tsoForecast?: TSOGenerationForecastDataPoint[];
  window?: { start: Date; end: Date };
}): { series: AbleSeriesPoint[]; nowIndex: number } {
  const { windType } = opts;
  return buildSeriesGrid<WindGenerationSeriesPoint, TSOGenerationForecastDataPoint>({
    actual: opts.windData,
    actualValue: (p) => (windType === 'wind_onshore' ? p.wind_onshore : p.wind_offshore),
    forecast: opts.mlForecast,
    forecastAlt: opts.tsoForecast,
    forecastAltValue: (p) => (windType === 'wind_onshore' ? p.wind_onshore_mw : p.wind_offshore_mw),
    window: opts.window,
  });
}

/**
 * Net position → line series carrying all three regimes on one axis:
 *
 *   observed            actuals up to now
 *   published day-ahead the same series past now — this is a market outcome
 *                       that is already known, not a prediction
 *   model forecast      Chronos D+2 as `forecast`, with p10/p90 as the band
 *
 * Hours with neither are left null on purpose. Between the end of the
 * published day-ahead run and the start of D+2 there is routinely a real hole
 * — tomorrow's net position is not published until after market coupling
 * (~13:00 CET), so every morning has one. Filling it would put a line on the
 * chart that no data supports.
 */
export function adaptNetPositionSeries(
  data: NetPositionResponse | undefined,
  now: Date = new Date(),
): { series: AbleSeriesPoint[]; nowIndex: number } {
  const actual = data?.actual ?? [];
  const forecast = data?.forecast ?? [];

  const allTs: number[] = [];
  for (const p of actual) if (p.timestamp) allTs.push(hourKey(p.timestamp));
  for (const p of forecast) if (p.timestamp) allTs.push(hourKey(p.timestamp));
  if (allTs.length === 0) return { series: [], nowIndex: 0 };

  const tStart = Math.min(...allTs);
  const tEnd = Math.max(...allTs);
  const nowMs = now.getTime();

  const points: AbleSeriesPoint[] = [];
  for (let t = tStart; t <= tEnd; t += HOUR_MS) {
    points.push({
      ts: new Date(t).toISOString(),
      future: t > nowMs,
      value: null,
      forecast: null,
    });
  }
  const idxOf = (ts: number) => Math.round((ts - tStart) / HOUR_MS);

  for (const p of actual) {
    if (!p.timestamp) continue;
    const i = idxOf(hourKey(p.timestamp));
    if (i < 0 || i >= points.length) continue;
    if (Number.isFinite(p.net_position_mw)) points[i].value = p.net_position_mw;
  }

  // Several forecast vintages can be on screen together (see the module doc
  // above), so each point carries the provenance of whichever vintage won
  // for it, rather than the series claiming one generation time throughout.
  const dayLabels = dayLabelByVintage(data?.meta.vintages);

  for (const p of forecast) {
    if (!p.timestamp) continue;
    const i = idxOf(hourKey(p.timestamp));
    if (i < 0 || i >= points.length) continue;
    if (Number.isFinite(p.p50)) points[i].forecast = p.p50;
    if (p.p10 != null && Number.isFinite(p.p10)) points[i].min = p.p10;
    if (p.p90 != null && Number.isFinite(p.p90)) points[i].max = p.p90;
    points[i].forecastGeneratedAt = p.generated_at ?? null;
    points[i].forecastDayLabel = dayLabels.get(p.generated_at) ?? null;
  }

  let nowIndex = points.findIndex((p) => new Date(p.ts).getTime() > nowMs);
  if (nowIndex === -1) nowIndex = points.length - 1;
  else nowIndex = Math.max(0, nowIndex - 1);

  return { series: points, nowIndex };
}

/** One model's response, on its way into `adaptNetPositionMultiSeries`. */
export interface NetPositionModelSeriesInput {
  /** Registry model id — the key `AbleSeriesPoint.forecasts` is written under. */
  id: string;
  label: string;
  color: string;
  /** `undefined` while that model's query is still loading or failed. */
  response: NetPositionResponse | undefined;
}

export interface NetPositionMultiSeriesResult {
  series: AbleSeriesPoint[];
  nowIndex: number;
  /** Only entries that actually drew a line — a selected model with zero rows gets no legend entry (the tab names it in a footnote instead, see NetPositionTab). */
  forecastSeries: AbleForecastSeriesSpec[];
}

/**
 * Net position → line series for the multi-model picker (ABL-203): merges N
 * per-model responses (each already fetched pinned to its own model id) into
 * one series carrying every model's forecast under `AbleSeriesPoint.forecasts`.
 *
 * Actuals are identical across every entry for the same country/window — the
 * model pin only ever changes the forecast half of the response — so they are
 * read from whichever entry has some, not merged.
 *
 * The band, the single `forecast` field and per-point vintage provenance
 * (`forecastGeneratedAt`/`forecastDayLabel`) are populated only when exactly
 * one model is active. That is not an arbitrary restriction carried over from
 * `adaptNetPositionSeries` below — it is the same rule AbleLineChart's
 * `forecastSeries` doc states: several bands are unreadable on one chart, and
 * a single band under N lines would misattribute uncertainty to models that
 * never published one. With one active model this produces the exact same
 * points `adaptNetPositionSeries` would for that model's response.
 */
export function adaptNetPositionMultiSeries(
  entries: NetPositionModelSeriesInput[],
  now: Date = new Date(),
): NetPositionMultiSeriesResult {
  const defined = entries.filter(
    (e): e is NetPositionModelSeriesInput & { response: NetPositionResponse } => e.response != null,
  );

  const actualSource = defined.find((e) => e.response.actual.length > 0) ?? defined[0];
  const actual = actualSource?.response.actual ?? [];

  const allTs: number[] = [];
  for (const p of actual) if (p.timestamp) allTs.push(hourKey(p.timestamp));
  for (const e of defined) {
    for (const p of e.response.forecast) {
      if (p.timestamp) allTs.push(hourKey(p.timestamp));
    }
  }
  if (allTs.length === 0) return { series: [], nowIndex: 0, forecastSeries: [] };

  const tStart = Math.min(...allTs);
  const tEnd = Math.max(...allTs);
  const nowMs = now.getTime();

  const points: AbleSeriesPoint[] = [];
  for (let t = tStart; t <= tEnd; t += HOUR_MS) {
    points.push({
      ts: new Date(t).toISOString(),
      future: t > nowMs,
      value: null,
      forecast: null,
      forecasts: {},
    });
  }
  const idxOf = (ts: number) => Math.round((ts - tStart) / HOUR_MS);

  for (const p of actual) {
    if (!p.timestamp) continue;
    const i = idxOf(hourKey(p.timestamp));
    if (i < 0 || i >= points.length) continue;
    if (Number.isFinite(p.net_position_mw)) points[i].value = p.net_position_mw;
  }

  const forecastSeries: AbleForecastSeriesSpec[] = [];
  const soleActive = defined.length === 1 ? defined[0] : null;
  const dayLabels = soleActive ? dayLabelByVintage(soleActive.response.meta.vintages) : null;

  for (const entry of defined) {
    const rows = entry.response.forecast;
    // No rows for this model in this window - no line, no legend swatch. The
    // tab names it in a footnote (the "honest empty state" this whole picker
    // has to get right); a legend entry with nothing behind it would be worse
    // than silence, not better.
    if (rows.length === 0) continue;

    forecastSeries.push({ id: entry.id, label: entry.label, color: entry.color });

    for (const p of rows) {
      if (!p.timestamp) continue;
      const i = idxOf(hourKey(p.timestamp));
      if (i < 0 || i >= points.length) continue;
      if (Number.isFinite(p.p50)) points[i].forecasts![entry.id] = p.p50;

      if (soleActive) {
        points[i].forecast = p.p50;
        if (p.p10 != null && Number.isFinite(p.p10)) points[i].min = p.p10;
        if (p.p90 != null && Number.isFinite(p.p90)) points[i].max = p.p90;
        points[i].forecastGeneratedAt = p.generated_at ?? null;
        points[i].forecastDayLabel = dayLabels?.get(p.generated_at) ?? null;
      }
    }
  }

  let nowIndex = points.findIndex((p) => new Date(p.ts).getTime() > nowMs);
  if (nowIndex === -1) nowIndex = points.length - 1;
  else nowIndex = Math.max(0, nowIndex - 1);

  return { series: points, nowIndex, forecastSeries };
}

// `adaptRenewableMixSeries` lived here: RenewableDataPoint[] (from the frozen,
// renewable-only `energy_renewable`) → the four-family stacked series
// GenerationTab used to draw. ABL-44 moved that chart onto the full A75
// document so it can show nuclear and fossil too; its adapter is
// `dashboard/generationSeries.ts`'s `buildGenerationMixSeries`, which lives
// beside the grouping and palette it shares with the donut and the by-source
// table. Nothing else consumed this one — `useRenewableChartData`, its only
// caller's only hook, is gone with it.

/** Build the 7×24 = 168 hourly cells for the heatmap, anchored to today. */
export function buildHeatmapCells<T extends { timestamp?: string; date?: string }>(opts: {
  data: T[] | undefined;
  value: (p: T) => number | null;
  /**
   * Structurally typed rather than `ForecastDataPoint[]` so a selection-mode
   * entry's normalized `{timestamp, value}` points (`lib/multiForecastSeries.ts`)
   * can feed this directly without a wrapper (ABL-204).
   */
  forecast?: Array<{ timestamp?: string; value: number | null }>;
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
