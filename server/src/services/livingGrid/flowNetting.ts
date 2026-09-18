/**
 * Turning ENTSO-E's two directed legs into the one signed number per border
 * the map's corridor arrows are drawn from.
 *
 * `crossborder_flows` stores each direction as its own row, each a
 * non-negative MW figure: `DE -> FR` and `FR -> DE` are two rows for the same
 * hour on the same border, and on a busy border both are usually present
 * because the flow reverses within the hour or the TSOs report gross legs. The
 * map wants one arrow, so the legs are netted.
 *
 * The key is alphabetical (`"DE-FR"`, never `"FR-DE"`) and the sign is read
 * against it: **positive means the first zone exports to the second**. Callers
 * must not infer direction from anything else, because the alphabetical key
 * deliberately discards the order the rows arrived in.
 *
 * An hour where NEITHER leg exists is `null`, not 0 — for a future hour the
 * realized flow has simply not happened yet, and drawing that as a still
 * border would be a claim the data does not make.
 */

import { emptySeries, type HourSeries, type HourKeyed } from './hourBuckets.js';

export interface FlowRow extends HourKeyed {
  country_from: string;
  country_to: string;
  flow_mw: number | null;
}

/** The alphabetical border key two zones share. */
export function borderKey(a: string, b: string): string {
  return a <= b ? `${a}-${b}` : `${b}-${a}`;
}

/** True when `from -> to` is the key's positive direction. */
function isForward(from: string, to: string): boolean {
  return from <= to;
}

/**
 * Net every border in `rows` into a 24-slot signed series.
 *
 * Repeated rows for one leg and hour are summed, which matters where a border
 * is reported per interconnector rather than per zone pair.
 */
export function netFlows(
  rows: readonly FlowRow[],
  index: Map<string, number>,
): Record<string, HourSeries> {
  const out: Record<string, HourSeries> = {};

  for (const row of rows) {
    if (row.flow_mw === null || Number.isNaN(row.flow_mw)) continue;
    const slot = index.get(row.hourKey);
    if (slot === undefined) continue;
    if (row.country_from === row.country_to) continue;

    const key = borderKey(row.country_from, row.country_to);
    let series = out[key];
    if (series === undefined) {
      series = emptySeries();
      out[key] = series;
    }

    const signed = isForward(row.country_from, row.country_to) ? row.flow_mw : -row.flow_mw;
    series[slot] = (series[slot] ?? 0) + signed;
  }

  return out;
}
