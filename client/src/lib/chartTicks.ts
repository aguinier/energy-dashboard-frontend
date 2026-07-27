// Shared axis-tick helper for the able SVG charts.
// Produces round tick values (1/2/2.5/5 × 10ⁿ steps) inside a data domain,
// so axes read 40k/50k/60k instead of 41.3k/49.6k/58.0k.

export function niceTicks(min: number, max: number, target = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min];
  const span = max - min;
  const step0 = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 5 : norm >= 2.5 ? 2.5 : norm >= 2 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-6; v += step) {
    // Snap away float drift (0.30000000000000004 → 0.3)
    ticks.push(Number(v.toPrecision(12)));
  }
  return ticks.length ? ticks : [min];
}

/** Format a MW value for a GW axis: 40000 → "40", 2500 → "2.5". */
export function formatGwAxis(mw: number): string {
  const gw = mw / 1000;
  if (Math.abs(gw) >= 10) return gw.toFixed(0);
  if (Math.abs(gw) >= 1) return gw.toFixed(1).replace(/\.0$/, '');
  return gw.toFixed(1);
}

/** Presets whose window is short enough that the hour, not the date, is the useful label. */
export const HOURLY_PRESETS = new Set(['24h', 'today', 'next24h', 'next1d']);

/**
 * Upper bound (hours) of the "short" tier: hour-only labels, e.g. "06:00".
 * Set just above a single day so the four HOURLY_PRESETS entries — whose own
 * nominal window is ~24h — read by hour when no forecast overlay is active.
 *
 * This happens to equal the 36h floor `getPriceWindowEnd` (useDashboardData.ts)
 * applies to the Price tab's fetch window, but the two are unrelated: that
 * floor exists because day-ahead auctions publish through the next day, this
 * one exists to admit a plain ~24h chart. The match is a coincidence — flagged
 * explicitly here, as a named constant, because a bare `36` in both places
 * previously made the "coupling" look intentional when it wasn't.
 */
export const SHORT_SPAN_HOURS = 36;

/**
 * Upper bound (hours) of the "medium" tier: day+hour labels, e.g. "Mon 06:00".
 *
 * A forecast overlay is drawn on the same unclipped actual+forecast grid as
 * the chart itself (`buildSeriesGrid` in chartAdapters.ts merges every
 * timestamp into one `[tStart, tEnd]` range), so a HOURLY_PRESETS chart's
 * *rendered* span can run well past its ~24h nominal window:
 *   - Load + ML forecast:        window end -> now+48h  (measured ~71h)
 *   - Load + TSO day-ahead:      forecast data ends ~D+1/D+2 (measured ~51h)
 *   - Load + TSO week-ahead:     query window -> now+7d (`getTSOForecastDateRange`,
 *                                 futureDays=7, in useLoadChartData.ts) — the
 *                                 whole point of week-ahead is to reach that far,
 *                                 even though today's data happens not to
 *                                 stretch that far out
 *   - Price (day-ahead auction): window end -> now+36h (`getPriceWindowEnd`)
 *   - Net position:               window end -> now+3d (by design)
 *
 * 216h (9 days) covers the structural worst case — a 24h window's own ~1 day
 * plus the TSO week-ahead overlay's 7-day forward reach — with a day of
 * headroom, so "hour" never silently disappears just because a forecast
 * layer got switched on. Anything wider than this falls back to the
 * pre-existing date-only tier.
 */
export const MEDIUM_SPAN_HOURS = 216;

type TickTier = 'hour' | 'dayHour' | 'date';

function formatTick(d: Date, tier: TickTier): string {
  const hm = () => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  switch (tier) {
    case 'hour':
      return hm();
    case 'dayHour':
      return `${d.toLocaleDateString([], { weekday: 'short' })} ${hm()}`;
    case 'date':
      return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
}

/**
 * Evenly spaced X-axis ticks for a timestamp series. Hour-vs-date is not a
 * fair binary choice: a short sub-day window is labelled by hour (a 24h
 * chart with only date ticks, or none, cannot tell you when the peak
 * occurred), a multi-day window falls back to date-only as before, and
 * everything in between — the range a forecast overlay routinely produces —
 * gets both, e.g. "Mon 06:00", so the hour isn't lost just because the
 * window is a few days wide instead of one.
 *
 * Tiering is driven by the actual span of `timestamps` (first to last), not
 * the preset's nominal window, because that's what's really on the axis.
 */
export function timeTicks(
  timestamps: string[],
  preset: string,
  target = 5,
): { index: number; label: string }[] {
  if (timestamps.length === 0) return [];

  const hourly = HOURLY_PRESETS.has(preset);
  const count = Math.min(target, timestamps.length);
  const step = Math.max(1, Math.floor((timestamps.length - 1) / Math.max(1, count - 1)));

  const firstMs = new Date(timestamps[0]).getTime();
  const lastMs = new Date(timestamps[timestamps.length - 1]).getTime();
  const spanHours =
    Number.isFinite(firstMs) && Number.isFinite(lastMs)
      ? Math.abs(lastMs - firstMs) / 3_600_000
      : Infinity;

  const tier: TickTier = !hourly
    ? 'date'
    : spanHours <= SHORT_SPAN_HOURS
      ? 'hour'
      : spanHours <= MEDIUM_SPAN_HOURS
        ? 'dayHour'
        : 'date';

  const out: { index: number; label: string }[] = [];
  for (let i = 0; i < timestamps.length; i += step) {
    const d = new Date(timestamps[i]);
    if (Number.isNaN(d.getTime())) continue;
    out.push({ index: i, label: formatTick(d, tier) });
  }
  return out;
}
