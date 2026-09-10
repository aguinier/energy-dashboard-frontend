import type { ForecastModel, LoadForecastBasis, MLAccuracyCoverage, MLHorizon } from '@/types';

/**
 * Per-model accuracy comparison rows.
 *
 * The failure mode this module exists to prevent is specific: catboost and
 * xgboost cover DISJOINT country sets (measured 2026-08-05 on `load`: catboost
 * for 21 countries, xgboost for AT/BE/FR, zero countries with both). So for any
 * one country, roughly half the registered models legitimately have nothing —
 * and a comparison panel that renders "no coverage" as a 0, an empty bar, or a
 * blank cell says the opposite of the truth: that the model was flawless.
 *
 * Two invariants hold for every row this module emits:
 *
 *   1. `metrics` is non-null ONLY when at least one forecast/actual pair was
 *      measured. Zero pairs never produces a number, of any kind.
 *   2. `metrics === null` if and only if `note !== null`. A row without numbers
 *      always carries a sentence saying why.
 *
 * Nothing here derives, scales or interpolates a figure. This codebase once
 * fabricated D+3/D+5/D+7 bars by multiplying a measured D+1 error by fixed
 * factors; every number below comes from a server measurement or is absent.
 */

/** Aggregate accuracy over a window. Every null means "not measurable", never zero. */
export interface MeasuredMetrics {
  mae: number | null;
  mape: number | null;
  rmse: number | null;
  dataPoints: number;
  /** Points MAPE was computed over; <= dataPoints. */
  mapeSamples: number;
}

/**
 * What one model's accuracy query produced.
 *
 * `coverage` is the server's classification and is available for ml models
 * only — `/ml-accuracy` returns it, the TSO accuracy route does not. Its
 * absence is why `no_measured_points` exists as a separate row state below.
 */
export type ModelMeasurement =
  | { status: 'loading' }
  | { status: 'error' }
  /** This client has no accuracy route for that model's source on this forecast type. */
  | { status: 'unsupported' }
  | {
      status: 'ok';
      metrics: MeasuredMetrics;
      coverage?: MLAccuracyCoverage;
      /**
       * The server's verdict on whether this model's forecast and the actuals
       * measure the same quantity (ABL-277). Carried by BOTH providers on
       * `load` — by the TSO accuracy route since ABL-277 and by `/ml-accuracy`
       * since ABL-628, because the finding is a property of the country's
       * realized series and so binds our own model exactly as it binds the
       * TSO's. Absent on every other forecast type: no verdict here means
       * "the question does not arise", never "comparable".
       */
      basis?: LoadForecastBasis;
      basisNote?: string | null;
    };

/**
 * The part of either accuracy response this comparison reads.
 *
 * `/ml-accuracy` and `/tso-forecast/accuracy/load/:cc` agree on `metrics`
 * (the ml one carries an extra `bias` nobody here reads); only the ml one
 * carries `coverage`.
 */
export interface AccuracyResultLike {
  metrics?: (MeasuredMetrics & { basis?: LoadForecastBasis; basisNote?: string | null }) | null;
  coverage?: MLAccuracyCoverage;
}

/**
 * A React Query result for one model, narrowed to a measurement.
 *
 * Kept here rather than inline in the hook so the mapping is testable against
 * real recorded responses. The order matters: an error is reported as an error
 * and never as an absence of data, because "the request failed" and "this model
 * has nothing for this country" are different answers and only one of them is
 * about the model.
 */
export function measurementFromQuery(query: {
  isError: boolean;
  data?: AccuracyResultLike;
}): ModelMeasurement {
  if (query.isError) return { status: 'error' };
  if (!query.data) return { status: 'loading' };

  const { metrics, coverage } = query.data;
  // A 200 whose body we do not recognise (the API serves an HTML error page
  // for 4xx whenever client/dist exists) is a failure, not an empty window.
  if (metrics == null) return { status: 'error' };

  return {
    status: 'ok',
    ...(coverage ? { coverage } : {}),
    ...(metrics.basis ? { basis: metrics.basis, basisNote: metrics.basisNote ?? null } : {}),
    metrics: {
      mae: metrics.mae,
      mape: metrics.mape,
      rmse: metrics.rmse,
      dataPoints: metrics.dataPoints,
      mapeSamples: metrics.mapeSamples,
    },
  };
}

export type ModelRowState =
  | 'measured'
  /** The server confirmed this model has no forecast rows here at all. */
  | 'no_model_coverage'
  /** It forecast this window, but no actual has landed against it yet. */
  | 'no_paired_actuals'
  /** Nothing paired, and no classification to say which of the two it was. */
  | 'no_measured_points'
  /**
   * Points paired in quantity, but the forecast and the actuals measure
   * different quantities, so their difference is not error (ABL-277).
   * Distinct from every state above: this is not an absence of data.
   */
  | 'divergent_basis'
  | 'unsupported'
  | 'loading'
  | 'error';

export interface ModelComparisonRow {
  id: string;
  label: string;
  /**
   * What this row's numbers measure. Never blank for a measurable model — an
   * accuracy figure without a stated horizon is not comparable to another one.
   */
  horizon: string;
  state: ModelRowState;
  /** Non-null only when `state === 'measured'`. Individual fields may still be null. */
  metrics: MeasuredMetrics | null;
  /** Why this row has no numbers. Non-null exactly when `metrics` is null. */
  note: string | null;
}

function horizonLabel(model: ForecastModel, mlHorizon: MLHorizon): string {
  if (model.source !== 'tso') return `D+${mlHorizon}`;
  if (model.tsoHorizon === 'week_ahead') return 'D+7';
  if (model.tsoHorizon === 'day_ahead') return 'D+1';
  return '—';
}

/**
 * One row per registered model, in registry order.
 *
 * Driven entirely by `models` — the registry as the server reports it — so a
 * model added to `forecastModels.ts` appears here with no client change. A
 * model with no entry in `measurements` is still rendered, as `loading`; it is
 * never dropped, because a silently missing row reads as "this model was not
 * considered" when it was.
 */
export function buildModelComparisonRows(
  models: ForecastModel[] | undefined,
  measurements: Record<string, ModelMeasurement | undefined>,
  opts: { mlHorizon: MLHorizon; countryCode: string },
): ModelComparisonRow[] {
  const cc = opts.countryCode.toUpperCase();

  return (models ?? []).map((model) => {
    const base = {
      id: model.id,
      label: model.label,
      horizon: horizonLabel(model, opts.mlHorizon),
    };
    const measurement = measurements[model.id];

    if (!measurement || measurement.status === 'loading') {
      return { ...base, state: 'loading' as const, metrics: null, note: 'Measuring…' };
    }

    if (measurement.status === 'error') {
      return {
        ...base,
        state: 'error' as const,
        metrics: null,
        note: 'Could not be measured — the accuracy request failed.',
      };
    }

    if (measurement.status === 'unsupported') {
      return {
        ...base,
        state: 'unsupported' as const,
        metrics: null,
        note: 'No accuracy endpoint is wired for this model here.',
      };
    }

    const { metrics, coverage } = measurement;

    // Checked before the zero-pairs branch below, because a divergent basis is
    // not an absence: the points paired, the server just cannot attribute the
    // difference to forecast skill. Passing it through as `measured` would
    // print a row of em-dashes beside a healthy sample count — the same
    // "cannot tell this apart from a sparse measurement" failure the
    // zero-pairs branch exists to prevent.
    if (measurement.basis === 'divergent_basis') {
      return {
        ...base,
        state: 'divergent_basis' as const,
        metrics: null,
        note:
          measurement.basisNote ??
          `Not measurable — this forecast and ${cc}'s realized load measure different quantities.`,
      };
    }

    // Zero paired points is the whole point of this module. `metrics` at this
    // stage is all nulls and zeros server-side; passing it through would print
    // "MAE — / MAPE — / samples 0", which a reader scanning a comparison table
    // cannot tell apart from a measured row that happened to be sparse.
    if (metrics.dataPoints <= 0) {
      if (coverage === 'no_model_coverage') {
        return {
          ...base,
          state: 'no_model_coverage' as const,
          metrics: null,
          note: `No data — this model does not forecast ${cc}.`,
        };
      }
      if (coverage === 'no_paired_actuals') {
        return {
          ...base,
          state: 'no_paired_actuals' as const,
          metrics: null,
          note: `No data — it forecast this window for ${cc}, but no actual has landed against it yet.`,
        };
      }
      return {
        ...base,
        state: 'no_measured_points' as const,
        metrics: null,
        note: `No data — no forecast/actual pairs for ${cc} in this window.`,
      };
    }

    return { ...base, state: 'measured' as const, metrics, note: null };
  });
}

export interface ComparisonSummary {
  /** Rows backed by at least one measured pair. */
  measuredCount: number;
  /** Distinct horizons among the measured rows, in row order. */
  horizons: string[];
  /** Two or more measured rows share a horizon, so a like-for-like read exists. */
  comparable: boolean;
  /** Statements the panel must show alongside the table for it to be read correctly. */
  caveats: string[];
}

/**
 * What the table as a whole does and does not support.
 *
 * `comparable` is deliberately strict. With disjoint model coverage, one
 * measured row is the common case for a given country, and a "comparison" of
 * one model against nothing invites the reader to treat the single number as a
 * verdict. Rows measured at different horizons are not comparable to each other
 * either — a D+7 error is expected to exceed a D+1 error, so ranking across
 * them would report the horizon, not the model.
 */
export function summariseComparison(rows: ModelComparisonRow[]): ComparisonSummary {
  const measured = rows.filter((r) => r.state === 'measured');
  const horizons = [...new Set(measured.map((r) => r.horizon))];

  const perHorizon = new Map<string, number>();
  for (const r of measured) perHorizon.set(r.horizon, (perHorizon.get(r.horizon) ?? 0) + 1);
  const comparable = [...perHorizon.values()].some((n) => n >= 2);

  const caveats: string[] = [];

  if (measured.length === 1) {
    caveats.push(
      'Only one model has measured accuracy for this country in this window, so there is nothing to compare it against.',
    );
  } else if (measured.length >= 2 && !comparable) {
    caveats.push(
      'No two measured models share a horizon. A D+7 error is expected to exceed a D+1 error, so these figures rank the horizon, not the model.',
    );
  } else if (horizons.length > 1) {
    caveats.push('Horizons differ — only rows sharing a horizon are comparable.');
  }

  if (measured.some((r) => r.metrics!.mape == null)) {
    caveats.push(
      'A dash under MAPE means no point in the window had a positive actual, so a percentage error is undefined. It does not mean zero error.',
    );
  } else if (measured.some((r) => r.metrics!.mapeSamples < r.metrics!.dataPoints)) {
    caveats.push(
      'MAPE covers fewer points than Samples where an actual was zero or negative — a percentage error is undefined there.',
    );
  }

  return { measuredCount: measured.length, horizons, comparable, caveats };
}
