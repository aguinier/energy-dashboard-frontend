/**
 * The one sentence this dashboard uses when a series we held has gone quiet.
 *
 * It already existed twice on the country document's net position figure. The
 * choropleth needed a third copy when ABL-719 made it hatch a dead country
 * instead of painting its partial-window average, so the wording moved here:
 * the map and the country page are two views of the same fact about the same
 * country, and a reader who checks one against the other must not find two
 * different explanations.
 *
 * It says what we hold and when it ends, and nothing about why (ABL-763). A
 * frozen last row has three causes this client cannot tell apart — between
 * passes, our ingest broke, the series stopped upstream — and the `ended`
 * verdict behind this sentence only rules out the first. An ingest stall
 * across the portfolio (the ABL-630 shape) hatches every country at once, and
 * any sentence placing the stop upstream would then be false on all of them.
 * Do not reintroduce a cause on the strength of the rest of the map being
 * live: that is a threshold on a count of countries, and it still cannot say
 * which case this is. "since", not "published since", for the same reason —
 * we know where our rows end, not whether anything was published after them.
 *
 * Dates render in **UTC**, because that is what the instant is — every
 * `timestamp_utc` in this database is UTC, and formatting one in the viewer's
 * zone moves the printed day across the boundary for anything stored late in
 * the evening. IE's last row, `2026-08-30T22:30:00Z`, would read as 31 August
 * to a reader in Brussels.
 *
 * Returns `null` when there is no known last row: without a date there is no
 * end to state, only that we hold nothing, and that is a different (weaker)
 * sentence for the caller to render.
 */
export function endedSeriesNotice(lastHeld: string | Date | null | undefined): string | null {
  const at = parseInstant(lastHeld);
  if (!at) return null;

  return `No data since ${formatEndedDate(at)}.`;
}

/**
 * The same fact for the Core view (ABL-761).
 *
 * The Core figure is captured from JAO by us, and that capture can stall
 * silently (`server/src/services/coreNetPositionService.ts`, the
 * `getCoreNetPositionMap` doc). JAO publishes daily in lockstep across all 12
 * hubs, so a Core zone gone quiet most plausibly means *our* capture stopped —
 * exactly the failure the map's coverage rule exists to catch. Like
 * `endedSeriesNotice` it names no cause; it differs only in naming the Core
 * figure and in its verb.
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
