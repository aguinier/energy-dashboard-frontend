// Load/Price's multi-model overlay adapter (ABL-204) — the counterpart of
// `chartAdapters.ts`'s `adaptNetPositionMultiSeries` for the two tabs whose
// picker (`ModelPicker.tsx`) can mix ml AND tso models in one selection.

import type { AbleSeriesPoint, AbleForecastSeriesSpec } from '@/components/charts/AbleLineChart';

const HOUR_MS = 60 * 60 * 1000;

function hourKey(ts: string): number {
  return Math.floor(new Date(ts).getTime() / HOUR_MS) * HOUR_MS;
}

function tsOf(p: { timestamp?: string; date?: string }): string | null {
  return p.timestamp ?? p.date ?? null;
}

/** A model's forecast point, normalized to one shape regardless of source (ml `ForecastDataPoint` vs tso `TSOLoadForecastDataPoint`). */
export interface NormalizedForecastPoint {
  timestamp?: string;
  value: number | null;
  /** Only ever populated by TSO week-ahead. */
  min?: number | null;
  max?: number | null;
}

export interface MultiForecastEntry {
  /** Registry model id — the key `AbleSeriesPoint.forecasts` is written under. */
  id: string;
  label: string;
  color: string;
  dash: string;
  /** `undefined` while this model's query has not resolved yet. */
  points: NormalizedForecastPoint[] | undefined;
}

export interface MultiForecastSeriesResult {
  series: AbleSeriesPoint[];
  nowIndex: number;
  /** One entry per input, in input order — including ones with no rows. See doc comment below for why this differs from net position's adapter. */
  forecastSeries: AbleForecastSeriesSpec[];
}

/**
 * Actual + N explicitly-selected forecast models -> one chart series
 * (ABL-204), for Load and Price's multi-select picker.
 *
 * Differs from `adaptNetPositionMultiSeries` on purpose: every entry in
 * `entries` lands in the returned `forecastSeries`, whether or not it has
 * rows. That function drops an uncovered model from `forecastSeries` and
 * lets the tab render a separate footnote instead — a reasonable choice
 * there, where every net-position model is ml and a coverage gap is the
 * exception. Here a gap is the ordinary outcome of picking two models
 * (catboost and xgboost cover near-disjoint country sets on `load`, and
 * `price` is not far behind), so ABL-205's design puts the "selected but
 * not covered" mark IN the legend — a hatched key plus explicit text
 * (`covered: false` on the spec) — not only in a footnote below the chart.
 * `AbleLineChart` draws no line for an uncovered entry (there is nothing to
 * draw) but keeps its legend row.
 *
 * The min/max band and the y-domain both read `AbleSeriesPoint.min`/`.max`
 * regardless of caller, so those are only populated when exactly one entry
 * is selected — same rule net position's picker uses for its p10-p90 band:
 * several bands on one chart is unreadable, and a lone band under N lines
 * would misattribute uncertainty to models that never published one. Here
 * the practical case is TSO week-ahead's daily min/max, which only exists
 * to draw at all when it is the sole checked model.
 */
export function buildMultiForecastSeries<TActual extends { timestamp?: string; date?: string }>(opts: {
  actual: TActual[] | undefined;
  actualValue: (p: TActual) => number | null | undefined;
  entries: MultiForecastEntry[];
  /** Named in the coverage note for an uncovered entry, e.g. "Not available in Belgium". */
  countryLabel: string;
  /** Bounds the rendered hourly grid — see `buildSeriesGrid`'s doc comment in chartAdapters.ts. */
  window?: { start: Date; end: Date };
  now?: Date;
}): MultiForecastSeriesResult {
  const { actual = [], actualValue, entries, countryLabel, window } = opts;
  const now = opts.now ?? new Date();

  const resolved = entries.filter(
    (e): e is MultiForecastEntry & { points: NormalizedForecastPoint[] } => e.points != null,
  );

  const allTs: number[] = [];
  for (const p of actual) {
    const ts = tsOf(p);
    if (ts) allTs.push(hourKey(ts));
  }
  for (const e of resolved) {
    for (const p of e.points) {
      if (p.timestamp) allTs.push(hourKey(p.timestamp));
    }
  }
  if (allTs.length === 0) return { series: [], nowIndex: 0, forecastSeries: [] };

  const tStart = window ? hourKey(window.start.toISOString()) : Math.min(...allTs);
  const tEnd = window ? hourKey(window.end.toISOString()) : Math.max(...allTs);
  const nowMs = now.getTime();

  const points: AbleSeriesPoint[] = [];
  for (let t = tStart; t <= tEnd; t += HOUR_MS) {
    points.push({ ts: new Date(t).toISOString(), future: t > nowMs, value: null, forecast: null, forecasts: {} });
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

  // A model still in flight reads as covered until it resolves — flipping the
  // legend to "not available" before the response is back would be wrong,
  // not just premature.
  const forecastSeries: AbleForecastSeriesSpec[] = entries.map((entry) => {
    const covered = entry.points == null ? true : entry.points.length > 0;
    return {
      id: entry.id,
      label: entry.label,
      color: entry.color,
      dash: entry.dash,
      covered,
      coverageNote: covered ? undefined : `Not available in ${countryLabel}`,
    };
  });

  for (const entry of resolved) {
    for (const p of entry.points) {
      if (!p.timestamp) continue;
      const i = idxOf(hourKey(p.timestamp));
      if (i < 0 || i >= points.length) continue;
      if (p.value != null && Number.isFinite(p.value)) points[i].forecasts![entry.id] = p.value;
    }
  }

  // Band: only when exactly one model is selected, and only from that model's
  // own response — see doc comment above.
  const soleActive = entries.length === 1 ? entries[0] : undefined;
  if (soleActive?.points) {
    for (const p of soleActive.points) {
      if (!p.timestamp) continue;
      const i = idxOf(hourKey(p.timestamp));
      if (i < 0 || i >= points.length) continue;
      if (p.min != null && Number.isFinite(p.min)) points[i].min = p.min;
      if (p.max != null && Number.isFinite(p.max)) points[i].max = p.max;
    }
  }

  let nowIndex = points.findIndex((p) => new Date(p.ts).getTime() > nowMs);
  if (nowIndex === -1) nowIndex = points.length - 1;
  else nowIndex = Math.max(0, nowIndex - 1);

  return { series: points, nowIndex, forecastSeries };
}
