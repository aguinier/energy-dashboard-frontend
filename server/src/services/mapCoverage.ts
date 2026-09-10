import type { MapDataPoint } from '../types/index.js';
import { toIsoUtc, type TimestampRange } from '../utils/timestamp.js';
import { parseStoredTimestamp } from './freshness.js';

/**
 * How far behind a window's END a country's newest row may sit before its
 * window average stops describing the window (ABL-719).
 *
 * THE DEFECT THIS SIZES AGAINST
 *
 * Every `/dashboard/map` metric is `AVG(...) WHERE <window> GROUP BY country`.
 * The window bound is applied correctly, so every averaged row genuinely is
 * inside the window — but nothing checked that the country's series *reaches*
 * the window's end. A country that stopped publishing mid-window was therefore
 * painted with the average of whatever fragment happened to exist, on the same
 * colour scale as its fully-covered neighbours. Measured on prod 2026-09-10:
 *
 * | metric           | window | country | painted value | newest row       |
 * |------------------|--------|---------|--------------:|------------------|
 * | `load`           | 30d    | IE      |       3849 MW | 2026-08-30 22:30 |
 * | `renewable_pct`  | 30d    | IE      |        32.45% | 2026-08-30 22:30 |
 * | `net_position`   | 7d     | PT      |      -2702 MW | 2026-09-04 21:00 |
 * | `net_position`   | 30d    | PT      |      -2255 MW | 2026-09-04 21:00 |
 *
 * The two PT rows are the proof: -2702 and -2255 are the same dead series over
 * two denominators. An average that moves when you widen a window it does not
 * reach is not a window average.
 *
 * WHY 48h IS A VERDICT AND NOT A TUNING KNOB
 *
 * Measured in one pass on prod 2026-09-10, hours between each country's newest
 * in-window row and the fleet's frontier for that metric, 30d window:
 *
 * | metric           | stopped                | gap  | slowest healthy       |
 * |------------------|------------------------|-----:|-----------------------|
 * | `load`           | IE 247.8h, MK 105.2h   |  92h | LV 13.2h, BG 10.2h    |
 * | `renewable_pct`  | IE 246.5h              | 214h | AL 32.0h, BG 28.0h    |
 * | `net_position`   | PT 130.0h              | 130h | every other zone 0.0h |
 * | `price`          | none                   |    — | max 0.2h of 30        |
 *
 * Every metric is bimodal with a wide empty band, and **any cutoff between 33h
 * and 105h selects the identical set on all four** — exactly {IE, MK, PT}, the
 * three streams that have stopped. 48h sits inside that band and also has a
 * reading that does not depend on the gap: every stream on this map publishes
 * at least daily, so a country silent for two full publication days has
 * stopped, not lagged. It clears AL's ordinary 32h and LV's 13.2h, whose 30-day
 * averages are ~96-99% covered and are real information.
 *
 * WHY NOT `freshness.MEASURED_STALE_AFTER_HOURS` (18h)
 *
 * It answers a different question. The header pill asks "is this stream
 * current"; the map asks "does this average describe this window". At 18h the
 * 30d load map would withhold LV, BG, ME, DK, CH and CZ, whose averages are
 * complete to within a few hours. Two questions, two cutoffs, each stated once.
 */
export const MAP_WINDOW_COVERAGE_HOURS = 48;

/**
 * Whether `latest` is close enough to `windowEnd` for a window average over
 * that country to mean anything.
 *
 * **Judged against the window's end, never against `now`.** They coincide for a
 * window ending now, but `timeOffset` shifts the window into the past in ~10
 * query keys, and a historical window measured against `now` would withhold
 * every country on the map.
 *
 * Unparseable in either argument returns `false` — withheld. Withholding is the
 * recoverable failure here (a hatched country reads as "we do not know"); the
 * unrecoverable one is painting a number that is not what the legend claims.
 *
 * Note the cutoff is measured from the window's end, while the survey above
 * measured each country from the *fleet frontier*. On prod they coincide — the
 * frontier trailed `now` by 0.2-4.2h across all four metrics on 2026-09-10 —
 * but on a source that lags as a whole this reads stricter: on the CAT replica
 * the same morning the `renewable_pct` frontier sat 18.6h back, putting AL at
 * 61h from the window end against prod's 37h, and AL was withheld there and
 * kept here. That is correct rather than a bug (AL's average on that copy
 * really was missing its last 61 hours), but it is why a country hatched on
 * acceptance and coloured on prod is replica lag, not a code difference.
 */
export function reachesWindow(
  latest: string | null | undefined,
  windowEnd: string,
  cutoffHours: number = MAP_WINDOW_COVERAGE_HOURS
): boolean {
  const newest = parseStoredTimestamp(latest);
  const end = parseStoredTimestamp(windowEnd);
  if (!newest || !end) return false;

  const gapHours = (end.getTime() - newest.getTime()) / (60 * 60 * 1000);
  return gapHours <= cutoffHours;
}

/**
 * Apply the rule to one metric's rows.
 *
 * A country that fails it keeps its row and loses its number: `value` becomes
 * `null` and `coverage` becomes `'ended'`. It is deliberately not dropped —
 * dropping it hatches the country (the client already filters `value == null`)
 * but throws away the only thing that could tell a reader *why*, leaving the
 * same blank shape as a country we never held. The row carries its own last
 * published instant, so the hover card can say which it is.
 *
 * Also stamps `timestamp` as an unambiguous ISO-8601 UTC instant. The column is
 * UTC and comes in two separator forms, neither of which a browser parses as
 * UTC unaided (`toIsoUtc`); this field was never rendered before, so the map
 * never had to care, and it does now.
 */
export function applyWindowCoverage(
  rows: MapDataPoint[],
  range: TimestampRange,
  cutoffHours: number = MAP_WINDOW_COVERAGE_HOURS
): MapDataPoint[] {
  return rows.map((row) => {
    const timestamp = toIsoUtc(row.timestamp);
    return reachesWindow(row.timestamp, range.end, cutoffHours)
      ? { ...row, timestamp }
      : { ...row, timestamp, value: null, coverage: 'ended' as const };
  });
}
