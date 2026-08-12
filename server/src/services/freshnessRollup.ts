import type { DataFreshness } from './dataFreshnessService.js';
import type { FreshnessStatus } from '../types/index.js';

const STREAM_KEYS = [
  'load',
  'price',
  'generation',
  'tsoLoadForecast',
  'tsoGenerationForecast',
] as const satisfies readonly (keyof DataFreshness)[];

/**
 * How severe each verdict is, for picking one fleet-wide "worst" status out of
 * many (country, stream) pairs.
 *
 * `stale` is the only one of the four that names an active, actionable
 * problem — `services/freshness.ts` documents `ended` as "a terminal,
 * non-alarm verdict" and `none` as "deliberately not a health verdict", so
 * neither should ever outrank a real `stale`. `live` ranks above both of
 * those non-alarms too: a fleet that is all `ended`/`none` is not evidence of
 * a working pipeline the way even one `live` stream is.
 */
const SEVERITY: Record<FreshnessStatus, number> = {
  stale: 3,
  live: 2,
  ended: 1,
  none: 0,
};

export interface FreshnessRollup {
  /** The single worst verdict across every stream of every country checked. */
  status: FreshnessStatus;
  countriesChecked: number;
  streamsChecked: number;
  /** How many (country, stream) pairs landed in each verdict. */
  counts: Record<FreshnessStatus, number>;
  /** Country codes with at least one `stale` stream, sorted — the actionable list. */
  staleCountries: string[];
}

/**
 * Fleet-wide worst-case rollup over the same per-country verdicts
 * `GET /api/data-freshness/:cc` already computes (`dataFreshnessService.ts`) —
 * this reuses that classification rather than re-deriving the staleness rules
 * (ABL-237).
 *
 * Pure and independent of the database, so it can be tested against a
 * synthetic fleet — including the empty-fleet case — without a clock or a
 * connection.
 */
export function computeFreshnessRollup(
  byCountry: Record<string, DataFreshness>,
): FreshnessRollup {
  const counts: Record<FreshnessStatus, number> = { live: 0, stale: 0, ended: 0, none: 0 };
  const staleCountries: string[] = [];
  let status: FreshnessStatus = 'none';
  let streamsChecked = 0;

  for (const [countryCode, freshness] of Object.entries(byCountry)) {
    let countryHasStale = false;
    for (const key of STREAM_KEYS) {
      const streamStatus = freshness[key].status;
      streamsChecked += 1;
      counts[streamStatus] += 1;
      if (streamStatus === 'stale') countryHasStale = true;
      if (SEVERITY[streamStatus] > SEVERITY[status]) status = streamStatus;
    }
    if (countryHasStale) staleCountries.push(countryCode);
  }

  return {
    status,
    countriesChecked: Object.keys(byCountry).length,
    streamsChecked,
    counts,
    staleCountries: staleCountries.sort(),
  };
}
