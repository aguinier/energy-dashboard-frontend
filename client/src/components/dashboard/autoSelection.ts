import type { RecommendedModel, RankedModelCandidate } from '@/types';

/**
 * The words for an auto-selected forecast (ABL-469).
 *
 * The Board directive is that where the ENTSO-E series is currently better
 * than ours we display it by default, **labelled with its source**. A default
 * that silently changed source would be the worst of both: a reader who
 * assumes they are looking at our model, and no way to tell.
 *
 * Pure, and separate from the components, for the reason every `*Note.ts` in
 * this directory is: what a chart claims about its own provenance is exactly
 * the thing worth pinning in a test, and pinning it through a React tree would
 * make the assertions about markup instead of about the claim.
 *
 * ## Three things it refuses to say
 *
 * - **Nothing at all for a fallback.** `recommended.fallback` means nothing had
 *   a measurable track record and the type's hand-picked production model is
 *   serving, exactly as before auto-selection existed. Announcing that as "the
 *   most accurate forecast here" would be a confident claim about a
 *   measurement nobody took — this repo's defining failure mode.
 * - **No runner-up that was not measured.** The comparison names the next
 *   *ranked* candidate only. A model excluded for having no pairs at all is
 *   not a model this one beat, and "beat able-ml · catboost" would read as a
 *   race that never happened.
 * - **No WAPE it does not have.** Every number rendered comes off the payload;
 *   nothing is derived, and a `null` renders as an absent clause rather than
 *   as a zero.
 */

/** The next-best measured candidate, or `null` when the winner had no rival. */
function runnerUp(rec: RecommendedModel): RankedModelCandidate | null {
  return (
    rec.candidates.find((c) => c.excluded === null && c.id !== rec.modelId) ?? null
  );
}

/** `3.45` -> `3.45%`. Kept to the 2dp the server's own `wape()` rounds to. */
function pct(value: number): string {
  return `${value.toFixed(2)}%`;
}

/**
 * The sentence under the chart, or `null` when there is nothing honest to say
 * — a user pin, a fallback default, or a measurement that has not landed.
 *
 * `selection.autoSelected` is already `null` in the first two cases
 * (`resolveSelection`), so this reads as "describe an auto-selection" rather
 * than re-deriving when one applies.
 */
export function describeAutoSelection(
  rec: RecommendedModel | null | undefined,
  countryLabel: string,
): string | null {
  if (!rec || rec.fallback || rec.wape == null) return null;

  const sourceWord = rec.source === 'tso' ? 'ENTSO-E' : 'our own model';
  const other = runnerUp(rec);

  const comparison =
    other && other.wape != null
      ? `${pct(rec.wape)} WAPE against ${pct(other.wape)} for ${other.label}`
      : `${pct(rec.wape)} WAPE, the only forecast with a measured track record here`;

  return (
    `Showing ${rec.label} — ${sourceWord}, automatically selected as the most ` +
    `accurate forecast for ${countryLabel} over the last ${rec.windowDays} days ` +
    `(${comparison}). Pick any model above to override.`
  );
}

/**
 * The one-line hint under the picker's "Default — automatic" row.
 *
 * Says which model the default currently resolves to and on what basis, so the
 * picker and the chart agree before the dropdown is closed. Falls back to the
 * pre-ABL-469 wording — which describes the server's coverage ladder, and is
 * still exactly what happens — whenever there is no measured winner.
 */
export function describeAutoSelectionHint(rec: RecommendedModel | null | undefined): string {
  const LADDER = 'Production, then next available';
  if (!rec) return LADDER;
  if (rec.fallback || rec.wape == null) {
    // Named rather than left implicit: "no track record yet" is a different
    // state from "measured, and ours won", and only one of them will change.
    return `${LADDER} — no measured track record here yet`;
  }
  return `${rec.label} · best measured here (${pct(rec.wape)} WAPE, last ${rec.windowDays} days)`;
}

/**
 * Source badge text for the auto-selected model, for a UI that has room for a
 * word and not a sentence. `null` when nothing was auto-selected.
 */
export function autoSelectionSourceLabel(rec: RecommendedModel | null | undefined): string | null {
  if (!rec || rec.fallback) return null;
  return rec.source === 'tso' ? 'ENTSO-E TSO' : 'able-ml';
}
