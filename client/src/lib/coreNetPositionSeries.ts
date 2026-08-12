import type { AbleSeriesPoint } from '@/components/charts/AbleLineChart';
import type { CoreNetPositionResponse } from '@/types';

const HOUR_MS = 60 * 60 * 1000;

function hourKey(ts: string): number {
  const ms = new Date(ts).getTime();
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

export interface CoreNetPositionSeriesResult {
  series: AbleSeriesPoint[];
  nowIndex: number;
  /**
   * How many published intervals the densest hour on screen was built from.
   * `1` for an already-hourly series, `4` for JAO's native quarter-hours. The
   * tab prints it, because "hourly average of 4 published intervals" and
   * "hourly value" are different claims and only one of them is true here.
   */
  maxIntervalsPerHour: number;
}

/**
 * Core CCR net position → the line chart's hourly grid (ABL-234).
 *
 * A separate adapter from `chartAdapters.adaptNetPositionSeries` rather than a
 * flag on it, because of one thing that adapter would get silently wrong:
 * JAO publishes the Core figure at **15-minute** resolution while ENTSO-E
 * publishes the all-coupled figure hourly. `adaptNetPositionSeries` writes
 * each point into its hour bin unconditionally, so four quarters landing in
 * one bin leaves the LAST quarter standing and discards the other three — a
 * chart drawn from a quarter of the data, labelled as if it were the hour.
 * Measured on the real JAO response for 2026-08-09 08:00 UTC, France's four
 * quarters are −114.9, −624.8, +174.8 and −910.7 MW: last-write-wins would
 * have drawn −910.7 for that hour against a true hourly mean of −368.9.
 *
 * So the quarters are **averaged**, not sampled. That is also what makes the
 * two toggle states comparable at all — measured the same hour, DE-LU's four
 * Core quarters average to 9,423.875 MW, exactly its all-coupled hourly value,
 * and NL's to 1,695.15, exactly its own. Sampling one quarter would have made
 * two identical quantities look like they disagreed by a gigawatt.
 *
 * An hour with fewer than four published intervals is averaged over the ones
 * that exist. That is an average of what was published, never a value carried
 * in from a neighbouring hour — nothing here fills a gap.
 */
export function adaptCoreNetPositionSeries(
  data: CoreNetPositionResponse | undefined,
  now: Date = new Date(),
): CoreNetPositionSeriesResult {
  const actual = data?.actual ?? [];
  if (actual.length === 0) return { series: [], nowIndex: 0, maxIntervalsPerHour: 0 };

  const sums = new Map<number, { total: number; count: number }>();
  for (const p of actual) {
    if (!p.timestamp || !Number.isFinite(p.net_position_mw)) continue;
    const key = hourKey(p.timestamp);
    if (!Number.isFinite(key)) continue;
    const bucket = sums.get(key);
    if (bucket) {
      bucket.total += p.net_position_mw;
      bucket.count += 1;
    } else {
      sums.set(key, { total: p.net_position_mw, count: 1 });
    }
  }

  const keys = [...sums.keys()];
  if (keys.length === 0) return { series: [], nowIndex: 0, maxIntervalsPerHour: 0 };

  const tStart = Math.min(...keys);
  const tEnd = Math.max(...keys);
  const nowMs = now.getTime();

  const points: AbleSeriesPoint[] = [];
  for (let t = tStart; t <= tEnd; t += HOUR_MS) {
    const bucket = sums.get(t);
    points.push({
      ts: new Date(t).toISOString(),
      future: t > nowMs,
      // An hour with no published interval stays null, so the chart shows a
      // break rather than a line drawn straight across the gap.
      value: bucket ? bucket.total / bucket.count : null,
      forecast: null,
    });
  }

  let nowIndex = points.findIndex((p) => new Date(p.ts).getTime() > nowMs);
  if (nowIndex === -1) nowIndex = points.length - 1;
  else nowIndex = Math.max(0, nowIndex - 1);

  const maxIntervalsPerHour = Math.max(...[...sums.values()].map((b) => b.count));

  return { series: points, nowIndex, maxIntervalsPerHour };
}
