import type { LoadForecastBasis } from '@/types';

/**
 * The copy for a forecast overlay the server withheld because it is not on the
 * same basis as the actuals it would have been drawn against (ABL-501; server
 * side in `services/loadForecastBasis.ts`).
 *
 * This is the chart-side sibling of `comparison/basisNotice.ts`, which does the
 * same job for a withheld *measure* on the Forecast-quality portfolio. They are
 * two modules rather than one because the two surfaces are answering different
 * questions with different evidence in front of the reader — a blank accuracy
 * cell versus a chart with one line on it — and the server sends a differently
 * worded sentence for each. What they share is the rule that matters: the note
 * comes off the wire, and there is no copy of it here.
 *
 * The failure mode this module exists to prevent is specific and was created by
 * the fix itself. Once the server withholds, a withheld overlay and a genuinely
 * uncovered one look identical from the client: both are zero points. The
 * existing copy for zero points is `forecastGap.ts`'s "<model> has no forecast
 * for <country> in this window", which for NL would be **false** — catboost
 * publishes a full 96-row day and we are declining to draw it. So a withheld
 * entry must never reach that path, and the split is made here rather than
 * inside `describeForecastGapsForSelection`, so that function keeps meaning one
 * thing.
 */

/**
 * What the legend shows beside a withheld model's hatched key.
 *
 * Short by necessity — it sits inline in a chart legend, where
 * `AbleLineChart` renders it after an em-dash — so it carries only the
 * distinction from "not available", and the sentence below carries the
 * finding. "Withheld" and not "unavailable" for the reason the whole rule
 * exists: we hold the rows.
 */
export const WITHHELD_LEGEND_NOTE = 'Withheld — different basis';

export interface ForecastBasisFields {
  basis?: LoadForecastBasis | null;
  basisNote?: string | null;
}

/**
 * The sentence for one withheld series, or `null` when there is no finding.
 *
 * Requires **both** fields. Either alone is a malformed response, and a
 * half-suppressed one must not print a heading with nothing under it — the
 * server never sends one, and a cached response predating this rule sends
 * neither.
 */
export function withheldForecastNote(fields: ForecastBasisFields | undefined | null): string | null {
  if (!fields || fields.basis !== 'divergent_basis') return null;
  return fields.basisNote ? fields.basisNote : null;
}

/** True when this entry's line was withheld — i.e. its emptiness is our decision, not a coverage gap. */
export function isWithheld(fields: ForecastBasisFields | undefined | null): boolean {
  return withheldForecastNote(fields) !== null;
}

export interface WithheldModelGroup {
  /** Display labels of the withheld models, in the caller's order. */
  labels: string[];
  /** The one sentence they share. */
  note: string;
}

/**
 * The withheld models in a multi-model selection, grouped by the sentence they
 * share (ABL-204's picker, ABL-501's rule).
 *
 * Grouped rather than listed one-per-model because today every withheld model
 * on a given country carries the identical sentence — the finding is a property
 * of that country's realized series, not of a producer — so printing it once
 * per checked box would repeat a paragraph three times under one chart. Keyed
 * on the note rather than on the country so that a future registry entry
 * wording two findings differently still renders both.
 */
export function groupWithheldModels(
  entries: readonly ({ label: string } & ForecastBasisFields)[],
): WithheldModelGroup[] {
  const groups: WithheldModelGroup[] = [];
  for (const entry of entries) {
    const note = withheldForecastNote(entry);
    if (note === null) continue;
    const existing = groups.find((g) => g.note === note);
    if (existing) existing.labels.push(entry.label);
    else groups.push({ labels: [entry.label], note });
  }
  return groups;
}

/**
 * "catboost", "catboost and ENTSO-E TSO · D+1", "a, b and c" — the models a
 * group covers, for the lead-in to its sentence.
 *
 * Named in full rather than counted ("2 models withheld") because the reader's
 * next move is to look at the picker, where the boxes are labelled.
 */
export function joinModelLabels(labels: readonly string[]): string {
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
