/**
 * The one definition of "renewable" for the read path: which
 * `energy_generation` columns count, how they roll up into the seven fields
 * the `/renewables` endpoints put on the wire, and — the part that has to be
 * got right — how those roll up into a total that is NULL when we measured
 * nothing.
 *
 * This module exists because `total_renewable_mw` does not exist in
 * `energy_generation`. It was a stored computed column on the frozen
 * `energy_renewable` table (ABL-324), so moving off that table turns a column
 * read into a sum — and a sum is where "we do not know" quietly becomes a
 * confident `0`. `COALESCE(a,0) + COALESCE(b,0) + …` over a country that
 * reports none of these types returns `0`, which renders as a country
 * generating no renewable power rather than as a country we hold no reading
 * for. That is this repo's recurring defect (a plausible wrong number, no
 * error, no empty state), so the reduction is stated once, here, with tests.
 *
 * ## The rule, in both directions
 *
 * `min_count=1` semantics, the same rule `energy_generation`'s own NULL/0
 * split encodes:
 *
 *  - **every** component NULL -> `null`. Nothing was reported; there is no
 *    total to state.
 *  - **some** components NULL -> the sum of the ones that were reported. A
 *    country reporting solar but not marine has a knowable renewable total;
 *    treating it as partially unknown would delete a real reading.
 *  - a measured `0.0` (solar overnight, a becalmed wind fleet) is a **value**,
 *    not a missing reading. It contributes 0 and keeps the total non-null.
 *
 * The third case is the one that separates this from a plain
 * null-propagating `+`: SQL's `+` returns NULL if any operand is NULL, which
 * would let one unreported type erase every reported one beside it.
 *
 * Used by `renewableService` (all four read sites) and by
 * `generationService.RENEWABLE_MW_SUM`, so the seven wire fields and the
 * renewable share's numerator cannot come to disagree about which columns are
 * renewable — they are generated from `RENEWABLE_COMPONENTS` below.
 */

/** The seven fields `/renewables` and `/renewables/mix` have always served. */
export type RenewableField =
  | 'solar'
  | 'wind_onshore'
  | 'wind_offshore'
  | 'hydro'
  | 'biomass'
  | 'geothermal'
  | 'other';

/**
 * Wire field -> the `energy_generation` columns it sums.
 *
 * Two entries are not one-to-one, and both differ from the frozen table:
 *
 *  - **`hydro` = run-of-river + reservoir**, and deliberately *not*
 *    `hydro_pumped_mw`. `energy_renewable` folded pumping into
 *    `hydro_reservoir_mw` and stored the pre-netting figure, so the same
 *    country reads lower here. Measured on the replica, FR 2026-08-01..07:
 *    `energy_renewable` reservoir 2,014.3 MW vs `energy_generation` 1,181.7 MW
 *    (run-of-river agrees exactly, 2,326.1 MW both sides). The new figure is
 *    the correct one — a store is not a source, and pumping is routinely
 *    negative — but it is a *visibly different number*, which is why ABL-324
 *    had it signed off rather than shipped quietly.
 *  - **`other` = marine + other renewable.** `energy_renewable` had no marine
 *    column at all, so its `other` was `other_renewable_mw` alone and marine
 *    output was silently dropped. Including it is what makes the seven fields
 *    sum to exactly `RENEWABLE_MW_SUM`'s nine columns — i.e. makes `total` and
 *    `renewable_percentage`, served side by side on one `/renewables/mix`
 *    object, agree about what "renewable" means. Measured on the replica,
 *    only **ES** (160,101 rows) and **SE** (1,440) report marine at all, so
 *    this moves `other` for two countries and nothing else.
 *
 * `hydro_pumped_mw` and `energy_storage_mw` are excluded for the reason
 * `generationService.RENEWABLE_MW_SUM` already gives: they are stores, not
 * primary generation, and their discharge was generated — and counted —
 * somewhere else already.
 */
export const RENEWABLE_COMPONENTS: Record<RenewableField, readonly string[]> = {
  solar: ['solar_mw'],
  wind_onshore: ['wind_onshore_mw'],
  wind_offshore: ['wind_offshore_mw'],
  hydro: ['hydro_run_mw', 'hydro_reservoir_mw'],
  biomass: ['biomass_mw'],
  geothermal: ['geothermal_mw'],
  other: ['marine_mw', 'other_renewable_mw'],
};

/** The seven wire fields, in the order they are selected and summed. */
export const RENEWABLE_FIELDS = Object.keys(RENEWABLE_COMPONENTS) as RenewableField[];

/**
 * Every `energy_generation` column the seven fields draw on, flattened.
 * `generationService.RENEWABLE_MW_SUM` is built from this list, which is what
 * keeps the renewable-share numerator and the renewable breakdown defined by
 * one set of columns rather than two that can drift.
 */
export const RENEWABLE_MW_COLUMNS: readonly string[] =
  RENEWABLE_FIELDS.flatMap((field) => RENEWABLE_COMPONENTS[field]);

/**
 * Sums the reported members, or returns null when none was reported.
 *
 * The TypeScript half of the rule in this module's header, and the reduction
 * behind `RenewableMix.total`. Deliberately the same shape as
 * `sourceRows.ts`'s client-side `sumOrNull` — the two live on opposite sides
 * of the wire and must not answer differently.
 *
 * Note `0` is kept: the filter tests `!= null`, not truthiness. A truthy
 * filter would drop a measured zero and, for a country whose every reading is
 * a genuine `0.0`, turn "we measured no output" into "we hold no reading" —
 * the same class of lie as the reverse, in the other direction.
 */
export function sumOrNull(values: Array<number | null | undefined>): number | null {
  const reported = values.filter((v): v is number => v != null);
  if (reported.length === 0) return null;
  return reported.reduce((a, v) => a + v, 0);
}

/**
 * How a column is read inside a null-aware sum: as itself (one row) or
 * through an aggregate (one bucket).
 */
export type SqlTerm = (column: string) => string;

/** One row's value — for `LIMIT 1` / latest-row reads. */
export const RAW_COLUMN: SqlTerm = (column) => column;

/**
 * The bucket's null-skipping average — for `GROUP BY` reads and whole-window
 * aggregates. `AVG()` ignores NULL rows and is itself NULL only when every
 * row in the bucket is NULL for that column, which is exactly the per-column
 * "not reported" signal this sum needs.
 */
export const WINDOW_AVERAGE: SqlTerm = (column) => `AVG(${column})`;

/**
 * `sumOrNull` expressed in SQL: a CASE guard that yields NULL only when every
 * term is NULL, and otherwise a COALESCE-to-0 sum of the terms.
 *
 * Both halves are load-bearing, and each is the fix for the other's failure:
 *
 *  - the `COALESCE` alone (`COALESCE(a,0) + COALESCE(b,0)`) fabricates a `0`
 *    total for a country that reports none of these types;
 *  - the bare `+` alone (`a + b`) propagates NULL, so one unreported member
 *    deletes a reported one beside it — FR's `hydro_reservoir_mw` at 02:00
 *    would null out a real `hydro_run_mw` reading.
 *
 * The CASE decides "not reported"; the COALESCE inside it only ever lets a
 * reported member stand next to an unreported sibling. It can therefore never
 * turn an absence into a measurement.
 *
 * Emits byte-identical text to the `groupExpression` this replaces in
 * `generationService`, so that module's SQL — and the query-plan and
 * SQL-shape assertions over it — are unchanged by the consolidation.
 */
export function nullAwareSumSql(
  columns: readonly string[],
  alias: string,
  term: SqlTerm = RAW_COLUMN
): string {
  const terms = columns.map(term);
  const allNull = terms.map((t) => `${t} IS NULL`).join(' AND ');
  const sum = terms.map((t) => `COALESCE(${t}, 0)`).join(' + ');
  return `CASE WHEN ${allNull} THEN NULL ELSE ROUND(${sum}, 2) END as ${alias}`;
}

/**
 * The seven renewable fields as SELECT expressions, each null-aware over its
 * own component columns. `term` picks the read: `WINDOW_AVERAGE` for a
 * grouped/window query, `RAW_COLUMN` for a single row.
 *
 * A prefix (`'r.'`) is applied to the raw column names, for the joined
 * queries that alias `energy_generation`.
 */
export function renewableFieldSelects(term: SqlTerm = RAW_COLUMN, prefix = ''): string[] {
  return RENEWABLE_FIELDS.map((field) =>
    nullAwareSumSql(
      RENEWABLE_COMPONENTS[field].map((c) => `${prefix}${c}`),
      field,
      term
    )
  );
}
