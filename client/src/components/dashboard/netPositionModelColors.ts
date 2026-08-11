/**
 * One colour per net-position model, shared by the multi-select picker's
 * checkboxes, the chart's forecast lines and its legend — the same "one
 * palette, one place" convention `generationSeries.ts`'s
 * `GENERATION_GROUP_COLORS` uses, for the same reason: this repo has already
 * had chart colours drift into several private copies that disagreed with
 * each other (ABL-44).
 *
 * Categorical, not the severity ramp in `lib/dataScale.ts` — that ramp encodes
 * a WAPE rank (clean -> dirty) and reusing it here would make "which model is
 * this" look like "how good is this model", which is not a claim this picker
 * makes.
 *
 * Validated with the dataviz skill's `validate_palette.js` against this app's
 * card surface (`--card`, #FFFFFF): `#2a78d6,#c98500,#008300,#e34948` passes
 * lightness band, chroma floor, all-pairs normal-vision floor (worst pair
 * ΔE 15.1) and >=3:1 contrast; CVD all-pairs separation is a WARN (worst pair
 * #c98500<->#e34948 ΔE 6.2, inside the 6-8 band that requires secondary
 * encoding rather than colour alone) — met here by every consumer also naming
 * the model in text (checkbox label, legend, tooltip), never colour-only.
 * `--primary` (the house teal) is deliberately excluded from this set: it
 * already means "the actual series" on every chart in this app, and reusing
 * it for a forecast model's identity would blur that meaning.
 */
export const NET_POSITION_MODEL_COLORS: Record<string, string> = {
  'chronos-2-V010': '#2a78d6',
  'baseline-V012': '#c98500',
  'xgboost-V014': '#008300',
  'chronos-2-V016': '#e34948',
};

/** Neutral fallback for a model id the palette above has no entry for. */
const FALLBACK_COLOR = '#6B6459';

export function netPositionModelColor(modelId: string): string {
  return NET_POSITION_MODEL_COLORS[modelId] ?? FALLBACK_COLOR;
}
