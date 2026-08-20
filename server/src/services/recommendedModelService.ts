/**
 * Measure every registered model for one (country, forecast type) pair over
 * the rolling accuracy window, and name the best available one.
 *
 * The ranking rule, the window and the qualification bars all live in
 * `bestForecastModel.ts` as pure arithmetic. This module is the part that
 * touches the database: it decides *which* accuracy path answers for a given
 * (source, forecast type) and gathers the numbers to rank.
 *
 * ## No new accuracy machinery
 *
 * Every figure here comes from an accuracy function that already existed and
 * already serves an endpoint — `mlForecastService.getMLForecastAccuracy` for
 * our models, `tsoForecastService.getLoadForecastAccuracy` and
 * `getGenerationForecastAccuracy` for the ENTSO-E series. Nothing is
 * materialised and no table is added: measured on the development replica, a
 * single candidate costs 1-20 ms, so `load`'s four candidates cost ~35 ms in
 * total and the route caches the answer for 30 minutes on top of that. That is
 * why this fits the "prefer the accuracy the server already computes" bar
 * rather than needing the follow-up the issue reserved for a new store.
 *
 * ## Two rules that would be easy to get wrong
 *
 * **The ML side is pinned to D+1.** Unpinned, `getMLForecastAccuracy` blends
 * every stored horizon (2-63h), so a model whose runs skew short would beat
 * one whose runs skew long for reasons that are not about the model — the same
 * trap `useModelComparison.ts` documents on the client. Pinning D+1 also makes
 * the comparison against the ENTSO-E *day-ahead* series a like-for-like one.
 *
 * **The TSO load path goes through `applyLoadForecastBasis`.** For a country
 * where realized load and the TSO forecast measure different quantities — NL,
 * whose realized series is net of behind-the-meter solar and whose forecast is
 * not (ABL-277) — that returns `wape: null`, so NL's TSO series is excluded
 * from the ranking as `unmeasurable_wape` rather than ranked on a 27% figure
 * that is a definitional gap. Calling `calculateMetrics` directly here would
 * have bypassed that suppression and auto-selected on it, which is exactly the
 * confidently-wrong-number failure this dashboard exists to avoid. Verified on
 * the replica: NL's TSO D+1 comes back `divergent_basis` with null measures
 * while its point count stays truthful at 721.
 */

import { getTypeConfig, type ForecastModel } from '../config/forecastModels.js';
import type { ForecastType } from '../types/index.js';
import {
  getMLForecastAccuracy,
  calculateMetrics as calculateMlMetrics,
} from './mlForecastService.js';
import {
  getLoadForecastAccuracy,
  getGenerationForecastAccuracy,
  calculateMetrics as calculateTsoMetrics,
} from './tsoForecastService.js';
import { applyLoadForecastBasis } from './loadForecastBasis.js';
import { actualsSourceFor } from './actualsSource.js';
import {
  ACCURACY_WINDOW_DAYS,
  countHoursCovered,
  rankCandidates,
  type MeasuredCandidate,
  type RankedCandidate,
} from './bestForecastModel.js';

/** Generation types the TSO accuracy route can answer for. */
const TSO_GENERATION_TYPES = ['solar', 'wind_onshore', 'wind_offshore'] as const;
type TsoGenerationType = (typeof TSO_GENERATION_TYPES)[number];

function isTsoGenerationType(t: string): t is TsoGenerationType {
  return (TSO_GENERATION_TYPES as readonly string[]).includes(t);
}

export interface RecommendedModel {
  /** Model id to display by default. */
  modelId: string;
  label: string;
  source: 'ml' | 'tso';
  /** The winning WAPE, or `null` when this is the no-history fallback. */
  wape: number | null;
  dataPoints: number;
  /**
   * `true` when nothing qualified and this is the type's hand-picked
   * `production` id — i.e. the pair resolves exactly as it did before this
   * existed. Load-bearing on the client: an unmeasured default must not be
   * presented as a measured one.
   */
  fallback: boolean;
  windowStart: string;
  windowEnd: string;
  windowDays: number;
  /** Every registered model with its own numbers, ranked ones first. */
  candidates: RankedCandidate[];
}

/** Window bounds, so the caller can echo back exactly what was measured. */
export function accuracyWindow(now: Date = new Date()): { start: string; end: string; hours: number } {
  const end = now;
  const start = new Date(end.getTime() - ACCURACY_WINDOW_DAYS * 24 * 3600 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    hours: ACCURACY_WINDOW_DAYS * 24,
  };
}

/**
 * Measure one registered model. Returns `notMeasurable` rather than a zero
 * when no accuracy path exists for its (source, type) — a model nobody can
 * score is a different thing from one that scored badly.
 */
function measure(
  model: ForecastModel,
  countryCode: string,
  forecastType: ForecastType,
  start: string,
  end: string,
): MeasuredCandidate {
  const base = { id: model.id, label: model.label, source: model.source };

  if (model.source === 'ml') {
    // No actuals source means nothing can be scored against — `net_position`
    // is the live case, and `getMLForecastAccuracy` *throws* rather than
    // returning nothing for it, so this guard is what keeps an unscorable
    // registered type answering with its production model instead of a 500.
    if (!model.modelName || !actualsSourceFor(forecastType)) {
      return { ...base, wape: null, dataPoints: 0, hoursCovered: 0, notMeasurable: true };
    }
    // Horizon pinned to D+1 — see the header.
    const points = getMLForecastAccuracy(
      countryCode, forecastType, start, end, 1, 'hourly', model.modelName,
    );
    const metrics = calculateMlMetrics(points);
    return {
      ...base,
      wape: metrics.wape,
      dataPoints: metrics.dataPoints,
      hoursCovered: countHoursCovered(points),
    };
  }

  if (forecastType === 'load') {
    const horizon = model.tsoHorizon ?? 'day_ahead';
    const points = getLoadForecastAccuracy(countryCode, start, end, horizon, 'hourly');
    // Basis suppression applied here, not skipped — see the header.
    const metrics = applyLoadForecastBasis(countryCode, calculateTsoMetrics(points));
    return {
      ...base,
      wape: metrics.wape,
      dataPoints: metrics.dataPoints,
      hoursCovered: countHoursCovered(points),
    };
  }

  if (isTsoGenerationType(forecastType)) {
    const points = getGenerationForecastAccuracy(countryCode, start, end, forecastType, 'hourly');
    const metrics = calculateTsoMetrics(points);
    return {
      ...base,
      wape: metrics.wape,
      dataPoints: metrics.dataPoints,
      hoursCovered: countHoursCovered(points),
    };
  }

  // A tso model registered for a type with no tso accuracy route. None exists
  // today; saying so beats scoring it zero if one is ever added.
  return { ...base, wape: null, dataPoints: 0, hoursCovered: 0, notMeasurable: true };
}

/**
 * The best available forecast for this pair, or the type's production model
 * when nothing has a measurable track record yet.
 *
 * Returns `undefined` only for an unknown forecast type — a registered type
 * always resolves to *something*, because a pair with no accuracy history has
 * to render rather than blank (issue acceptance criterion 4).
 */
export function getRecommendedModel(
  countryCode: string,
  forecastType: ForecastType,
  now: Date = new Date(),
): RecommendedModel | undefined {
  const cfg = getTypeConfig(forecastType);
  if (!cfg) return undefined;

  const upperCode = countryCode.toUpperCase();
  const { start, end, hours } = accuracyWindow(now);

  const measured = cfg.models.map((m) => measure(m, upperCode, forecastType, start, end));
  const { best, candidates } = rankCandidates(measured, hours, cfg.production);

  const window = { windowStart: start, windowEnd: end, windowDays: ACCURACY_WINDOW_DAYS, candidates };

  if (best) {
    return {
      modelId: best.id,
      label: best.label,
      source: best.source,
      wape: best.wape,
      dataPoints: best.dataPoints,
      fallback: false,
      ...window,
    };
  }

  // No history: resolve exactly as before this existed. `resolveModel`'s own
  // fallback chain (production, else first registered) is reused rather than
  // restated, so the two cannot drift.
  const production =
    cfg.models.find((m) => m.id === cfg.production) ?? cfg.models[0];
  if (!production) return undefined;

  return {
    modelId: production.id,
    label: production.label,
    source: production.source,
    wape: null,
    dataPoints: 0,
    fallback: true,
    ...window,
  };
}
