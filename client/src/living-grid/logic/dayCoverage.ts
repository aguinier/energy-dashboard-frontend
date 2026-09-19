import { GRID_FUEL_KEYS, type GridDay } from '@/types';
import type { DayRelation } from './dayRange';

/**
 * What a day actually carries, and the one sentence that says so.
 *
 * The map answers "what is happening" by drawing it, which works right up until
 * there is nothing to draw — and then a blank Europe is indistinguishable from
 * a broken one. Every stream the view renders stops at a different horizon
 * (prices reach the day-ahead auction, realized load and flows stop at now), so
 * a day ahead of today is usually neither full nor empty but somewhere between,
 * and only naming the streams tells the reader which.
 *
 * This is a claim about the payload in hand, never about the world: it says
 * "nothing here", not "nothing exists".
 */

export interface DayCoverage {
  zoneCount: number;
  /** True when the payload carries no zone with any value at all. */
  empty: boolean;
  streams: {
    load: boolean;
    price: boolean;
    net: boolean;
    mix: boolean;
    flows: boolean;
  };
}

const hasValue = (series: readonly (number | null)[] | undefined): boolean =>
  series !== undefined && series.some((v) => v !== null && v !== undefined);

export function dayCoverage(day: GridDay): DayCoverage {
  const zones = Object.values(day.zones);
  const streams = {
    load: zones.some((z) => hasValue(z.load)),
    price: zones.some((z) => hasValue(z.price)),
    net: zones.some((z) => hasValue(z.net)),
    mix: zones.some((z) => GRID_FUEL_KEYS.some((fuel) => hasValue(z.mix?.[fuel]))),
    flows: Object.values(day.flows).some(hasValue),
  };
  return {
    zoneCount: Object.keys(day.zones).length,
    empty: !Object.values(streams).some(Boolean),
    streams,
  };
}

/** The reader-facing names, in the order the sentence should list them. */
const STREAM_LABELS: readonly [keyof DayCoverage['streams'], string][] = [
  ['price', 'day-ahead prices'],
  ['net', 'net positions'],
  ['load', 'load'],
  ['mix', 'the generation mix'],
  ['flows', 'cross-border flows'],
];

function listStreams(coverage: DayCoverage): string {
  const present = STREAM_LABELS.filter(([key]) => coverage.streams[key]).map(([, label]) => label);
  if (present.length <= 1) return present[0] ?? '';
  return `${present.slice(0, -1).join(', ')} and ${present[present.length - 1]}`;
}

/**
 * The banner over the map, or null when the day speaks for itself.
 *
 * A complete day says nothing — the map is the message. The tense is the whole
 * point of the split: "is not published" describes a fault, "is not published
 * yet" describes a schedule, and getting that backwards on a day that has not
 * happened is the kind of confident wrongness this view exists to avoid.
 */
export function coverageNote(coverage: DayCoverage, relation: DayRelation): string | null {
  if (relation === 'future') {
    if (coverage.empty) return 'Nothing is published for this day yet.';
    const listed = listStreams(coverage);
    const sentence = listed.charAt(0).toUpperCase() + listed.slice(1);
    return `${sentence} only — nothing else is published this far ahead.`;
  }
  if (coverage.empty) return 'Nothing is published for this day.';
  return null;
}
