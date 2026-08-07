import db from '../config/database.js';
import { measuredLoadClause } from './loadQuality.js';
import {
  classifyMeasuredStream,
  classifyDayAheadStream,
  type FreshnessStream,
} from './freshness.js';

/**
 * The five streams the dashboard depends on, each with a verdict on whether it
 * is current. See `freshness.ts` for the two rules and how they were sized.
 */
export interface DataFreshness {
  load: FreshnessStream;
  price: FreshnessStream;
  generation: FreshnessStream;
  tsoLoadForecast: FreshnessStream;
  tsoGenerationForecast: FreshnessStream;
}

function newest(sql: string, countryCode: string): string | null {
  const row = db.prepare(sql).get(countryCode) as { latest: string | null } | undefined;
  return row?.latest ?? null;
}

export function getDataFreshness(countryCode: string, now: Date = new Date()): DataFreshness {
  // `measuredLoadClause()` matters here as much as it does on a chart, and this
  // was the one `energy_load` read site without it. A national grid never draws
  // 0 MW, so those rows are placeholders (ABL-35) — and this endpoint was
  // dating the pipeline's health from one. Measured on the replica 2026-08-07:
  // SI's raw MAX is `2026-08-07 00:15` with `load_mw = 0`, against a guarded
  // MAX of `00:00`. Small in hours, wrong in kind: freshness computed from a
  // row every other query in the codebase refuses to serve.
  const load = newest(
    `SELECT MAX(timestamp_utc) as latest FROM energy_load
      WHERE country_code = ? AND ${measuredLoadClause()}`,
    countryCode,
  );

  const price = newest(
    `SELECT MAX(timestamp_utc) as latest FROM energy_price WHERE country_code = ?`,
    countryCode,
  );

  // `energy_generation`, not the frozen `energy_renewable` this used to read.
  // Both are written from one A75 fetch per country per window, so they cannot
  // disagree about when we last stored something — verified on the replica
  // 2026-08-07, MAX(timestamp_utc) identical for all 34 countries — which makes
  // this a free correction rather than a behaviour change. It is worth making
  // anyway: `GenerationTab` has drawn `energy_generation` since ABL-44, and a
  // freshness signal should describe the table the user is looking at, not the
  // frozen one beside it.
  const generation = newest(
    `SELECT MAX(timestamp_utc) as latest FROM energy_generation WHERE country_code = ?`,
    countryCode,
  );

  const tsoLoadForecast = newest(
    `SELECT MAX(target_timestamp_utc) as latest FROM energy_load_forecast WHERE country_code = ?`,
    countryCode,
  );

  const tsoGenerationForecast = newest(
    `SELECT MAX(target_timestamp_utc) as latest FROM energy_generation_forecast WHERE country_code = ?`,
    countryCode,
  );

  return {
    load: classifyMeasuredStream(load, now),
    generation: classifyMeasuredStream(generation, now),
    // Day-ahead publications are legitimately dated in the future, so they are
    // judged on coverage. Judging them on age would report a healthy price as
    // impossibly fresh and never notice a missing tomorrow — ABL-51.
    price: classifyDayAheadStream(price, now),
    tsoLoadForecast: classifyDayAheadStream(tsoLoadForecast, now),
    tsoGenerationForecast: classifyDayAheadStream(tsoGenerationForecast, now),
  };
}
