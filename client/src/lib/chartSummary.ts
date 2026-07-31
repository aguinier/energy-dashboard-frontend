// Screen-reader text alternative for AbleLineChart.
//
// The SVG line chart exposes its axis tick text as plain <text> nodes but
// nothing that ties a value to what the line is actually showing — a screen
// reader gets tick furniture ("35 40 45 … Tue 21 Wed 22"), not "load is 41.5
// GW". Making every one of (often 700+) points individually navigable would
// be worse, not better — see the module's callers for the "33–45 GW over 24
// hours, currently 41.5 GW" framing this is built around. AbleLineChart
// renders this as visually-hidden text right before an `aria-hidden` SVG, so
// a screen reader gets the substance without a sighted mouse user seeing
// anything different.
//
// Kept pure and separate from the component (rather than inline JSX) because
// this client is vitest-only — no jsdom/RTL — so anything worth testing has
// to be expressible as (data in) -> (string out); see mapGeometry.ts for the
// same pattern applied to the map.

import type { AbleSeriesPoint } from '@/components/charts/AbleLineChart';

function defaultFormatValue(v: number): string {
  return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(1);
}

export interface SeriesSummaryOptions {
  /** What the series measures, e.g. "Electricity load". Defaults to "Value". */
  label?: string;
  /** Unit suffix, e.g. "GW". Omitted entirely when blank. */
  unit?: string;
  formatValue?: (v: number) => string;
  /** Injectable for tests; defaults to the real current time. */
  now?: Date;
}

/**
 * Builds a one-paragraph description of an AbleLineChart series: the
 * actual+forecast value range over the window, the latest actual reading
 * (and how stale it is, mirroring trailingGapLabel's threshold), and how far
 * the forecast reaches beyond that.
 *
 * Assumes an hourly grid — true for every current AbleLineChart caller
 * (buildSeriesGrid / adaptNetPositionSeries in chartAdapters.ts always emit
 * one point per hour) — so `series.length` doubles as the window's span in
 * hours without needing to re-parse timestamps.
 */
export function summarizeSeries(
  series: AbleSeriesPoint[],
  nowIndex: number,
  opts: SeriesSummaryOptions = {},
): string {
  const { label = 'Value', unit = '', formatValue = defaultFormatValue, now = new Date() } = opts;

  const fmt = (v: number) => (unit ? `${formatValue(v)} ${unit}` : formatValue(v));
  const fmtRange = (lo: number, hi: number) =>
    unit ? `${formatValue(lo)}–${formatValue(hi)} ${unit}` : `${formatValue(lo)}–${formatValue(hi)}`;

  if (series.length === 0) return `${label}: no data in this window.`;

  const actualValues = series
    .map((p) => p.value)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const forecastValues = series
    .map((p) => p.forecast)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const allValues = [...actualValues, ...forecastValues];

  if (allValues.length === 0) return `${label}: no data in this window.`;

  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const spanHours = series.length;
  const spanLabel = spanHours >= 48 ? `${Math.round(spanHours / 24)} days` : `${spanHours} hours`;

  const parts: string[] = [`${label} ranged ${fmtRange(min, max)} over ${spanLabel}.`];

  // Latest actual reading, walking back from `now` (falling back to the end
  // of the series when nowIndex is out of range).
  const anchor = Math.max(0, Math.min(series.length - 1, nowIndex));
  let latestIdx = -1;
  for (let i = anchor; i >= 0; i--) {
    if (series[i].value != null && Number.isFinite(series[i].value as number)) {
      latestIdx = i;
      break;
    }
  }
  if (latestIdx >= 0) {
    const latestVal = series[latestIdx].value as number;
    const gapHours = Math.round((now.getTime() - new Date(series[latestIdx].ts).getTime()) / 3_600_000);
    parts.push(
      gapHours >= 2
        ? `Currently ${fmt(latestVal)}, as of ${gapHours} hours ago.`
        : `Currently ${fmt(latestVal)}.`,
    );
  }

  // Forecast reach, described relative to `now` rather than the last actual
  // point — a chart can carry a forecast with no actuals at all yet (a fresh
  // day-ahead run before today's actuals have arrived).
  let lastForecastIdx = -1;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].forecast != null && Number.isFinite(series[i].forecast as number)) {
      lastForecastIdx = i;
      break;
    }
  }
  if (lastForecastIdx >= 0) {
    const forecastVal = series[lastForecastIdx].forecast as number;
    const aheadHours = lastForecastIdx - anchor;
    parts.push(
      aheadHours > 0
        ? `Forecast continues ${aheadHours} more hours, reaching ${fmt(forecastVal)}.`
        : `Forecast reaches ${fmt(forecastVal)}.`,
    );
  }

  return parts.join(' ');
}
