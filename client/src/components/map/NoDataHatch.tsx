/**
 * The "not measured" fill, shared by every choropleth in this app.
 *
 * It is a **texture, not a tint**, and that is the whole point. Every fill on a
 * data scale is a solid colour, so a paler solid colour is the same *kind* of
 * mark — only quieter. A reader glancing at the map reads it as "this country
 * scored somewhere unremarkable", which is the confidently-wrong-number failure
 * this codebase keeps having to fix. Diagonal hatching is the one mark that is
 * visibly *not on the scale*: it survives comparison against any colour, at any
 * opacity, and in greyscale.
 *
 * The base colour also deliberately avoids the diverging ramp's near-beige zero
 * (`NEUTRAL_ZERO` in EuropeMap) — otherwise a balanced country and a missing one
 * read identically, which is the same bug one level down.
 *
 * This lives in one file because it has now been wanted in two places
 * (`EuropeMap`, `ComparisonMap`) and the second one grew a weaker copy instead —
 * flat grey at 0.5 opacity, ABL-23. Same reasoning as `lib/dataScale.ts`: two
 * definitions is how two views of the same "we don't know" end up disagreeing
 * about what it looks like.
 */
export const NO_DATA_FILL = '#E4E0D6';
export const NO_DATA_STROKE = '#CFCABE';

/** SVG paint referencing a hatch pattern rendered under `id`. */
// eslint-disable-next-line react-refresh/only-export-components -- utility co-located with the pattern component it serves
export function noDataHatchUrl(id: string): string {
  return `url(#${id})`;
}

/**
 * The `<pattern>` itself. Render inside the consuming `<svg>`'s `<defs>`.
 *
 * `id` must be unique per mounted `<svg>` — a hardcoded one collides when two
 * maps are on the page at once (EuropeMap renders both docked and full-screen),
 * and a collided reference silently paints the wrong pattern. Callers derive it
 * from `useId()`.
 */
export function NoDataHatchPattern({ id }: { id: string }) {
  return (
    <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" fill={NO_DATA_FILL} />
      <line x1="0" y1="0" x2="0" y2="6" stroke={NO_DATA_STROKE} strokeWidth="1.5" />
    </pattern>
  );
}

/**
 * A 10x10 legend key showing the same hatch. Carries its own `<defs>`, because a
 * legend sits outside the map's `<svg>` and an SVG fragment reference does not
 * reach across documents in every renderer.
 */
export function NoDataSwatch({ id }: { id: string }) {
  return (
    <svg width="10" height="10" className="rounded-sm border border-border" aria-hidden="true">
      <defs>
        <NoDataHatchPattern id={id} />
      </defs>
      <rect width="10" height="10" fill={noDataHatchUrl(id)} />
    </svg>
  );
}
