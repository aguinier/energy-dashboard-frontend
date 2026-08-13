/**
 * The **public** forecast catalogue — deliberately narrower than the internal
 * registry, and deliberately not derived from it.
 *
 * `config/forecastModels.ts` is the dashboard's registry. It is not the right
 * source for a paid API, for three independent reasons, and importing it would
 * inherit all three:
 *
 * 1. **It advertises models with no rows.** `catboost-retrain-v1` and
 *    `xgboost-retrain-v1` are registered shadow candidates and neither appears
 *    in `forecasts` at all (ABL-293 §2a). A public catalogue filtered by
 *    registry membership rather than by measured coverage advertises models that
 *    return nothing, which is the one thing a catalogue exists to prevent.
 * 2. **It includes `net_position`.** That is excluded from `/v1` by Board
 *    decision 2, and a catalogue built from the registry would need a subtraction
 *    somebody has to remember. Absence by construction beats absence by filter —
 *    the same argument ABL-304 makes for the app itself.
 * 3. **It includes the TSO series.** ABL-293's recommendation, which the Board
 *    has: *"Demote the TSO forecasts from product to context. They are the TSOs'
 *    own forecasts, free from ENTSO-E. Sell our accuracy against them; do not
 *    sell them."* Nothing here serves `tso-d1`/`tso-d7`.
 *
 * There is a fourth, structural reason: `config/` is unreachable from the public
 * import graph and `publicAppGraph.test.ts` enforces it, because
 * `config/database.ts` and `config/writeDatabase.ts` are the two handles on the
 * shared energy database. Keeping a public list here means that control does not
 * have to be weakened to publish a catalogue.
 *
 * The lists below are the *offer*; what is actually servable is measured at
 * request time against `forecasts` and reported by `/v1/catalog/models`.
 */

/**
 * Forecast types this API will serve, and how confident the offer is.
 *
 * `stable` and `beta` come straight from ABL-293's measured coverage: `load` and
 * `price` carry a production-model forecast for **24 zones each**, while
 * `wind_onshore` and `solar` reach **4**, `renewable` 4, and `wind_offshore`,
 * `hydro_total` and `biomass` **2**. Selling a nine-type catalogue where seven
 * types cover two to four zones is how a subscriber ends up in a refund
 * conversation about a plan that is empty for their market — so the thin ones
 * are offered, labelled, and their per-zone coverage is published rather than
 * hidden behind a type list.
 *
 * `net_position` is absent and stays absent: Board decision 2 is open. The JAO
 * authorisation question is resolved (ABL-298 closed, authorisation held) and
 * that is **not** a reason to add it — flagged here because the legal blocker
 * lifting is exactly what would tempt someone to.
 */
export type ForecastStability = 'stable' | 'beta';

export interface PublicForecastType {
  id: string;
  stability: ForecastStability;
  /** The unit of `value` for this type. Also derivable from `series.ts`; stated for the catalogue. */
  unit: string;
}

export const PUBLIC_FORECAST_TYPES: readonly PublicForecastType[] = [
  { id: 'load', stability: 'stable', unit: 'MW' },
  { id: 'price', stability: 'stable', unit: 'EUR/MWh' },
  { id: 'solar', stability: 'beta', unit: 'MW' },
  { id: 'wind_onshore', stability: 'beta', unit: 'MW' },
  { id: 'wind_offshore', stability: 'beta', unit: 'MW' },
  { id: 'renewable', stability: 'beta', unit: 'MW' },
  { id: 'biomass', stability: 'beta', unit: 'MW' },
  { id: 'hydro_total', stability: 'beta', unit: 'MW' },
];

export const PUBLIC_FORECAST_TYPE_IDS: readonly string[] = PUBLIC_FORECAST_TYPES.map((t) => t.id);

/**
 * Models this API serves, in preference order.
 *
 * Two, and they are the two that write rows: `catboost` (1,564,920 rows) and
 * `xgboost` (561,623). Everything else in the table is either stale — the last
 * `lightgbm`, `chronos-bolt-small`, `tso_raw` and `tso_corrected` rows are from
 * Feb–Mar 2026 — or a net-position model, or a shadow candidate.
 *
 * **Preference is ordered, not absolute**, and that is measured rather than
 * stylistic: catboost and xgboost cover *disjoint* zone sets. `load` is xgboost
 * for AT/BE/FR and catboost for the other 21; `price` has no catboost for
 * BE/DE/ES/FR/PT. Pinning one model would not harmonise those zones, it would
 * blank them. So a request without `?model=` resolves to the first model that
 * actually has rows for the zone, type and window asked for — and the model that
 * served is echoed in `meta.model` and on every row, so a fallback is visible
 * rather than passed off as the preferred model.
 *
 * An **explicit** `?model=` is honoured strictly: if you asked for xgboost and
 * it has nothing, you get an empty page with a coverage reason, never catboost's
 * numbers under xgboost's name.
 */
export const PUBLIC_FORECAST_MODELS: readonly string[] = ['catboost', 'xgboost'];

/**
 * The longest horizon this data actually reaches, in hours.
 *
 * `MAX(horizon_hours)` across every model is 64 — catboost 2–63, xgboost 2–64
 * (ABL-293 §2a). **There is no D+3**, and per this repository's standing rule we
 * do not manufacture one. Published so that a plan sold on "week-ahead
 * forecasting" is visibly selling something we do not have; the only week-ahead
 * number in the database is the TSO's, which is not ours and is not on this
 * surface.
 */
export const MAX_HORIZON_HOURS = 64;
