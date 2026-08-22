import { PUBLIC_FORECAST_MODELS, PUBLIC_FORECAST_TYPE_IDS } from '../data/models.js';
import type { EnergyQuery, SqlParam } from '../data/energySource.js';
import type { ObservedVersion } from './versionGuard.js';

/**
 * What the database would serve, measured — the other half of the trigger.
 *
 * `acknowledgements.ts` is what a human signed. This is what is actually there.
 * ABL-529 requires the ledger be *"derived from the same rows `forecastsRepo`
 * would return, so it cannot drift from what is actually served"*, and the way
 * that requirement is met is worth being exact about, because there is a
 * plausible wrong answer.
 *
 * ## "Currently serving" is the newest vintage, per triple
 *
 * `readForecasts` takes `MAX(generated_at)` per target timestamp within one
 * `(zone, forecast_type, model)` triple, and `readLatestVintage` takes the
 * newest run whole. Both therefore serve the newest run's artifact at the
 * leading edge of any window that reaches the present. So the served artifact
 * for a triple is the `model_version` on its newest `generated_at`, which is
 * what this query reads.
 *
 * Measured on the replica 2026-08-22: every one of the 74 public triples carries
 * **exactly one** `model_version` at its newest vintage, so "the version being
 * served" is a single well-defined value rather than a choice this module had to
 * make. The query still groups by version rather than assuming that — a run that
 * did mix two artifacts would show up as two rows and be reported, not averaged
 * away.
 *
 * ## It reads unfiltered, on purpose
 *
 * This is the detector, so it must see what the gate is hiding. A ledger built
 * from the rows the gate already permits could never contain the version it
 * exists to catch, and would report "all clear" for as long as the guard kept
 * withholding.
 *
 * ## The query shape, and the one that does not work
 *
 * The obvious form — a correlated `generated_at = (SELECT MAX(...) WHERE
 * country_code = f.country_code AND ...)` — **timed out past 120 s** against the
 * 9.4 GB replica, because `idx_forecasts_model_lookup` is
 * `(country_code, forecast_type, model_name, target_timestamp_utc)` and carries
 * no `generated_at`, so the subquery re-derives a max per row. The CTE below
 * computes the 74 maxima in one index scan and then seeks each triple once:
 * **2.9 s**, plan `SCAN forecasts USING INDEX idx_forecasts_model_lookup` then
 * `SEARCH f USING INDEX idx_forecasts_model_lookup`. That is a CLI-and-startup
 * cost, comparable to `catalog.warm()`, and it is why this is not called per
 * request — the serving path needs no measurement at all, only the static
 * acknowledged set.
 */

export function readServedVersionLedger(source: EnergyQuery): ObservedVersion[] {
  const typePlaceholders = PUBLIC_FORECAST_TYPE_IDS.map(() => '?').join(', ');
  const modelPlaceholders = PUBLIC_FORECAST_MODELS.map(() => '?').join(', ');
  const scope: SqlParam[] = [...PUBLIC_FORECAST_MODELS, ...PUBLIC_FORECAST_TYPE_IDS];

  const rows = source.all<{
    zone: string;
    forecast_type: string;
    model: string;
    model_version: string | null;
    newest_vintage_at: string | null;
  }>(
    `WITH newest AS (
        SELECT country_code, forecast_type, model_name, MAX(generated_at) AS g
          FROM forecasts
         WHERE model_name IN (${modelPlaceholders})
           AND forecast_type IN (${typePlaceholders})
         GROUP BY country_code, forecast_type, model_name
      )
      SELECT f.country_code   AS zone,
             f.forecast_type  AS forecast_type,
             f.model_name     AS model,
             f.model_version  AS model_version,
             n.g              AS newest_vintage_at
        FROM newest n
        JOIN forecasts f
          ON f.country_code  = n.country_code
         AND f.forecast_type = n.forecast_type
         AND f.model_name    = n.model_name
         AND f.generated_at  = n.g
       GROUP BY f.country_code, f.forecast_type, f.model_name, f.model_version
       ORDER BY f.country_code, f.forecast_type, f.model_name, f.model_version`,
    scope
  );

  return rows.map((row) => ({
    zone: row.zone,
    forecast_type: row.forecast_type,
    model: row.model,
    model_version: row.model_version,
    newest_vintage_at: row.newest_vintage_at,
  }));
}
