/**
 * Normalize ISO timestamp to SQLite format
 * Converts "2025-12-27T00:00:00.000Z" to "2025-12-27 00:00:00"
 *
 * SQLite stores timestamps with space separator, but ISO format uses 'T'.
 * String comparison fails because ' ' (ASCII 32) < 'T' (ASCII 84).
 */
export function normalizeTimestamp(isoTimestamp: string): string {
  return isoTimestamp.replace('T', ' ').replace('Z', '').split('.')[0];
}

/**
 * The inverse: a stored timestamp -> an unambiguous ISO-8601 UTC string.
 *
 * Every `timestamp_utc` column is UTC by name and by construction, but the
 * stored text does not say so, and it is not stored in one shape:
 * `energy_load` alone holds 2,485,282 rows with a space separator and 279,880
 * with a 'T' (measured 2026-08-07 against the replica) - GB's and UA's rows,
 * the two most stale in the table, are all 'T'-form. Handed to a browser
 * verbatim, `'2021-06-14T09:00:00'` parses as *local* time (ECMA-262 treats a
 * date-time form with no offset as local) while `'2021-06-14 09:00:00'` is not
 * a valid ISO form at all, so a client computing "how old is this reading?"
 * gets an answer that is wrong by the user's UTC offset, or NaN.
 *
 * Stamping the 'Z' server-side settles it once for every consumer rather than
 * asking each one to re-derive the timezone of a column called `_utc`.
 * Returns `undefined` for a missing/blank value so a caller can spread it into
 * an optional field unchanged.
 */
export function toIsoUtc(dbTimestamp: string | null | undefined): string | undefined {
  if (!dbTimestamp) return undefined;
  const trimmed = dbTimestamp.trim();
  if (!trimmed) return undefined;

  // Already carries a zone designator ('Z' or +HH:MM/-HH:MM) - leave it alone.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) return trimmed.replace(' ', 'T');

  return `${trimmed.replace(' ', 'T')}Z`;
}
