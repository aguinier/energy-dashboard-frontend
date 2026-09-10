import { endedSeriesNotice } from '@/lib/endedSeriesNotice';
import type { MapDataPoint } from '@/types';

/**
 * A point that actually carries a number, so it can be coloured and hovered.
 *
 * `MapDataPoint.value` is nullable since ABL-719 — the server withholds a
 * window average that would not describe the window — and this narrowing is
 * what keeps that null out of `dataColor`/`formatHoverValue` rather than
 * letting it arrive there and render as a confident 0.
 */
export type RankedPoint = MapDataPoint & { value: number };

export interface MapRowIndex {
  /** Colour-scale bounds over the ranked values only. */
  min: number;
  max: number;
  /** Countries with a number: the only ones that get a fill and a click. */
  ranked: Map<string, RankedPoint>;
  /**
   * Countries hatched *for a reason we can state*, code -> sentence. A country
   * absent from both maps is simply one we hold nothing for, and gets the bare
   * "no data" wording.
   */
  endedNotices: Map<string, string>;
}

/**
 * Split one metric's rows into "on the scale" and "hatched, and here is why".
 *
 * Pure and separate from `EuropeMap` for the reason `netPositionMapScope.ts`
 * already gives: `<Geographies geography={url}>` fetches its topojson, so it
 * renders no country shapes under `renderToString` and this decision cannot be
 * asserted through the component.
 *
 * The withheld rows are deliberately kept rather than discarded. Dropping them
 * hatches the country too — nothing colours a code that is not in `ranked` —
 * but it throws away the only thing that separates "this series stopped on
 * 30 August" from "we have never held this country", which are the same blank
 * shape and very different facts.
 */
export function indexMapRows(rows: MapDataPoint[] | undefined | null): MapRowIndex {
  const ranked = new Map<string, RankedPoint>();
  const endedNotices = new Map<string, string>();

  for (const row of rows ?? []) {
    if (row.value != null && Number.isFinite(row.value)) {
      ranked.set(row.country_code, row as RankedPoint);
      continue;
    }
    if (row.coverage !== 'ended') continue;
    const notice = endedSeriesNotice(row.timestamp);
    if (notice) endedNotices.set(row.country_code, notice);
  }

  const values = [...ranked.values()].map((d) => d.value);
  // The 0/100 fallback is the pre-existing empty-map default. It colours
  // nothing — there is nothing to colour — and only keeps `dataColor` off a
  // ±Infinity domain.
  if (values.length === 0) return { min: 0, max: 100, ranked, endedNotices };

  return { min: Math.min(...values), max: Math.max(...values), ranked, endedNotices };
}
