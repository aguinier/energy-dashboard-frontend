// How old is a single measured reading, and may it still be shown as "current"?
//
// The "Current load" stat tile (AbleStatRow.tsx) used to render
// `overview.currentLoad` bare, whatever its age. `/dashboard/overview`'s load
// query is unbounded on purpose - it returns the latest measurement we hold,
// because bounding it to the selected window blanks the tile for every country
// under the `+24h`/`+7d` presets (see dashboardService.ts). The age therefore
// has to be handled here, at the point of display: measured 2026-08-07, GB's
// freshest `energy_load` row is 2021-06-14 and UA's is 2022-02-25, so the tile
// was announcing 37.27 GW and 14.44 GW as the current national load of two
// countries whose ingest had been dead for years - directly above a chart that
// correctly said "no data in this window".
//
// Kept pure and separate from the component because this client is vitest-only
// (no jsdom/RTL), so anything worth testing has to be (data in) -> (value out);
// same pattern as chartSummary.ts and windowLabel.ts.

/**
 * Below this the gap is normal ENTSO-E publication lag and needs no note.
 * Same threshold, for the same reason, as trailingGapLabel's THRESHOLD_HOURS
 * (lib/trailingGap.ts) and summarizeSeries' "as of N hours ago" (chartSummary.ts)
 * - one page should not draw the line in three places.
 */
export const DISCLOSE_AFTER_HOURS = 2;

/**
 * Beyond this the reading is withheld rather than captioned.
 *
 * Two full diurnal cycles. Load is strongly periodic over 24h and over the
 * week, so a reading older than two days is from a different day - plausibly a
 * different weekday, and at the tail end a different season - and nothing about
 * it describes "now". A caveat cannot rescue it: "37.27 GW, as of 45117h ago"
 * still leads with a number the user reads as the answer. Below the bound a
 * caption is honest and useful (measured: the healthy countries run 6-8h behind
 * and MK 33h), which is exactly what the chart caption on the same page already
 * does.
 */
export const WITHHOLD_AFTER_HOURS = 48;

export interface ReadingFreshness {
  /** False when the reading must not be presented as the current value. */
  usable: boolean;
  /** Age in hours, or null when it could not be established. */
  ageHours: number | null;
  /** Caveat to render beside the label; null when the reading needs none. */
  qualifier: string | null;
}

/**
 * Parse a timestamp as it comes off the API into epoch ms.
 *
 * Accepts both shapes the database holds ('2026-08-06 23:45:00' and
 * '2021-06-14T09:00:00') and treats a value with no zone designator as UTC,
 * which is what a `timestamp_utc` column means. The server now stamps the 'Z'
 * itself (server/src/utils/timestamp.ts `toIsoUtc`), but this client is
 * routinely proxied at a production server that has not been redeployed yet
 * (see CLAUDE.md, `API_PROXY_TARGET`), so accepting the bare form is not
 * belt-and-braces - it is the live wire format until that deploy lands.
 *
 * Returns null for anything unparseable rather than NaN, so callers get one
 * "unknown" case instead of arithmetic that silently succeeds.
 */
export function parseUtcTimestamp(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const trimmed = ts.trim();
  if (!trimmed) return null;

  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed)
    ? trimmed.replace(' ', 'T')
    : `${trimmed.replace(' ', 'T')}Z`;

  const t = Date.parse(zoned);
  return Number.isFinite(t) ? t : null;
}

/** "7h" / "3d" / "5mo" / "5y" - coarse enough to read at 10px, honest at every scale. */
export function formatAge(hours: number): string {
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 60) return `${Math.round(days)}d`;
  const months = days / 30.44;
  if (months < 24) return `${Math.round(months)}mo`;
  return `${Math.round(days / 365.25)}y`;
}

/**
 * Classify a reading's age into show-bare / show-with-caveat / withhold.
 *
 * An unparseable or absent timestamp is withheld, not assumed fresh: we cannot
 * vouch for the value's age, and the whole failure mode being fixed here is a
 * number presented as current on no evidence that it is.
 */
export function describeReadingFreshness(
  timestamp: string | null | undefined,
  now: Date = new Date(),
): ReadingFreshness {
  const t = parseUtcTimestamp(timestamp);
  if (t == null) return { usable: false, ageHours: null, qualifier: 'age unknown' };

  // Clamp a future-stamped reading (clock skew between us and the ingest box)
  // to zero rather than reporting a negative age.
  const ageHours = Math.max(0, (now.getTime() - t) / 3_600_000);

  if (ageHours < DISCLOSE_AFTER_HOURS) {
    return { usable: true, ageHours, qualifier: null };
  }
  if (ageHours <= WITHHOLD_AFTER_HOURS) {
    return { usable: true, ageHours, qualifier: `as of ${formatAge(ageHours)} ago` };
  }
  return { usable: false, ageHours, qualifier: `last reading ${formatAge(ageHours)} ago` };
}
