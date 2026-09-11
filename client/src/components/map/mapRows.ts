import { coreCaptureStalledNotice, endedSeriesNotice } from '@/lib/endedSeriesNotice';
import type { MapDataPoint } from '@/types';

/**
 * Who fetched the rows being indexed. It decides what a withheld row may say
 * about *why* it stopped: an ENTSO-E series we fetch normally can be said to
 * have stopped upstream; the JAO Core capture is ours, can stall silently, and
 * so gets a sentence that names no cause (ABL-761).
 */
export type MapRowSource = 'entsoe' | 'jao_core';

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
 *
 * `source` has no default on purpose: the map draws from both, and a caller
 * that forgot to say which would get the upstream sentence for a stall of ours.
 */
export function indexMapRows(
  rows: MapDataPoint[] | undefined | null,
  source: MapRowSource,
): MapRowIndex {
  const ranked = new Map<string, RankedPoint>();
  const endedNotices = new Map<string, string>();
  const noticeFor = source === 'jao_core' ? coreCaptureStalledNotice : endedSeriesNotice;

  for (const row of rows ?? []) {
    if (row.value != null && Number.isFinite(row.value)) {
      ranked.set(row.country_code, row as RankedPoint);
      continue;
    }
    if (row.coverage !== 'ended') continue;
    const notice = noticeFor(row.timestamp);
    if (notice) endedNotices.set(row.country_code, notice);
  }

  const values = [...ranked.values()].map((d) => d.value);
  // The 0/100 fallback is the pre-existing empty-map default. It colours
  // nothing — there is nothing to colour — and only keeps `dataColor` off a
  // ±Infinity domain.
  if (values.length === 0) return { min: 0, max: 100, ranked, endedNotices };

  return { min: Math.min(...values), max: Math.max(...values), ranked, endedNotices };
}
