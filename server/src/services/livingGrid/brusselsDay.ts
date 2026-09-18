/**
 * The Living Grid day is a Europe/Brussels calendar day, not a UTC one.
 *
 * Everything the view renders is indexed by an hour 0-23: the price bars are
 * the day-ahead auction's delivery hours, the timeline scrubs "today", and the
 * header clock reads local time. The day-ahead market day IS the CET/CEST
 * calendar day, so bounding on UTC midnight would shift every zone's price
 * curve one or two hours against its own market and make "today's min-max"
 * answer a question nobody asked.
 *
 * Resolving local wall-clock hours to UTC instants needs the zone's offset at
 * each instant, which changes twice a year. `Intl.DateTimeFormat` already
 * carries the full IANA rule set, so this module derives the offset from it
 * rather than adding a timezone dependency to the server.
 *
 * DST is handled explicitly, because a local day is not always 24 hours:
 *
 * - **Spring forward** (local 02:00 never happens): that slot is `null`. The
 *   UI indexes 0-23 unconditionally, so the hour has to exist as a hole rather
 *   than shift every later hour up by one.
 * - **Fall back** (local 02:00 happens twice): the FIRST occurrence wins, so
 *   the mapping stays a function and the 25th hour is dropped. Deterministic,
 *   and the alternative — renumbering the day — would desynchronise the hour
 *   index from every other zone on the map.
 */

/** The IANA zone the Living Grid day is defined in. */
export const GRID_TIMEZONE = 'Europe/Brussels';

const HOUR_MS = 3_600_000;
const HOURS_IN_DAY = 24;

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: GRID_TIMEZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * The wall-clock reading in Brussels at `instantMs`, expressed as the UTC
 * epoch value of those same digits. The difference between this and the
 * instant is the zone's offset there.
 */
function wallClockMs(instantMs: number): number {
  const parts = partsFormatter.formatToParts(new Date(instantMs));
  const field = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  // Some engines render midnight as hour 24 under an h24 cycle.
  const hour = field('hour') % 24;
  return Date.UTC(field('year'), field('month') - 1, field('day'), hour, field('minute'), field('second'));
}

/**
 * The UTC instant whose Brussels wall clock reads `targetWallMs`, or `null`
 * when no such instant exists (the skipped hour).
 *
 * Probing either side of the target catches both transitions: on an ambiguous
 * hour two candidates survive and the earlier is taken; on a skipped hour none
 * round-trips.
 */
function utcForWallClock(targetWallMs: number): number | null {
  const candidates = new Set<number>();
  for (const probe of [targetWallMs, targetWallMs - 2 * HOUR_MS, targetWallMs + 2 * HOUR_MS]) {
    candidates.add(targetWallMs - (wallClockMs(probe) - probe));
  }
  const valid = [...candidates]
    .filter((instant) => wallClockMs(instant) === targetWallMs)
    .sort((a, b) => a - b);
  return valid.length > 0 ? valid[0] : null;
}

export interface GridDayWindow {
  /** The requested local date, `YYYY-MM-DD`. */
  date: string;
  timezone: string;
  /** 24 slots: the ISO UTC instant each local hour resolves to, or null. */
  hoursUtc: (string | null)[];
  /**
   * The same 24 slots as `YYYY-MM-DD HH` in UTC — the key rows are bucketed by,
   * so neither the SQL nor the caller re-derives timezone maths.
   */
  hourKeys: (string | null)[];
  /** Inclusive window bounds covering every slot, for the SQL range predicate. */
  startUtc: string;
  endUtc: string;
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** True when `date` is a real `YYYY-MM-DD` calendar date. */
export function isValidDate(date: string): boolean {
  if (!DATE_SHAPE.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** Today's date in Brussels, `YYYY-MM-DD`. */
export function todayInGridTimezone(now: Date = new Date()): string {
  const parts = partsFormatter.formatToParts(now);
  const field = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${field('year')}-${field('month')}-${field('day')}`;
}

/** The hour 0-23 it currently is in Brussels. */
export function currentHourInGridTimezone(now: Date = new Date()): number {
  const parts = partsFormatter.formatToParts(now);
  return Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
}

const isoUtc = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

/** `YYYY-MM-DD HH` in UTC — matches the SQL bucket expression. */
const hourKeyOf = (ms: number): string => new Date(ms).toISOString().slice(0, 13).replace('T', ' ');

/**
 * Resolve a local calendar date to its 24 hour slots and the UTC window that
 * covers them. Throws on a malformed date so the route can answer 400.
 */
export function brusselsDayWindow(date: string): GridDayWindow {
  if (!isValidDate(date)) {
    throw new RangeError(`Invalid date: ${date}`);
  }
  const [year, month, day] = date.split('-').map(Number);

  const instants: (number | null)[] = [];
  for (let hour = 0; hour < HOURS_IN_DAY; hour++) {
    instants.push(utcForWallClock(Date.UTC(year, month - 1, day, hour, 0, 0)));
  }

  const present = instants.filter((i): i is number => i !== null);
  if (present.length === 0) {
    // Not reachable for any real date; guards against a future rule change
    // turning the whole day into holes rather than returning NaN bounds.
    throw new RangeError(`No resolvable hours for ${date} in ${GRID_TIMEZONE}`);
  }

  // The high bound reaches the end of the last hour: load, price and
  // generation are published every 15 minutes, so :15/:30/:45 of the closing
  // hour must fall inside the window or that hour averages short.
  const startMs = Math.min(...present);
  const endMs = Math.max(...present) + HOUR_MS - 1000;

  return {
    date,
    timezone: GRID_TIMEZONE,
    hoursUtc: instants.map((i) => (i === null ? null : isoUtc(i))),
    hourKeys: instants.map((i) => (i === null ? null : hourKeyOf(i))),
    startUtc: isoUtc(startMs),
    endUtc: isoUtc(endMs),
  };
}
