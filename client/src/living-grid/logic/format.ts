/**
 * Number and label formatting for the Living Grid.
 *
 * Signed figures use U+2212 MINUS SIGN rather than a hyphen, matching the
 * design and keeping the minus the same width as the plus in IBM Plex Mono —
 * without it a column of net positions jitters as values cross zero.
 */

export const MINUS = '−';

/** `+2.0` / `−2.0` GW from a MW figure. */
export function signedGw(mw: number | null | undefined, digits = 1): string {
  if (mw === null || mw === undefined) return '—';
  const gw = mw / 1000;
  const sign = gw >= 0 ? '+' : MINUS;
  return sign + Math.abs(gw).toFixed(digits);
}

/** Unsigned GW, for loads and generation totals. */
export function gw(mw: number | null | undefined, digits = 1): string {
  if (mw === null || mw === undefined) return '—';
  return (mw / 1000).toFixed(digits);
}

/** `€66`, or `—` when the hour has no price. */
export function euro(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined) return '—';
  const rounded = value.toFixed(digits);
  return rounded.startsWith('-') ? `${MINUS}€${rounded.slice(1)}` : `€${rounded}`;
}

/** `14:00` from an hour index. */
export function hourLabel(hour: number): string {
  return `${String(Math.max(0, Math.min(23, hour))).padStart(2, '0')}:00`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `Mon 15 Sep 2026` from a `YYYY-MM-DD` date.
 *
 * Parsed as UTC deliberately: the string names a calendar day, and letting the
 * viewer's timezone shift it would print the day before for anyone west of
 * Greenwich.
 */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  const at = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[at.getUTCDay()]} ${d} ${MONTHS[m - 1]} ${y}`;
}

/** Percentage with one decimal, or `—`. */
export function percent(fraction: number | null | undefined, digits = 1): string {
  if (fraction === null || fraction === undefined) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** The smallest and largest non-null value in a series. */
export function seriesRange(series: (number | null)[]): { min: number; max: number } | null {
  const values = series.filter((v): v is number => v !== null && v !== undefined);
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}
