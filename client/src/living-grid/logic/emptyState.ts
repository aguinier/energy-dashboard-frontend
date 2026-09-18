import { hourLabel } from './format';

/**
 * Why a panel section has nothing to show.
 *
 * There are two different reasons and they must not share a sentence. A zone
 * that published nothing all day is a different claim from one that published
 * plenty but not for the hour on screen — and during the morning, when the
 * day's ingest has only reached a few hours, the second is the common case.
 * Telling a reader "nothing today" while the data sits one scrub away is
 * simply false.
 */

export type EmptyReason =
  | { kind: 'none-today' }
  | { kind: 'not-this-hour'; latestHour: number };

/**
 * Classify a 24-slot series at `hour`, or `null` when there IS something to
 * show and the section should render normally.
 */
export function emptyReason(
  series: readonly (number | null)[] | undefined,
  hour: number,
): EmptyReason | null {
  const values = series ?? [];
  if (values[hour] !== null && values[hour] !== undefined) return null;

  let latest = -1;
  for (let h = 0; h < values.length; h++) {
    if (values[h] !== null && values[h] !== undefined) latest = h;
  }
  return latest === -1 ? { kind: 'none-today' } : { kind: 'not-this-hour', latestHour: latest };
}

/** The sentence for a reason. `what` is a lowercase noun, e.g. "generation". */
export function emptyMessage(reason: EmptyReason, what: string): string {
  if (reason.kind === 'none-today') {
    return `No ${what} published for this zone today.`;
  }
  return `No ${what} for this hour yet — the latest today is ${hourLabel(reason.latestHour)}.`;
}

/**
 * Collapse several series into one presence track, for a section backed by
 * more than one (the mix has eight fuels, the flows panel one per border).
 */
export function anyOf(all: readonly (readonly (number | null)[])[]): (number | null)[] {
  return Array.from({ length: 24 }, (_, h) =>
    all.some((s) => s[h] !== null && s[h] !== undefined) ? 1 : null,
  );
}
