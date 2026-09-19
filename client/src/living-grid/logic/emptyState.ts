import { hourLabel } from './format';
import type { DayRelation } from './dayRange';

/**
 * Why a panel section has nothing to show.
 *
 * There are five different reasons and they must not share a sentence. A zone
 * that published nothing all day is a different claim from one that published
 * plenty but not for the hour on screen — and during the morning, when the
 * day's ingest has only reached a few hours, the second is the common case.
 * Telling a reader "nothing today" while the data sits one scrub away is
 * simply false.
 *
 * The third is an interior hole: the day reports either side of the hour on
 * screen. That is not an update running late, and saying "yet" while naming an
 * hour further down the day points the reader forward at data already in hand.
 *
 * The fourth is a day that has not happened. An all-null series is a hole on a
 * day that has been and a schedule on a day that has not, and the difference is
 * the whole difference between a fault and a wait. It is also why every
 * sentence here has to know which day it is talking about: "published nothing
 * today" is a false claim about next Tuesday, and the word "today" cannot
 * appear in copy that a day control can point at any day of the week.
 *
 * The fifth is a measured zero, and it is the one `emptyReason` cannot see:
 * "the zone published a number" and "the section has something to draw" are
 * different questions, and a section whose own rule is stricter than presence
 * — the mix needs a positive total before it has a bar — must supply this one
 * itself. Nothing here derives it.
 */

export type EmptyReason =
  | { kind: 'none' }
  | { kind: 'not-yet-published' }
  | { kind: 'not-this-hour'; latestHour: number }
  | { kind: 'gap'; resumesHour: number }
  | { kind: 'zero' };

/**
 * Classify a 24-slot series at `hour`, or `null` when there IS something to
 * show and the section should render normally.
 *
 * `relation` defaults to 'today' so the caller that has not been taught about
 * days yet keeps its existing behaviour rather than silently changing tense.
 */
export function emptyReason(
  series: readonly (number | null)[] | undefined,
  hour: number,
  relation: DayRelation = 'today',
): EmptyReason | null {
  const values = series ?? [];
  if (values[hour] !== null && values[hour] !== undefined) return null;

  let latest = -1;
  for (let h = 0; h < values.length; h++) {
    if (values[h] !== null && values[h] !== undefined) latest = h;
  }
  // Nothing all day: a hole if the day has been, a schedule if it has not.
  if (latest === -1) return relation === 'future' ? { kind: 'not-yet-published' } : { kind: 'none' };

  // A future day can still report partially — D+1 carries the day-ahead
  // auction and nothing realized — so the two hour-level reasons below apply
  // there exactly as they do on today.
  //
  // Anything still to come after this hour means the day has already moved
  // past it, so the hole is a gap rather than an update that has not landed.
  for (let h = hour + 1; h < values.length; h++) {
    if (values[h] !== null && values[h] !== undefined) return { kind: 'gap', resumesHour: h };
  }
  return { kind: 'not-this-hour', latestHour: latest };
}

/** The sentence for a reason. `what` is a lowercase noun, e.g. "generation". */
export function emptyMessage(
  reason: EmptyReason,
  what: string,
  relation: DayRelation = 'today',
): string {
  if (reason.kind === 'none') {
    // "today" is only true on today; on any other day it names the wrong one.
    return relation === 'today'
      ? `No ${what} published for this zone today.`
      : `No ${what} published for this zone on this day.`;
  }
  if (reason.kind === 'not-yet-published') {
    return `No ${what} for this day yet — it is not published this far ahead.`;
  }
  if (reason.kind === 'gap') {
    return `No ${what} for this hour — a gap in the day; it resumes at ${hourLabel(reason.resumesHour)}.`;
  }
  if (reason.kind === 'zero') {
    return `Reported ${what} for this hour is zero.`;
  }
  // "yet" is a promise the hour will fill, which only today can make.
  return relation === 'today'
    ? `No ${what} for this hour yet — the latest today is ${hourLabel(reason.latestHour)}.`
    : `No ${what} for this hour — the latest for this day is ${hourLabel(reason.latestHour)}.`;
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
