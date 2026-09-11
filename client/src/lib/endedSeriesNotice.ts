/**
 * The one sentence this dashboard uses when a series has stopped upstream.
 *
 * It already existed twice on the country document's net position figure. The
 * choropleth needed a third copy when ABL-719 made it hatch a dead country
 * instead of painting its partial-window average, so the wording moved here:
 * the map and the country page are two views of the same fact about the same
 * country, and a reader who checks one against the other must not find two
 * different explanations.
 *
 * "not here" is the load-bearing half. A hatched country otherwise reads as
 * "the dashboard is broken", and the map has no other way to say that we are
 * fetching normally and there is nothing to fetch.
 *
 * That claim is only ours to make for an ENTSO-E series. A stopped Core series
 * gets `coreCaptureStalledNotice` below instead (ABL-761).
 *
 * Dates render in **UTC**, because that is what the instant is — every
 * `timestamp_utc` in this database is UTC, and formatting one in the viewer's
 * zone moves the printed day across the boundary for anything published late
 * in the evening. IE's last row, `2026-08-30T22:30:00Z`, would read as
 * 31 August to a reader in Brussels.
 *
 * Returns `null` when there is no known last publication: without a date this
 * cannot honestly claim the series *stopped*, only that we hold nothing, and
 * that is a different (weaker) sentence for the caller to render.
 */
export function endedSeriesNotice(lastPublished: string | Date | null | undefined): string | null {
  const at = parseInstant(lastPublished);
  if (!at) return null;

  return `No data published since ${formatEndedDate(at)}. The series has stopped upstream, not here.`;
}

/**
 * The same fact for the Core view, without the cause (ABL-761).
 *
 * The Core figure is captured from JAO by us, and that capture can stall
 * silently (`server/src/services/coreNetPositionService.ts`, the
 * `getCoreNetPositionMap` doc). JAO publishes daily in lockstep across all 12
 * hubs, so a Core zone gone quiet most plausibly means *our* capture stopped —
 * exactly the failure the map's coverage rule exists to catch, and exactly the
 * one "stopped upstream, not here" would deny. So this states what we hold and
 * when it ends, and nothing about why.
 *
 * "captured" rather than "published": it is the only verb true whichever side
 * stopped, and it is the word the Core country figure already uses for its
 * never-switched-on state (`coreNetPositionNote.ts`). Same UTC date form and
 * same `null` rule as `endedSeriesNotice`, for the same reasons.
 */
export function coreCaptureStalledNotice(
  lastCaptured: string | Date | null | undefined,
): string | null {
  const at = parseInstant(lastCaptured);
  if (!at) return null;

  return `No Core net position captured since ${formatEndedDate(at)}.`;
}

function parseInstant(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The date form the notice prints, exported so a caller can match it. */
export function formatEndedDate(at: Date): string {
  return at.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
