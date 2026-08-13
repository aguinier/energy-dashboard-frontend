import { rangeArgs, rangeClause, timestampRange } from '../../utils/timestamp.js';
import { measuredLoadClause } from '../../services/loadQuality.js';
import { isoDuration } from './envelope.js';
import { PUBLIC_FORECAST_MODELS, PUBLIC_FORECAST_TYPES } from './models.js';
import { STREAMS, type ObservationStream } from './series.js';
import type { EnergyQuery } from './energySource.js';
import type { TimeWindow } from './params.js';

/**
 * The catalogue: what we hold, per zone and per model.
 *
 * ABL-293 §2a is emphatic that this is core rather than convenience:
 * *"`/v1/catalog/coverage` is not optional. It is the endpoint that stops a
 * customer inferring 'Albania had no load' from an empty array when the truth is
 * 'Albania stopped publishing upstream on 2026-08-06 21:45'. Absence must be
 * narrated, and a public API cannot narrate it inside a data response without
 * inventing rows."*
 *
 * Country counts alone would not do it. `energy_load` covers 36 zones — but GB
 * stops at 2021-06-14 and UA at 2022-02-25 (CLAUDE.md:1959-1960), and MK has
 * rows on 30 of 46 dates including a seven-day hole. A zone list would present
 * all of those as coverage. A span plus a status plus enumerated gaps is what a
 * customer can actually plan against.
 */

/**
 * A cache with an expiry, for the two catalogue reads that scan an index.
 *
 * Lazy rather than built at startup, and on a much longer interval than the
 * freshness map: the model catalogue changes when a model starts or stops
 * writing rows, which is a deployment, not a minute-scale event. A process that
 * never serves `/v1/catalog/models` never pays the 296 ms.
 */
function memoize<T>(ttlMs: number, compute: () => T, now: () => Date): () => T {
  let cached: { at: number; value: T } | null = null;
  return () => {
    const t = now().getTime();
    if (cached === null || t - cached.at >= ttlMs) {
      cached = { at: t, value: compute() };
    }
    return cached.value;
  };
}

const MODEL_CATALOGUE_TTL_MS = 10 * 60_000;

export interface ModelCoverage {
  forecast_type: string;
  stability: string;
  unit: string;
  model: string;
  /** Zones with at least one row for this type and model, sorted. */
  zones: string[];
}

export interface CatalogRepo {
  modelCoverage(): ModelCoverage[];
  /**
   * Compute the catalogue now, before anyone asks for it.
   *
   * Called by `publicIndex.ts` before `listen`. The first build is the one that
   * pays for a cold page cache, and paying it on a customer's request means one
   * caller absorbs it while the single-threaded process is blocked for everyone
   * — measured at **3.4 s** against the 9.4 GB replica before the probe rewrite
   * below, which is a stall nobody should be billed for.
   */
  warm(): void;
}

export interface CatalogRepoOptions {
  source: EnergyQuery;
  now?: () => Date;
  ttlMs?: number;
}

export function createCatalogRepo({
  source,
  now = () => new Date(),
  ttlMs = MODEL_CATALOGUE_TTL_MS,
}: CatalogRepoOptions): CatalogRepo {
  const modelCoverage = memoize(ttlMs, () => readModelCoverage(source), now);
  return {
    modelCoverage,
    warm: () => {
      modelCoverage();
    },
  };
}

/**
 * Which (type, model, zone) triples actually have rows.
 *
 * ## Why this is 600 point lookups rather than one `GROUP BY`
 *
 * The obvious query is `SELECT country_code, forecast_type, model_name FROM
 * forecasts WHERE model_name IN (…) GROUP BY 1,2,3`, and it is correct. It is
 * also a full scan of a 2.1M-row index, which measured **296 ms warm and 3.4 s
 * cold** against the 9.4 GB replica — a multi-second block of a single-threaded
 * process, landing on whichever customer's request happened to be first after a
 * restart. (Writing the same grouping with `MIN`/`MAX` over
 * `REPLACE(target_timestamp_utc, …)` is worse again at 10.3 s, because a
 * function on the column forfeits the index entirely. That version is what this
 * started as, and the smoke run against real data is what caught it.)
 *
 * The question does not need a scan. We offer 8 types and 2 models over ~39
 * zones, so "does this triple have any rows" is at most ~600 `LIMIT 1` probes
 * against `idx_forecasts_model_lookup`, whose leading columns are exactly
 * `(country_code, forecast_type, model_name)`. Each is a seek that stops at the
 * first match.
 *
 * It also narrows what is read: a `GROUP BY` over the whole table touches the
 * ~385k `net_position` rows on its way past, and this does not look at them at
 * all, because `net_position` is not in {@link PUBLIC_FORECAST_TYPES}. Driving
 * the loop from the *offer* rather than from the data is what keeps a type we do
 * not sell out of the catalogue by construction.
 *
 * This is the "coverage, not registry" rule from ABL-293 §2a made mechanical: a
 * model with no rows fails its probe, so `catboost-retrain-v1` and
 * `xgboost-retrain-v1` are absent without anyone having to remember to exclude
 * them.
 */
function readModelCoverage(source: EnergyQuery): ModelCoverage[] {
  const zones = source
    .all<{ country_code: string }>('SELECT country_code FROM countries ORDER BY country_code')
    .map((row) => row.country_code);

  const catalogue: ModelCoverage[] = [];
  for (const type of PUBLIC_FORECAST_TYPES) {
    for (const model of PUBLIC_FORECAST_MODELS) {
      const covered = zones.filter(
        (zone) =>
          source.get<{ one: number }>(
            `SELECT 1 AS one
               FROM forecasts
              WHERE country_code = ? AND forecast_type = ? AND model_name = ?
              LIMIT 1`,
            [zone, type.id, model]
          ) !== undefined
      );
      // A type we offer but for which this model has written nothing is omitted
      // rather than listed with an empty zone array: an entry with no zones is
      // an offer with nothing behind it.
      if (covered.length === 0) continue;
      catalogue.push({
        forecast_type: type.id,
        stability: type.stability,
        unit: type.unit,
        model,
        zones: covered,
      });
    }
  }
  return catalogue;
}

export interface CoverageGap {
  /** First missing interval, inclusive. */
  from: string;
  /** First present interval after the gap, exclusive. */
  to: string;
  /** How many intervals of the observed resolution are missing. */
  missing_intervals: number;
}

export interface WindowCoverage {
  row_count: number;
  resolution: string | null;
  gaps: CoverageGap[];
  /** Whether {@link CoverageGap} enumeration was cut short. */
  gaps_truncated: boolean;
  /** Rows excluded from this window for carrying a non-UTC stored timestamp. */
  excluded_row_count: number;
}

/**
 * The most gaps one response will enumerate.
 *
 * A gap list is unbounded in principle — a zone that publishes one day in ten
 * over a year has hundreds — and an unbounded array is the same commercial
 * defect as an unbounded row set. Truncation is *reported* rather than silent,
 * because a client that stopped reading at 500 gaps and assumed the rest was
 * covered would have drawn precisely the wrong conclusion.
 */
export const MAX_GAPS = 500;

/**
 * Coverage of one zone and stream inside a window: how many rows, at what
 * spacing, and exactly where the holes are.
 *
 * Gaps are computed from the returned timestamps rather than from an assumed
 * cadence, because the cadence is not ours to assume: the same stream is
 * 15-minute for DE/FR/NL and hourly elsewhere, and a zone can change resolution
 * upstream. The modal spacing observed in the window is the unit, and anything
 * wider than it is a hole.
 *
 * **Nothing is interpolated to fill one.** No forward-fill, no carry-forward.
 * That habit is how 216 fabricated `net_position` rows reached this database
 * (ABL-181/ABL-67), and a public API doing it would be selling them.
 */
export function readWindowCoverage(
  source: EnergyQuery,
  stream: ObservationStream,
  zone: string,
  window: TimeWindow
): WindowCoverage {
  const { table } = STREAMS[stream];
  const range = timestampRange(window.sqlStart, window.sqlEndInclusive);
  const quality = stream === 'load' ? `AND ${measuredLoadClause()}` : '';

  const rows = source.all<{ ts: string }>(
    `SELECT REPLACE(timestamp_utc, 'T', ' ') AS ts
       FROM ${table}
      WHERE country_code = ?
        AND LENGTH(timestamp_utc) = 19
        AND ${rangeClause('timestamp_utc')}
        ${quality}
      ORDER BY REPLACE(timestamp_utc, 'T', ' ')`,
    [zone, ...rangeArgs(range)]
  );

  // Counted, not merely excluded: the response says how many rows this window
  // holds that we decline to serve, so a customer reconciling against ENTSO-E's
  // own counts finds the discrepancy explained rather than unexplained.
  const excluded = source.get<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM ${table}
      WHERE country_code = ?
        AND LENGTH(timestamp_utc) <> 19
        AND ${rangeClause('timestamp_utc')}`,
    [zone, ...rangeArgs(range)]
  );

  const stamps = rows.map((row) => Date.parse(`${row.ts.replace(' ', 'T')}Z`));
  const { resolutionMs, gaps, truncated } = findGaps(stamps);

  return {
    row_count: rows.length,
    resolution: resolutionMs === null ? null : isoDuration(resolutionMs),
    gaps,
    gaps_truncated: truncated,
    excluded_row_count: excluded?.n ?? 0,
  };
}

function findGaps(stamps: number[]): {
  resolutionMs: number | null;
  gaps: CoverageGap[];
  truncated: boolean;
} {
  if (stamps.length < 2) return { resolutionMs: null, gaps: [], truncated: false };

  const counts = new Map<number, number>();
  for (let i = 1; i < stamps.length; i += 1) {
    const gap = stamps[i] - stamps[i - 1];
    counts.set(gap, (counts.get(gap) ?? 0) + 1);
  }

  let modal = stamps[1] - stamps[0];
  let best = 0;
  for (const [gap, count] of counts) {
    if (count > best || (count === best && gap < modal)) {
      modal = gap;
      best = count;
    }
  }
  if (modal <= 0) return { resolutionMs: null, gaps: [], truncated: false };

  const gaps: CoverageGap[] = [];
  let truncated = false;
  for (let i = 1; i < stamps.length; i += 1) {
    const delta = stamps[i] - stamps[i - 1];
    if (delta <= modal) continue;
    if (gaps.length >= MAX_GAPS) {
      truncated = true;
      break;
    }
    gaps.push({
      from: new Date(stamps[i - 1] + modal).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      to: new Date(stamps[i]).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      missing_intervals: Math.round(delta / modal) - 1,
    });
  }

  return { resolutionMs: modal, gaps, truncated };
}
