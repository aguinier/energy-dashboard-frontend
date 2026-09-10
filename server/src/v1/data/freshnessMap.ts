import {
  classifyDayAheadStream,
  classifyMeasuredStream,
  parseStoredTimestamp,
  ENDED_AFTER_HOURS,
  type FreshnessStatus,
} from '../../services/freshness.js';
import { measuredLoadClause } from '../../services/loadQuality.js';
import { toIsoSecond } from './params.js';
import { STREAMS, type ObservationStream } from './series.js';
import type { EnergyQuery } from './energySource.js';

/**
 * The freshness block every response carries — built once for the whole fleet,
 * on a timer, and never per request.
 *
 * ABL-303's Board note asks for an explicit `as_of` on every response now, "on
 * the LAN we serve live data, any later deployment may serve something that
 * lags, and a contract that implies real-time cannot acquire lag later without
 * breaking a promise." ABL-293 §2g agrees with the *timing* and disagrees with
 * the *shape*, with measurements: **a single scalar `as_of` would itself be a
 * confidently wrong number**, because these series run on three clocks in two
 * directions.
 *
 * Measured on the replica, newest stored row per zone against the last ingest
 * pass: `energy_load` is a median **1.30 h behind**, `energy_generation` 1.05 h
 * behind — and `energy_price` is a median **20.95 h *ahead***, because a
 * day-ahead price is a publication about tomorrow. A scalar `as_of` on a price
 * would read as permanently twenty-one hours fresh and would therefore never go
 * stale no matter how long ingest was down. That is ABL-51 exactly: a
 * healthy-looking series hiding a missing tomorrow for most of a day.
 *
 * So the block is four fields, and each one is separately checkable:
 *
 * | field | means |
 * |---|---|
 * | `data_through` | newest row we hold for this zone and series. **May be in the future** for a day-ahead series — correct, not an error. |
 * | `source_checked_at` | when we last *attempted* an upstream pass for it. An attempt, not a success claim — see below. |
 * | `generated_at` | when this payload was computed. Set by the handler, not here. |
 * | `status` | `live` / `stale` / `ended` / `none`, judged by the rule that fits the family. |
 *
 * `status` is the field that lets a customer tell "this zone stopped publishing
 * in 2021" (GB, `ended`) from "we are between passes" (`live`) from "ingest has
 * missed passes" (`stale`). Without it all three render as a short array and
 * the customer attributes all three to us.
 *
 * ## `records_failed = 0`, never `status = 'completed'`
 *
 * `data_ingestion_log.status` was unusable as a success signal, and this is the
 * single most likely thing to get wrong here. Measured 2026-08-12: `'completed'`
 * on **114,982 of 114,983 rows** — the writer set `"failed" if error_message
 * else "completed"` and no caller ever passed a message, so no failure value
 * reached the table. The 2026-08-06 ENTSO-E outage (484 HTTP 503s, nothing
 * stored) is in it as five healthy-looking `completed` passes; the two that
 * stored nothing are distinguishable only by `records_failed` being 35 and 1.
 *
 * ABL-633 has since made the column honest — `resolve_ingestion_status` derives
 * `completed` / `partial_failure` / `failed` from the counts — but the predicate
 * here stays `records_failed = 0` and this module is unchanged by it. It has to
 * hold for the rows already in the table, which carry the old labels and will
 * never be relabelled; a status test would read every pre-deploy outage as
 * green. `records_failed` is the column both eras agree on, and it is the one
 * ABL-633 derives its own answer from.
 *
 * (`services/ingestFreshnessService.ts` reads the same table and counts a failed
 * pass as a check, deliberately — it answers "when did we last go and look", and
 * a pass that errored did look. This module excludes it, so `source_checked_at`
 * is in fact the last pass that failed nothing, which is narrower than the
 * "an attempt, not a success claim" wording above it. The two are not reconciled
 * here: ABL-637 changed only the internal service, and which of the two
 * `source_checked_at` should mean is a `/v1` contract decision — ABL-660.)
 *
 * ## Why `publication_timestamp_utc` is not used, under any alias
 *
 * It is named for publication time and holds *our fetch* time, and it is
 * rewritten on every re-fetch (`services/freshness.ts:47-49`), so per row it
 * dates the last pass that touched the row rather than the pass that stored it.
 * `MAX()` over it therefore only re-derives "when did a pass last run" — the
 * same fact `data_ingestion_log` states honestly. Publishing it under a name a
 * customer reads as "when this was published" would be a confidently wrong
 * number with a licence attached (ABL-293 §2g.D, CLAUDE.md:1879-1892).
 *
 * ## Why memoized rather than queried per request
 *
 * `data_ingestion_log` carries no index on `country_code`, so the per-zone
 * lookup measured 103 ms and the fleet-wide grouping 250 ms — larger than most
 * of the data queries this decorates, on a single-threaded process where one
 * slow read blocks everyone. Adding the index would be a shared-schema change,
 * which this module is not permitted to make. A 60-second refresh is two orders
 * of magnitude finer than a four-passes-per-day ingest, so the map is never
 * meaningfully behind, and the marginal cost of `freshness` on a response is a
 * map lookup.
 */

/**
 * What we know about one zone × stream, memoized.
 *
 * Slightly wider than the wire block: `data_from` is a *coverage* fact rather
 * than a freshness one, and it is here because it comes from the same fleet
 * scan and because two endpoints need it. `/v1/catalog/coverage` reports it, and
 * the observation endpoints use it to tell an empty page that fell **inside**
 * the span we hold (an upstream gap — their data is missing) from one that fell
 * **outside** it (we simply do not hold that period). Those are different
 * claims and a customer acts on them differently; collapsing both into "empty
 * array" is how an upstream hole gets attributed to us.
 */
export interface ZoneStreamState {
  /** Oldest row we hold, RFC 3339 UTC. */
  data_from: string | null;
  /** Newest row we hold, RFC 3339 UTC. May be in the future for a day-ahead series. */
  data_through: string | null;
  /** Last upstream pass *attempted* for this zone and stream. Not a success claim. */
  source_checked_at: string | null;
  status: FreshnessStatus;
}

/** The three fields of {@link ZoneStreamState} that go on the wire as `meta.freshness`. */
export interface StreamFreshness {
  data_through: string | null;
  source_checked_at: string | null;
  status: FreshnessStatus;
}

/** A zone × stream with nothing behind it. Returned rather than `undefined`, so the field is never absent. */
export const UNKNOWN_STATE: ZoneStreamState = {
  data_from: null,
  data_through: null,
  source_checked_at: null,
  status: 'none',
};

export interface FreshnessSnapshot {
  /** When this map was built. What `source_checked_at`'s recency is relative to. */
  builtAt: Date;
  /** Every zone in `countries`, sorted. The zone list `/v1/catalog/zones` reports. */
  zones: string[];
  byZoneStream: ReadonlyMap<string, ZoneStreamState>;
}

export interface FreshnessMap {
  lookup(zone: string, stream: ObservationStream): ZoneStreamState;
  snapshot(): FreshnessSnapshot;
  /** Rebuild now. Called by the timer, and directly by tests. */
  refresh(): void;
  close(): void;
}

export interface FreshnessMapOptions {
  source: EnergyQuery;
  /** `0` disables the timer, which is what tests use so refreshing is a thing they do. */
  refreshIntervalMs?: number;
  now?: () => Date;
}

const DEFAULT_REFRESH_MS = 60_000;

/**
 * How far back the ingest log is searched for a successful pass.
 *
 * Bounded so the query can use `idx_ingestion_log_pipeline` rather than scanning
 * 115k rows, and bounded at exactly {@link ENDED_AFTER_HOURS} so the two
 * statements agree: a stream whose last successful pass is older than this
 * window reports `source_checked_at: null`, and a stream whose newest row is
 * older than this window reports `ended`. One number, so a zone cannot be
 * `ended` while still claiming a recent upstream check.
 */
const INGEST_LOOKBACK_MS = ENDED_AFTER_HOURS * 3_600_000;

/**
 * How many rows off the tail of the index are read to find the newest one.
 *
 * The obvious query is `MAX(REPLACE(timestamp_utc, 'T', ' '))`, which is
 * correct and **measured at 6.7 seconds** across the fleet — a function on the
 * column forfeits the index and scans 2.6M rows. Unacceptable on a
 * single-threaded process even once a minute.
 *
 * The bare `MAX(timestamp_utc)` is an index lookup and is *wrong*: this column
 * holds two separators, `'T'`(84) sorts above `' '`(32), so a `T`-form row
 * beats a space-form row **on the same date**. Reading the tail of the index and
 * taking the maximum in JS after normalising gets both.
 *
 * 500 is sized against the failure it has to survive. Rows that sort above the
 * true newest are exactly the `T`-form rows sharing its date — at most one day,
 * which is 96 rows at the finest stored resolution (15 minutes). 500 clears that
 * five times over. In practice it is never approached: the `T`-form rows all
 * predate 2025-11-26 while live zones are current, so the first row read is
 * already the answer. Measured across 39 zones: 19–36 ms per stream.
 */
const TAIL_ROWS = 500;

/** `2026-08-12T13:00:00` or `2026-08-12 13:00:00` -> a comparable, sortable form. */
function normalise(stored: string): string {
  return stored.replace('T', ' ');
}

/** A stored timestamp in any of this database's three shapes -> RFC 3339 UTC, or null. */
export function toWireInstant(stored: string | null | undefined): string | null {
  const parsed = parseStoredTimestamp(stored);
  return parsed === null ? null : toIsoSecond(parsed);
}

interface TailRow {
  timestamp_utc: string;
}
interface PassRow {
  country_code: string | null;
  last_end: string | null;
}

export function createFreshnessMap({
  source,
  refreshIntervalMs = DEFAULT_REFRESH_MS,
  now = () => new Date(),
}: FreshnessMapOptions): FreshnessMap {
  let current: FreshnessSnapshot = build(source, now());

  const timer =
    refreshIntervalMs > 0
      ? setInterval(() => {
          try {
            current = build(source, now());
          } catch (error) {
            // A failed refresh keeps the previous map rather than emptying it.
            // A freshness block that goes `none` fleet-wide because one query
            // threw would tell every customer their zone had stopped
            // publishing — a false alarm louder than the true one it replaces.
            console.error('Freshness map refresh failed; serving the previous map:', error);
          }
        }, refreshIntervalMs)
      : null;
  timer?.unref?.();

  return {
    lookup(zone, stream) {
      return current.byZoneStream.get(`${zone}:${stream}`) ?? UNKNOWN_STATE;
    },
    snapshot() {
      return current;
    },
    refresh() {
      current = build(source, now());
    },
    close() {
      if (timer) clearInterval(timer);
    },
  };
}

function build(source: EnergyQuery, at: Date): FreshnessSnapshot {
  const zones = source
    .all<{ country_code: string }>('SELECT country_code FROM countries ORDER BY country_code')
    .map((row) => row.country_code);

  const since = new Date(at.getTime() - INGEST_LOOKBACK_MS).toISOString();
  const byZoneStream = new Map<string, ZoneStreamState>();

  for (const stream of ['load', 'price', 'generation'] as const) {
    const definition = STREAMS[stream];
    const passes = lastSuccessfulPasses(source, definition.pipelineType, since);

    for (const zone of zones) {
      const latest = edgeRow(source, stream, zone, 'DESC');
      byZoneStream.set(`${zone}:${stream}`, {
        data_from: toWireInstant(edgeRow(source, stream, zone, 'ASC')),
        data_through: toWireInstant(latest),
        source_checked_at: toWireInstant(passes.get(zone) ?? passes.get(FLEET_WIDE) ?? null),
        status: classify(stream, latest, at),
      });
    }
  }

  return { builtAt: at, zones, byZoneStream };
}

/** Project the wire block out of the memoized state. `data_from` is coverage, not freshness. */
export function freshnessBlockOf(state: ZoneStreamState): StreamFreshness {
  return {
    data_through: state.data_through,
    source_checked_at: state.source_checked_at,
    status: state.status,
  };
}

/** Key for a pass row logged without a country — one entry standing for the whole fleet. */
const FLEET_WIDE = ' fleet';

/**
 * `MAX(end_time)` per zone among passes that failed nothing.
 *
 * `records_failed = 0` rather than `status = 'completed'` — see the module note.
 * `end_time IS NOT NULL` excludes the one row still `running`; a pass that has
 * not finished has not checked anything yet.
 *
 * Rows are logged per country, but the pipeline occasionally logs one without a
 * `country_code`. Those are kept under {@link FLEET_WIDE} and used only as a
 * fallback for a zone with no row of its own, so a fleet-level pass never
 * overrides a zone-level one.
 */
function lastSuccessfulPasses(
  source: EnergyQuery,
  pipelineType: string | null,
  since: string
): Map<string, string> {
  const found = new Map<string, string>();
  if (pipelineType === null) return found;

  const rows = source.all<PassRow>(
    `SELECT country_code, MAX(end_time) AS last_end
       FROM data_ingestion_log
      WHERE pipeline_type = ?
        AND start_time >= ?
        AND end_time IS NOT NULL
        AND records_failed = 0
      GROUP BY country_code`,
    [pipelineType, since]
  );

  for (const row of rows) {
    if (row.last_end === null) continue;
    found.set(row.country_code ?? FLEET_WIDE, row.last_end);
  }
  return found;
}

/**
 * The newest (`DESC`) or oldest (`ASC`) row we hold for a zone and stream, in
 * stored form, or `null`.
 *
 * Both ends need the same trick and for symmetric reasons. Ascending, the rows
 * that sort *below* the true oldest are the space-form rows sharing its date —
 * again at most one day, again ≤96 rows at 15-minute resolution, so
 * {@link TAIL_ROWS} covers both directions with the same margin.
 */
function edgeRow(
  source: EnergyQuery,
  stream: ObservationStream,
  zone: string,
  direction: 'ASC' | 'DESC'
): string | null {
  const { table } = STREAMS[stream];

  // `LENGTH(timestamp_utc) = 19` excludes the 26,405 rows carrying a trailing
  // UTC offset, which this API does not serve — see `observationsRepo.ts`. It
  // has to be applied here too, or `data_through` would advertise a row no
  // query can return.
  //
  // The load filter is the same `> 0` rule the data query applies. Without it
  // `data_through` could name an impossible stored `0.0` — which is exactly
  // what MK and SI held as their newest row when this was measured.
  const quality = stream === 'load' ? `AND ${measuredLoadClause()}` : '';

  const rows = source.all<TailRow>(
    `SELECT timestamp_utc
       FROM ${table}
      WHERE country_code = ?
        AND LENGTH(timestamp_utc) = 19
        ${quality}
      ORDER BY timestamp_utc ${direction}
      LIMIT ${TAIL_ROWS}`,
    [zone]
  );

  if (rows.length === 0) return null;
  let edge = rows[0].timestamp_utc;
  for (const row of rows) {
    const better =
      direction === 'DESC'
        ? normalise(row.timestamp_utc) > normalise(edge)
        : normalise(row.timestamp_utc) < normalise(edge);
    if (better) edge = row.timestamp_utc;
  }
  return edge;
}

/**
 * Pick the classifier by family, never by convenience.
 *
 * `load` and `generation` are measured and judged on age; `price` is a
 * day-ahead publication and judged on *coverage of the required market day*.
 * Applying the first rule to the second is the mirror of the bug
 * `services/freshness.ts` exists for, and the comment at its line 277 says so.
 * Both classifiers are imported verbatim rather than reimplemented, so `/v1` and
 * the dashboard cannot come to different conclusions about the same zone.
 *
 * The day-ahead deadline is per document (ABL-494), and `price` is the only
 * day-ahead stream `/v1` exposes — `OBSERVATION_STREAMS` is `load | price |
 * generation` (`series.ts:69`). A second one added here must pass **its own**
 * key: A44 lands by 14:00 UTC while A69 is not due until 18:00 Brussels D-1, so
 * inheriting price's deadline would report it stale every afternoon.
 */
function classify(stream: ObservationStream, latest: string | null, at: Date): FreshnessStatus {
  return STREAMS[stream].series[0].family === 'day_ahead'
    ? classifyDayAheadStream(latest, at, 'price').status
    : classifyMeasuredStream(latest, at).status;
}

/**
 * How old our newest forecast vintage may get before something has gone wrong.
 *
 * Sized from the measured run schedule rather than picked. Over the 7 days to
 * 2026-08-11, `catboost` vintages land in exactly four UTC hour buckets — 07:00,
 * 14:00, 15:30 and 19:00 — so the longest *scheduled* gap is **19:00 → 07:00,
 * twelve hours**, and between those hours no new vintage exists at all. A
 * customer calling at 03:00 UTC is correctly served an eight-hour-old forecast;
 * that is the product, not a fault, and `generated_at` on every row is what says
 * so.
 *
 * 18h is that 12h gap plus six hours of margin for a late run. It is not a tuned
 * edge: any threshold from 13h to about 24h selects the same set, because the
 * next thing above a healthy gap is a whole missed day.
 *
 * Known limit, stated rather than papered over: a model that runs **once daily**
 * (`chronos-2-V010`, 06:00 UTC) will read `stale` for the six hours before its
 * next run even when it is perfectly healthy. That model serves `net_position`
 * only, which is deliberately not on this surface, so no series `/v1` returns is
 * affected today. A per-model cadence would be the real fix and needs a
 * measurement this issue does not have.
 */
export const FORECAST_VINTAGE_STALE_AFTER_HOURS = 18;

/**
 * Judge a forecast series by the age of its newest vintage.
 *
 * Deliberately not `classifyMeasuredStream` on the target timestamps: a healthy
 * forecast is dated up to 64 hours in the **future**, so target age is
 * meaningless in the same way a day-ahead price's is. It is also not
 * `classifyDayAheadStream`, whose question — does this reach tomorrow's market
 * day — is about an auction we do not run.
 */
export function classifyForecastVintage(
  newestVintage: string | null,
  at: Date
): FreshnessStatus {
  const parsed = parseStoredTimestamp(newestVintage);
  if (parsed === null) return 'none';

  const ageHours = (at.getTime() - parsed.getTime()) / 3_600_000;
  if (ageHours > ENDED_AFTER_HOURS) return 'ended';
  return ageHours > FORECAST_VINTAGE_STALE_AFTER_HOURS ? 'stale' : 'live';
}
