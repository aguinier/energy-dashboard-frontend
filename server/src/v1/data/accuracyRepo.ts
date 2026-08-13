import { rangeArgs, rangeClause, timestampFormOnClause, timestampRange } from '../../utils/timestamp.js';
import { loadActualGuard } from '../../services/loadQuality.js';
import { STREAMS, type ObservationStream } from './series.js';
import type { AccuracyPoint } from './accuracyMetrics.js';
import type { EnergyQuery, SqlParam } from './energySource.js';
import type { TimeWindow } from './params.js';

/**
 * Pairing our forecasts with the actuals they were forecasting.
 *
 * This is the only join on `/v1`, and it is the reason this endpoint was split
 * out of ABL-303 rather than shipped with the other eight. Three decisions carry
 * it, and each one is a defect this repository has already measured.
 *
 * ## 1. Two LEFT JOINs and a COALESCE — never one join matching either form
 *
 * This database stores two date/time separators in one column, and the naive
 * repair is worse than the defect it repairs. Matching
 * `actual_col IN (REPLACE(expr,'T',' '), REPLACE(expr,' ','T'))` looks like the
 * natural extension of `rangeClause`'s two-clause shape to an equality. It
 * silently fans out: `energy_load` alone holds **137,113** country-hours where a
 * 'T'-form row and a space-form row both exist, and **107,047** of those pairs
 * hold *conflicting* values (measured 2026-08-11). An `IN(...)` join matches
 * both, so on a conflicting pair it hands this metric the right-looking value
 * and the wrong one **as two independent observations** — trading ABL-214's
 * silent-drop defect for a silent-fan-out one, which is worse, and doing it
 * inside the one endpoint whose entire output is a summary statistic.
 *
 * So the actuals side is two separate `LEFT JOIN`s on two aliases, one per
 * stored form, `COALESCE`d together **preferring space** — the shape
 * `timestampFormOnClause` (`utils/timestamp.ts`) exists for and the one
 * `mlForecastService.resolvedActualJoin` already uses. Each side matches at most
 * one physical row (verified 2026-08-11: zero exact `(country_code,
 * timestamp_utc)` duplicates in `energy_load`, `energy_price` or
 * `energy_renewable`), so their combination is at most one row and cannot fan
 * out at all. `actualCol` stays bare on both, so each join still seeks its index;
 * wrapping it in `REPLACE` instead did not complete in 120s on a 3.0M x 811k
 * join.
 *
 * ## 2. The COALESCE order is a stated convention, not a resolution of ABL-215
 *
 * Which member of a conflicting pair is authoritative is **ABL-215, an open
 * Board question**, and this endpoint does not get to answer it. What it does is
 * declare which one it serves and publish the declaration: `space_preferred`
 * appears on every response as `meta.conflict_convention`, so the choice is a
 * term of the contract rather than an accident of a `COALESCE` argument order.
 *
 * That framing is what makes the open question survivable. If ABL-215 later
 * rules the other way, the number this endpoint returns changes — and it changes
 * as a **documented change to a stated convention**, which a subscriber can
 * reconcile, rather than as a silent correction they discover by finding last
 * quarter's figures no longer reproduce.
 *
 * The convention is also, today, mostly moot for `energy_load` and that is worth
 * knowing rather than assuming: ABL-215/227 ruled per country and ABL-255/257
 * executed it, so of `energy_load`'s conflicts only **CH (1,783) and 69 residual
 * PL rows** remain (ABL-258). `energy_price`'s 16,896 overlapping pairs (2
 * conflicting) were never in ABL-215's scope and are untouched. So the tie-break
 * is live, it is small, and it is confined to two zones and one stream — none of
 * which is a reason to simplify the join, because the shape is what keeps it
 * small.
 *
 * ## 3. The actuals are exactly what `/v1/observations` publishes
 *
 * `mlForecastService.ACTUAL_DATA_MAPPING` is **deliberately not reused**, and
 * this is the largest correctness decision in the file. It reads the frozen
 * `energy_renewable` table, which carries `DEFAULT 0` on every `*_mw` column and
 * therefore *cannot express "not reported"* — it stores a type a country does
 * not report as a literal `0.0`. ABL-353 measured what that does to an accuracy
 * endpoint: **477,846 forecast/actual pairs existed only because of that
 * default**, 99.998% of them with the frozen table holding exactly `0.0`, and
 * for 23 countries that report no offshore wind at all *100% of their pairs
 * were*. A `0.0` fabricated actual against the `0.0` forecast ENTSO-E publishes
 * scores zero error at every point, so `/tso-forecast/accuracy/generation/:cc`
 * reported `mae: 0, rmse: 0` over thousands of points — a flawless offshore-wind
 * forecast for a landlocked country, top of any ranking sorted by error.
 * Rebuilding that on a paid surface is not a possibility worth entertaining.
 * (Three internal services still read the frozen table when this was written;
 * ABL-399 has since moved them onto `energy_generation` too. This endpoint did
 * not wait for it, because it never adopted the defect.)
 *
 * So each target below names a `/v1` **observation stream**, and the table comes
 * from `STREAMS` — the same constant `/v1/observations` reads. That gives three
 * properties for free rather than by discipline:
 *
 * - The actual behind any metric here is **fetchable by the subscriber** from
 *   `/v1/observations/{stream}`, so an accuracy figure is checkable against the
 *   data it was computed from rather than being an assertion.
 * - `energy_generation` has no `DEFAULT 0`, so an unreported type is SQL NULL,
 *   leaves the join unpaired, and is absent from the sample — never a fabricated
 *   zero.
 * - The exclusions `/v1/observations` applies apply here identically, because
 *   they are the same rows in the same tables.
 *
 * ## 4. The load guard stays conditional
 *
 * `loadActualGuard` applies `load_mw > 0` **only** to `load`. A national grid
 * never draws exactly 0 MW, so a stored `0.0` is the ingest writing a
 * placeholder (543 rows across 11 zones) and scoring `|forecast - 0|` against it
 * is a 100% error against a number nobody measured. It is equally true that a
 * `0.0` is completely ordinary for solar overnight, for wind in still air and
 * for a price in a zero-clearing hour — so applying the guard across the board
 * would delete real measurements and bias every renewable metric upward. Same
 * class of mistake, opposite direction. The conditionality is not re-expressed
 * here; `loadActualGuard` is called and it decides.
 */

/**
 * What an accuracy request scores against: a `/v1` observation stream and the
 * column within it.
 *
 * `column` is a function of the table alias because the join needs the same
 * expression twice, once per separator form.
 */
interface AccuracyTarget {
  stream: ObservationStream;
  column: (alias: string) => string;
}

/**
 * The forecast types this endpoint can score, and what it scores each against.
 *
 * Six of the eight types `/v1/forecasts` serves. The two that are absent are
 * absent for a stated reason rather than an oversight, and the reason is the
 * same one in both cases: **their actual has no settled definition on the table
 * this endpoint reads.**
 *
 * - **`hydro_total`** — the two tables split hydro differently. `energy_renewable`
 *   folded pumping into `hydro_reservoir_mw` and stored the pre-netting figure;
 *   `energy_generation` keeps `hydro_pumped_mw` separate. Measured on the
 *   replica, FR 2026-08-01..07: reservoir reads **2,014.3 MW** on the frozen
 *   table against **1,181.7 MW** on `energy_generation`. The models were fit
 *   against the first basis, so scoring them against the second measures the
 *   difference between two definitions of hydro and reports it as forecast
 *   error.
 * - **`renewable`** — `total_renewable_mw` has no counterpart in
 *   `energy_generation` at all; it was a stored computed column, and moving it
 *   turns a column read into a sum whose NULL rule is stated in
 *   `services/renewableTotal.ts`. That sum inherits the hydro question above and
 *   adds its own.
 *
 * Deciding what `renewable` and `hydro_total` mean on the new table was
 * **ABL-399** (ABL-324's remainder), and it has now decided: `renewable` is
 * `renewableTotal.RENEWABLE_MW_COLUMNS` reduced by a null-aware sum, and
 * `hydro_total` is `RENEWABLE_COMPONENTS.hydro` — run-of-river + reservoir,
 * never pumped storage. **This endpoint still serves six types, not eight**,
 * because adopting them here is a deliberate act rather than an automatic
 * consequence: the public app may not import `services/`
 * (`publicAppGraph.test.ts`), so each would have to be restated in `STREAMS`
 * with its own measured justification, and doing so silently inside ABL-399
 * would add two priced resources to a paid surface without anyone choosing to.
 * Until then a request for either gets a 400 naming the six types that *are*
 * served — a refusal a client can act on — rather than a plausible number
 * computed against the wrong basis. Both remain
 * fully available on `/v1/forecasts`: what is withheld is the accuracy claim,
 * not the forecast.
 */
const ACCURACY_TARGETS: Readonly<Record<string, AccuracyTarget>> = {
  load: { stream: 'load', column: (a) => `${a}.load_mw` },
  price: { stream: 'price', column: (a) => `${a}.price_eur_mwh` },
  solar: { stream: 'generation', column: (a) => `${a}.solar_mw` },
  wind_onshore: { stream: 'generation', column: (a) => `${a}.wind_onshore_mw` },
  wind_offshore: { stream: 'generation', column: (a) => `${a}.wind_offshore_mw` },
  biomass: { stream: 'generation', column: (a) => `${a}.biomass_mw` },
};

/** The `?type=` grammar for this endpoint. Ordered as `models.ts` orders the offer. */
export const ACCURACY_TYPE_IDS: readonly string[] = Object.keys(ACCURACY_TARGETS);

/** Which observation stream carries the actual for a type — the freshness key. */
export function accuracyStream(forecastType: string): ObservationStream {
  return ACCURACY_TARGETS[forecastType].stream;
}

export interface AccuracyQuery {
  zone: string;
  forecastType: string;
  model: string;
  window: TimeWindow;
  /** Score one horizon only, in hours. Absent means every horizon in the window. */
  horizonHours?: number;
}

/**
 * How many distinct target hours this model forecasts in the window.
 *
 * The denominator of the pairing rate, and the field that separates the two
 * empty answers: a window with no forecast rows at all is `no_model_coverage`
 * (catboost and xgboost cover disjoint zone sets, so "that model does not serve
 * this zone" is a normal answer), and a window with forecast rows but no pairs
 * is `no_paired_actuals` (a future window, or actuals not ingested yet).
 * Rendering either as a flawless 0% is the defect this endpoint exists to avoid.
 *
 * `COUNT(DISTINCT REPLACE(...))` rather than the correlated `MAX(generated_at)`
 * dedupe {@link readAccuracyPoints} runs: the dedupe keeps exactly one row per
 * target hour, so the distinct count of target hours is the same number without
 * the subquery. Normalising inside `COUNT(DISTINCT ...)` is what makes it the
 * same number — the two stored separators would otherwise count one hour twice.
 */
export function countForecastHours(source: EnergyQuery, query: AccuracyQuery): number {
  const { zone, forecastType, model, window, horizonHours } = query;
  const range = timestampRange(window.sqlStart, window.sqlEndInclusive);

  const params: SqlParam[] = [zone, forecastType, model, ...rangeArgs(range)];
  if (horizonHours !== undefined) params.push(horizonHours);

  const row = source.get<{ hours: number }>(
    `SELECT COUNT(DISTINCT REPLACE(target_timestamp_utc, 'T', ' ')) AS hours
       FROM forecasts
      WHERE country_code = ?
        AND forecast_type = ?
        AND model_name = ?
        AND ${rangeClause('target_timestamp_utc')}
        ${horizonHours === undefined ? '' : 'AND horizon_hours = ?'}`,
    params
  );

  return row?.hours ?? 0;
}

/**
 * Every forecast hour in the window that paired with a measured actual.
 *
 * Bounded by `MAX_WINDOW_DAYS` (366) rather than by a row cap: the response is
 * one aggregate, so there is nothing to paginate, and a year of hourly points is
 * ~8,800 rows reduced in memory by `calculateAccuracy`. The window bound is what
 * bounds the work.
 *
 * The correlated `MAX(generated_at)` repeats the model and, when present, the
 * horizon. Scoping it to one model is what keeps this from becoming the
 * emergent per-country argmax `config/forecastModels.ts` was written to end —
 * whichever model ran most recently wins, including one rejected on evidence.
 * Repeating the horizon matters for the same reason it does in `forecastsRepo`:
 * without it the subquery compares a 6-hour-ahead run against a 60-hour-ahead
 * one and the outer filter then keeps neither consistently.
 *
 * `LENGTH(timestamp_utc) = 19` is deliberately **absent** from the join, and its
 * absence is not an inconsistency with `observationsRepo`. The 26,405 rows
 * carrying a trailing UTC offset are length 25, and both join predicates test
 * equality against `REPLACE(target_timestamp_utc, …)` — a length-19 value, since
 * `forecasts` holds no offset rows. A length-25 row can never equal it, so those
 * rows are excluded by construction. Adding the predicate would cost a clause to
 * exclude rows the equality already cannot reach.
 */
export function readAccuracyPoints(source: EnergyQuery, query: AccuracyQuery): AccuracyPoint[] {
  const { zone, forecastType, model, window, horizonHours } = query;
  const target = ACCURACY_TARGETS[forecastType];
  const { table } = STREAMS[target.stream];
  const range = timestampRange(window.sqlStart, window.sqlEndInclusive);

  // Space form preferred, 'T' form as the fallback — the stated convention. See
  // the module note: this is ABL-215's question, answered by declaration rather
  // than by resolution.
  const actual = `COALESCE(${target.column('a')}, ${target.column('a2')})`;
  const horizonClause = horizonHours === undefined ? '' : 'AND f1.horizon_hours = ?';

  const params: SqlParam[] = [zone, forecastType, model, ...rangeArgs(range)];
  if (horizonHours !== undefined) params.push(horizonHours);
  params.push(model);
  if (horizonHours !== undefined) params.push(horizonHours);
  // The two join predicates bind the zone once each; a LEFT JOIN's ON clause is
  // where this belongs, not the WHERE, or the join degenerates to an inner one
  // for a reason unrelated to pairing.
  params.push(zone, zone);

  return source.all<AccuracyPoint>(
    `WITH latest_forecasts AS (
       SELECT f1.target_timestamp_utc, f1.forecast_value
         FROM forecasts f1
        WHERE f1.country_code = ?
          AND f1.forecast_type = ?
          AND f1.model_name = ?
          AND ${rangeClause('f1.target_timestamp_utc')}
          ${horizonClause}
          AND f1.generated_at = (
            SELECT MAX(f2.generated_at)
              FROM forecasts f2
             WHERE f2.country_code = f1.country_code
               AND f2.forecast_type = f1.forecast_type
               AND f2.target_timestamp_utc = f1.target_timestamp_utc
               AND f2.model_name = ?
               ${horizonClause.replace('f1.horizon_hours', 'f2.horizon_hours')}
          )
     )
     SELECT f.forecast_value AS "forecast", ${actual} AS "actual"
       FROM latest_forecasts f
       LEFT JOIN ${table} a
         ON a.country_code = ?
        AND ${timestampFormOnClause('a.timestamp_utc', 'f.target_timestamp_utc', 'space')}
       LEFT JOIN ${table} a2
         ON a2.country_code = ?
        AND ${timestampFormOnClause('a2.timestamp_utc', 'f.target_timestamp_utc', 't')}
      WHERE ${actual} IS NOT NULL
        ${loadActualGuard(forecastType, actual)}
      ORDER BY REPLACE(f.target_timestamp_utc, 'T', ' ')`,
    params
  );
}

/**
 * The newest run we hold for this zone, type and model, in stored form.
 *
 * `meta.latest_vintage_at` on the response. An accuracy figure is a statement
 * about a model, and "which model, how recently run" is half of what makes it
 * one — the same field `/v1/forecasts` publishes, for the same reason.
 */
export function readNewestVintage(
  source: EnergyQuery,
  zone: string,
  forecastType: string,
  model: string
): string | null {
  const row = source.get<{ mx: string | null }>(
    `SELECT MAX(generated_at) AS mx
       FROM forecasts
      WHERE country_code = ? AND forecast_type = ? AND model_name = ?`,
    [zone, forecastType, model]
  );
  return row?.mx ?? null;
}
