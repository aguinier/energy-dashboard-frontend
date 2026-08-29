export interface SeriesPoint { t: string; v: number | null }
export interface ResidualPoint { t: string; residual: number }

/**
 * Signed residual (actual − forecast) per interval, paired on timestamp.
 *
 * An interval missing either side is DROPPED, never zeroed. A zero residual
 * means "the forecast was exactly right"; an absent one means "we cannot say".
 * Collapsing the second into the first draws a confident flat line through
 * every gap in the feed — which is the specific lie this whole design is
 * organised against.
 */
export function buildResidualSeries(
  actual: SeriesPoint[],
  forecast: SeriesPoint[]
): ResidualPoint[] {
  const forecastByT = new Map<string, number>();
  for (const p of forecast) {
    if (p.v !== null && Number.isFinite(p.v)) forecastByT.set(p.t, p.v);
  }

  const out: ResidualPoint[] = [];
  for (const p of actual) {
    if (p.v === null || !Number.isFinite(p.v)) continue;
    const f = forecastByT.get(p.t);
    if (f === undefined) continue;
    out.push({ t: p.t, residual: p.v - f });
  }
  return out;
}
