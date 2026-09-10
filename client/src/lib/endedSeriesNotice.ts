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
  if (!lastPublished) return null;
  const at = lastPublished instanceof Date ? lastPublished : new Date(lastPublished);
  if (Number.isNaN(at.getTime())) return null;

  return `No data published since ${formatEndedDate(at)}. The series has stopped upstream, not here.`;
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
