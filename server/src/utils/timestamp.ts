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
