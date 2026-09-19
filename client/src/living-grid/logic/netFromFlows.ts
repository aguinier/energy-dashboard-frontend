import type { GridDay } from '@/types';
import type { DayRelation } from './dayRange';

/**
 * A zone's net position derived by summing its borders.
 *
 * Six of the design's zones — IT, DK, SE, NO, CH, GB — publish no day-ahead
 * net position to ENTSO-E's A25, so the map would leave a hole across most of
 * Scandinavia and the Alps. Their physical border flows ARE published, and a
 * zone's net position is by definition the sum of its signed borders, so the
 * figure can be recovered.
 *
 * It is NOT the same quantity as the A25 figure and must not be presented as
 * one:
 *
 * - it is realized physical flow, about an hour behind, where A25 is the
 *   day-ahead commercial schedule — so it stops at the current hour rather
 *   than running to the end of the day;
 * - it only counts borders present in the payload, so a zone with an
 *   unreported interconnector reads short.
 *
 * Callers label it. `basisOf` exists so no caller has to remember to.
 */

export type NetBasis = 'scheduled' | 'derived' | 'none';

/** Sum the signed flows on every border touching `code`. */
export function netFromFlows(
  flows: Record<string, (number | null)[]>,
  code: string,
  hour: number,
): number | null {
  let total: number | null = null;
  for (const [key, series] of Object.entries(flows)) {
    const [a, b] = key.split('-');
    if (a !== code && b !== code) continue;
    const value = series[hour];
    if (value === null || value === undefined) continue;
    // The key's positive direction is a -> b, so `a` exporting is positive
    // for a and negative for b.
    total = (total ?? 0) + (a === code ? value : -value);
  }
  return total;
}

/** The whole day derived from flows, for the sparkline. */
export function netSeriesFromFlows(
  flows: Record<string, (number | null)[]>,
  code: string,
): (number | null)[] {
  return Array.from({ length: 24 }, (_, hour) => netFromFlows(flows, code, hour));
}

/**
 * Which basis a zone's net position is on, preferring the published schedule.
 */
export function basisOf(day: GridDay, code: string): NetBasis {
  const published = day.zones[code]?.net;
  if (published && published.some((v) => v !== null)) return 'scheduled';
  const derived = netSeriesFromFlows(day.flows, code);
  return derived.some((v) => v !== null) ? 'derived' : 'none';
}

/**
 * A zone's net position for the day on whichever basis is available, with the
 * basis named so the UI can say so.
 */
export function resolveNetSeries(
  day: GridDay,
  code: string,
): { series: (number | null)[]; basis: NetBasis } {
  const published = day.zones[code]?.net;
  if (published && published.some((v) => v !== null)) {
    return { series: published, basis: 'scheduled' };
  }
  const derived = netSeriesFromFlows(day.flows, code);
  return derived.some((v) => v !== null)
    ? { series: derived, basis: 'derived' }
    : { series: new Array<number | null>(24).fill(null), basis: 'none' };
}

/**
 * Human label for the basis, for the panel's note line.
 *
 * Only the absent case needs the day: the other two describe where a number
 * came from, which is true whenever it was published. "today" in an absence is
 * a claim about which day is empty, and the day control can point anywhere.
 */
export function basisNote(basis: NetBasis, relation: DayRelation = 'today'): string {
  if (basis === 'scheduled') return 'Day-ahead scheduled net position (ENTSO-E A25).';
  if (basis === 'derived') {
    return 'Derived from realized border flows — no day-ahead net position is published for this zone.';
  }
  if (relation === 'future') {
    return 'No net position for this day yet — it is not published this far ahead.';
  }
  return relation === 'today'
    ? 'No net position published for this zone today.'
    : 'No net position published for this zone on this day.';
}
