/**
 * One categorical {colour, dash} token per forecast model, for Load and
 * Price's multi-model overlay (ABL-204). Design source: ABL-205's "Multi-model
 * forecast overlay design recommendation" — the Board asked for several
 * forecast models comparable on one chart, and the Design Consultant's pass
 * on that (net position's shipped ABL-203 baseline) specified this exact
 * table:
 *
 *   forecastA  teal       #2C8A6B  dash 8 3
 *   forecastB  violet     #756BB1  dash 2 2
 *   forecastC  amber      #C99A2A  dash 12 3 2 3
 *   forecastD  terracotta #8E3D2C  dash 6 2
 *
 * Keyed by stable registry model id (`server/src/config/forecastModels.ts`),
 * never by selection order or response order — the design doc is explicit
 * that order-based assignment would make "which model is this" shift under
 * the user as they check/uncheck boxes. `load`'s four registered models
 * (catboost, xgboost, tso-d1, tso-d7) get one slot each; `price` only ever
 * registers catboost/xgboost, so it uses the first two and never touches C/D.
 *
 * Deliberately NOT `lib/dataScale.ts`'s teal->amber->terracotta ramp: that
 * ramp encodes a WAPE rank (clean -> dirty), and reusing it here would read
 * as "this model is better" for models nobody has measured against each
 * other. Violet (`forecastB`) exists specifically so the set reads as
 * categorical rather than a value scale — see the design doc.
 *
 * Distinguishing by dash pattern (not colour alone) matters more here than it
 * did for net position's `netPositionModelColors.ts`: models trained on the
 * same data routinely predict near-identical values, so two lines can overlap
 * almost exactly — the normal case, not an edge case. A shared dash rhythm
 * would make the far line invisible under the near one; different rhythms let
 * each show through the other's gaps.
 */
export interface ForecastLineToken {
  color: string;
  /** SVG stroke-dasharray. */
  dash: string;
}

const FORECAST_LINE_TOKENS: Record<string, ForecastLineToken> = {
  catboost: { color: '#2C8A6B', dash: '8 3' },
  xgboost: { color: '#756BB1', dash: '2 2' },
  'tso-d1': { color: '#C99A2A', dash: '12 3 2 3' },
  'tso-d7': { color: '#8E3D2C', dash: '6 2' },
};

/** Neutral fallback for a model id the table above has no slot for. */
const FALLBACK_TOKEN: ForecastLineToken = { color: '#6B6459', dash: '4 4' };

export function forecastLineToken(modelId: string): ForecastLineToken {
  return FORECAST_LINE_TOKENS[modelId] ?? FALLBACK_TOKEN;
}
