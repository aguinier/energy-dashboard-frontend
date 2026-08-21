import type { CrossCountryMetrics, CrossCountryMetricsEntry } from '@/types';

/**
 * The copy for a country whose error measures were withheld because its two
 * series are not on the same basis (ABL-493, server side in
 * `services/loadForecastBasis.ts`).
 *
 * The null path through this view was already correct by construction —
 * `wapeRanks` excludes a null WAPE so the country is unplaced rather than
 * first, `wapeColor(null)` returns no colour, and every cell already guards
 * `!== null`. What was missing is the **reason**. A bare em-dash where a
 * number used to be trades a wrong number for a silent one, and this repo's
 * own rule is that a withheld number is replaced by what it would have
 * claimed, never merely deleted.
 *
 * Two words are load-bearing and neither is negotiable:
 *
 * - **"not comparable", never "no data" or "insufficient data".** We hold both
 *   series in full — for NL that is 169 paired hours and a real D-7 baseline.
 *   Saying the data is missing is a different false claim, and it is the one
 *   the reader would act on by asking for a backfill nobody needs. The server
 *   draws the same distinction by giving this its own verdict word rather than
 *   reusing a coverage word.
 * - **The note states what the gap *is*.** It comes off the wire from the
 *   registry entry that was established against the upstream documents, so
 *   there is no second copy of it here to drift.
 */
export const NOT_COMPARABLE = 'not comparable';

export interface BasisNotice {
  country: string;
  note: string;
}

type BasisFields = Pick<CrossCountryMetricsEntry, 'basis' | 'basisNote'>;

/**
 * The note for one entry, or `null` when there is no finding against it.
 *
 * Requires **both** fields, because either alone is a malformed response and a
 * half-suppressed row must not print a heading with nothing under it — the
 * server never sends one, and a stale cached response predating ABL-493 sends
 * neither.
 */
export function divergentBasisNote(entry: BasisFields | undefined | null): string | null {
  if (!entry || entry.basis !== 'divergent_basis') return null;
  return entry.basisNote ? entry.basisNote : null;
}

/**
 * One notice per country whose entry for this forecast type was withheld, in
 * the caller's row order and deduplicated by country.
 *
 * Returns `[]` for the ordinary case, so a caller can render the footnote
 * conditionally without asking whether the feature is "on".
 */
export function basisNoticesFromRows(
  rows: readonly ({ country: string } & BasisFields)[],
): BasisNotice[] {
  const seen = new Set<string>();
  const notices: BasisNotice[] = [];
  for (const row of rows) {
    const note = divergentBasisNote(row);
    if (note === null || seen.has(row.country)) continue;
    seen.add(row.country);
    notices.push({ country: row.country, note });
  }
  return notices;
}

export interface TypedBasisNotice extends BasisNotice {
  type: string;
}

/**
 * Every withheld (country, forecast type) pair across the columns in view, for
 * the matrix — which shows several types at once, so a notice has to name the
 * type as well as the country.
 *
 * Sorted by country then by the caller's column order, so the footnote does
 * not reshuffle when the table above it is re-sorted. A country can appear
 * more than once here and should: two withheld types are two findings.
 */
export function basisNoticesAcrossTypes(
  data: CrossCountryMetrics,
  forecastTypes: readonly string[],
): TypedBasisNotice[] {
  const notices: TypedBasisNotice[] = [];
  for (const country of Object.keys(data).sort((a, b) => a.localeCompare(b))) {
    for (const type of forecastTypes) {
      const note = divergentBasisNote(data[country]?.[type]);
      if (note !== null) notices.push({ country, type, note });
    }
  }
  return notices;
}
