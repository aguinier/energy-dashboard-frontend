import { ForecastType } from '../types/index.js';
import {
  RENEWABLE_COMPONENTS,
  RENEWABLE_MW_COLUMNS,
  nullAwareSumExpr,
} from './renewableTotal.js';

/**
 * Which table and which value a forecast of a given type is scored against.
 *
 * ## Why this module exists (ABL-399, the remainder of ABL-324)
 *
 * Three services score forecasts against actuals — `forecastService`
 * (`/forecasts/compare`), `mlForecastService` (ML accuracy) and
 * `crossCountryMetricsService` (the ComparisonView heatmap, map, leaderboard
 * and the D-7 seasonal-naive baseline). Each carried its **own copy** of this
 * mapping, as a `Record<forecastType, { table, column }>` literal. A comment on
 * one of them claimed they were "kept identical … so the three cannot drift
 * apart again", which a comment cannot enforce — and each copy also had to
 * special-case `hydro_total`, because a two-column expression cannot simply be
 * prefixed with a join alias.
 *
 * Worse, the table name was a **string interpolated at query time**
 * (`FROM ${mapping.table}`, `LEFT JOIN ${mapping.table} a`), so no literal ever
 * sat next to a SQL keyword and the grep CLAUDE.md recommended —
 * `grep -rn "FROM energy_renewable\|JOIN energy_renewable" server/src` —
 * returned **zero hits while seven sites were live**. That is why ABL-324's
 * three tranches passed over them. One mapping, in one module, with the table
 * name reachable by an ordinary search, is the fix for the invisibility as much
 * as for the drift.
 *
 * ## What changed: `energy_renewable` -> `energy_generation`
 *
 * The frozen `energy_renewable` is the wrong actuals source for an accuracy
 * metric, for the reasons ABL-353 established on the TSO path and which apply
 * unchanged here. All figures below measured read-only on the replica
 * 2026-08-13, over full history.
 *
 * **1. It fabricates the actual.** `energy_renewable` carries `DEFAULT 0` on
 * every `*_mw` column, so a production type a country does not report is stored
 * as a literal `0.0` rather than as NULL. `energy_generation` deliberately has
 * no such default. Taking every forecast row paired against an
 * `energy_renewable` value of exactly `0.0` and asking `energy_generation` what
 * it recorded at the same country and instant:
 *
 * | type            | pairs at `0.0` | genuine `0.0` | **positive** | **negative** | no gen row |
 * |-----------------|---------------:|--------------:|-------------:|-------------:|-----------:|
 * | `solar`         |         44,279 |        38,128 | **5,287**    |            0 |        864 |
 * | `wind_offshore` |          3,895 |             0 |            0 | **3,895**    |          0 |
 * | `wind_onshore`  |              8 |             0 |        **8** |            0 |          0 |
 * | `biomass`       |              2 |             0 |        **2** |            0 |          0 |
 *
 * **9,192 pairs were scored against a zero that never happened.** Every one of
 * the 3,895 offshore-wind pairs is wrong and not one agrees: the real
 * measurement is *negative* — an offshore fleet drawing auxiliary load, which
 * `energy_generation` records faithfully and the frozen table flattens to `0.0`.
 * Confirmed per row on the instant ABL-399 cites, BE `2026-01-14 08:00:00`:
 * `energy_renewable.wind_offshore_mw = 0`, `energy_generation` **−26.2625 MW**.
 * On the solar side the real generation reached **+334.72 MW** (DE) against a
 * stored zero.
 *
 * **The 38,128 genuine overnight zeros are kept.** They are ordinary
 * measurements — a solar fleet at 03:00 really did generate 0 MW — and this is
 * why the fix is a table swap and *not* a `> 0` filter on the actual. A blanket
 * floor would delete those 38,128 real readings and bias every renewable
 * accuracy figure upward; `loadQuality.loadActualGuard` exists precisely so the
 * `> 0` rule reaches `load` and nothing else, and it is unchanged here.
 *
 * (The figures above count raw forecast rows. The accuracy endpoints
 * deduplicate to `MAX(generated_at)` per target timestamp first, so the number
 * of *scored* pairs actually corrected is smaller — 1,460 across the four
 * countries, against 6,285 genuine zeros preserved and 108 instants that have
 * no `energy_generation` row and become absent points.)
 *
 * **2. It silently drops variant-spelled actuals.** `energy_renewable` holds
 * 90,636 rows whose `timestamp_utc` is `T`-separated or carries a trailing
 * offset. That does not cost pairs here — these three services already join
 * through `timestampFormOnClause` (ABL-214) — but it is why the table also
 * holds **26,694 duplicate instants**, 26,400 of them with *conflicting*
 * values, against **0 duplicate instants in `energy_generation`'s 3,180,752
 * rows**. An accuracy metric reading one of two disagreeing rows for the same
 * hour is not a measurement.
 *
 * **3. It covers far less**: 832,050 rows against 3,180,752.
 *
 * ## The two types that are not a table swap
 *
 * `solar` / `wind_onshore` / `wind_offshore` / `biomass` are single columns
 * carrying identical names in both tables. The other two are re-derivations,
 * and both reuse `renewableTotal.ts` rather than restating what "renewable" or
 * "hydro" means — that module is the single definition the `/renewables`
 * endpoints already serve from, so the accuracy path and the generation mix
 * cannot come to disagree about the same country's hydro.
 *
 * **`renewable`** had no counterpart at all: `total_renewable_mw` was a stored
 * computed column. It is now `nullAwareSumExpr` over
 * `RENEWABLE_MW_COLUMNS` — NULL when every component is NULL, the sum of the
 * reported ones otherwise, and a measured `0.0` is a value. A plain
 * `COALESCE(a,0) + …` would report a country that reports none of these types
 * as generating zero renewable power; a plain `a + b + …` would let one
 * unreported type erase the eight reported beside it.
 *
 * **`hydro_total`** is `hydro_run_mw + hydro_reservoir_mw` on both tables — the
 * same column names, and yet **not** the same quantity, which is the trap. The
 * frozen table folds pumped storage into `hydro_reservoir_mw`; `energy_generation`
 * splits it into its own `hydro_pumped_mw`. Proven on the BE instant above:
 * `energy_renewable.hydro_reservoir_mw` is `73.31`, exactly
 * `energy_generation.hydro_pumped_mw`, while `energy_generation.hydro_reservoir_mw`
 * is NULL. So today's `hydro_total` actual for Belgium is run-of-river *plus
 * pumped storage* — a store, routinely negative, and explicitly excluded from
 * `RENEWABLE_COMPONENTS.hydro` for that reason.
 *
 * Taking `RENEWABLE_COMPONENTS.hydro` (run + reservoir, no pumping) is the
 * decision ABL-351 already made and shipped for `/renewables`; this issue
 * adopts it rather than inventing a second one. Two consequences, both
 * measured and both intended:
 *
 *  - **BE's hydro actual falls** from ~129 MW mean (19.53 run + 109.51 folded
 *    pumping) to ~39 MW (run-of-river alone). The new figure is Belgium's
 *    hydro generation; the old one was hydro generation plus a store.
 *  - **The reduction must be null-aware, not a bare `+`.** BE reports no
 *    reservoir hydro at all — `hydro_reservoir_mw` is NULL in **all 49,213**
 *    `energy_generation` rows — so a NULL-propagating `+` yields NULL for every
 *    Belgian hour and BE's `hydro_total` accuracy drops from 5,121 pairs to
 *    **zero**, discarding 49,213 real run-of-river readings to express an
 *    absence that is a property of Belgium's fleet rather than of our data.
 *    For FR the two rules differ on **2 rows out of 90,397**, so this choice is
 *    almost entirely a choice about whether Belgium is measurable at all.
 *
 * That reverses a comment `forecastService` used to carry ("the hydro sum is
 * deliberately not COALESCE'd to 0 … `NULL + 30` reading as 30 would invent a
 * measurement"). It was right about `COALESCE`-to-0 *alone* and wrong about the
 * guarded form: `nullAwareSumExpr` yields NULL when every component is NULL, so
 * it can never turn an absence into a measurement — it only stops one
 * unreported member deleting a reported one beside it.
 *
 * ## Known consequence, stated rather than absorbed
 *
 * The sibling `energy-forecast` job trains these renewable-family models
 * against `energy_renewable`. Scoring them against `energy_generation`
 * therefore measures them against a quantity they were not fitted to, and some
 * figures move a long way for that reason. Measured full-history WAPE, before
 * -> after: BE `hydro_total` **79.85 -> 626.98** (the model predicts ~129 MW of
 * run-of-river-plus-pumping against a ~39 MW hydro actual — it is forecasting
 * the old definition well and the new one badly), BE `biomass` 58.83 -> 72.01
 * with its mean actual going 101.03 -> 252.35 MW, BE `wind_onshore`
 * 121.96 -> 137.74. That is not a regression introduced here: it is the same
 * disagreement, now visible, and a WAPE over ~100% reads as "loses to
 * forecasting zero" rather than as a metric worth ranking. The endpoint's
 * job is to compare a forecast of a country's generation against the best
 * statement we hold of that generation, and every other surface in this
 * dashboard — the generation mix, the map, `/renewables`, and the TSO accuracy
 * path since ABL-353 — already reads `energy_generation`. Leaving this one path
 * on the frozen table to keep a flattering number would be the confidently-
 * wrong-number defect in its purest form. The training-target mismatch is real
 * and belongs to the forecast repo; it is recorded in CLAUDE.md and filed
 * separately.
 */
export interface ActualsSource {
  /** The table holding the measured value. */
  readonly table: string;
  /** The timestamp column on that table. */
  readonly timestampCol: string;
  /**
   * SQL expression for the actual value, given a prefix for the table
   * reference — `''` for an unaliased `FROM`, `'a.'` for a joined alias.
   *
   * Always safe to embed in a larger expression (multi-column reductions are
   * parenthesised), which is what removes the per-call-site `hydro_total`
   * special case the three services each used to carry.
   */
  valueExpr(prefix: string): string;
}

/** A single stored column, read as itself. */
function column(table: string, name: string): ActualsSource {
  return {
    table,
    timestampCol: 'timestamp_utc',
    valueExpr: (prefix) => `${prefix}${name}`,
  };
}

/**
 * Several `energy_generation` columns reduced by `renewableTotal`'s null-aware
 * sum — NULL only when every component is NULL. Parenthesised so it can sit
 * inside `ABS(... - forecast_value)` and `COALESCE(...)` unchanged.
 *
 * Deliberately unrounded: these are accuracy queries, and rounding the actual
 * before differencing it against the forecast would change the error itself.
 */
function nullAwareSum(columns: readonly string[]): ActualsSource {
  return {
    table: 'energy_generation',
    timestampCol: 'timestamp_utc',
    valueExpr: (prefix) => `(${nullAwareSumExpr(columns.map((c) => `${prefix}${c}`))})`,
  };
}

/**
 * The one mapping. Keys are the forecast types that can be scored at all;
 * anything absent has no actuals source and yields an empty result rather than
 * a guessed one.
 */
export const ACTUAL_SOURCES: Readonly<Partial<Record<ForecastType, ActualsSource>>> = {
  load: column('energy_load', 'load_mw'),
  price: column('energy_price', 'price_eur_mwh'),
  solar: column('energy_generation', 'solar_mw'),
  wind_onshore: column('energy_generation', 'wind_onshore_mw'),
  wind_offshore: column('energy_generation', 'wind_offshore_mw'),
  biomass: column('energy_generation', 'biomass_mw'),
  hydro_total: nullAwareSum(RENEWABLE_COMPONENTS.hydro),
  renewable: nullAwareSum(RENEWABLE_MW_COLUMNS),
};

/** The actuals source for a forecast type, or undefined if it has none. */
export function actualsSourceFor(forecastType: ForecastType): ActualsSource | undefined {
  return ACTUAL_SOURCES[forecastType];
}
