/**
 * Placing query rows into the 24 hour slots the Living Grid indexes by.
 *
 * Rows arrive already averaged per UTC hour by the SQL (`load`, `price` and
 * `generation` are published every 15 minutes, so the hour is a mean of up to
 * four readings; `net_position` and `crossborder_flows` are hourly and the
 * average is a no-op). What is left is the mapping from an hour key to a slot,
 * which the day window has already resolved — including the DST hole.
 *
 * A slot with no row stays `null`. That is the house rule, not a convenience:
 * a value the database does not have must not arrive as 0, because every
 * consumer downstream renders 0 as a measurement.
 */

/** The 24-slot series every zone stream is served as. */
export type HourSeries = (number | null)[];

export const HOURS_IN_DAY = 24;

/** 24 nulls — the shape a zone with no rows at all still returns. */
export function emptySeries(): HourSeries {
  return new Array<number | null>(HOURS_IN_DAY).fill(null);
}

/**
 * Hour key (`YYYY-MM-DD HH`) to slot index. Null keys — the skipped DST hour —
 * are absent, so no row can land in them.
 */
export function hourSlotIndex(hourKeys: (string | null)[]): Map<string, number> {
  const index = new Map<string, number>();
  hourKeys.forEach((key, slot) => {
    if (key !== null) index.set(key, slot);
  });
  return index;
}

/** A query row carrying the bucket key the SQL computed. */
export interface HourKeyed {
  hourKey: string;
}

/**
 * Scatter rows into a 24-slot series. Rows outside the day (possible when the
 * window's wide index prefilter overshoots) are ignored rather than clamped.
 */
export function placeRows<T extends HourKeyed>(
  rows: readonly T[],
  index: Map<string, number>,
  value: (row: T) => number | null,
): HourSeries {
  const series = emptySeries();
  for (const row of rows) {
    const slot = index.get(row.hourKey);
    if (slot === undefined) continue;
    const v = value(row);
    series[slot] = v === null || Number.isNaN(v) ? null : v;
  }
  return series;
}

/** True when a series holds no measurement at all. */
export function isEmptySeries(series: HourSeries): boolean {
  return series.every((v) => v === null);
}
