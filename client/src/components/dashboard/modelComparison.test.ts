import { describe, it, expect } from 'vitest';
import {
  buildModelComparisonRows,
  measurementFromQuery,
  summariseComparison,
  type MeasuredMetrics,
  type ModelMeasurement,
} from './modelComparison';
import type { ForecastModel } from '@/types';

// The `load` registry as forecastModels.ts declares it (server/src/config/forecastModels.ts:53).
const CATBOOST: ForecastModel = {
  id: 'catboost', label: 'able-ml · catboost', source: 'ml', modelName: 'catboost',
};
const XGBOOST: ForecastModel = {
  id: 'xgboost', label: 'able-ml · xgboost', source: 'ml', modelName: 'xgboost',
};
const TSO_D1: ForecastModel = {
  id: 'tso-d1', label: 'ENTSO-E TSO · D+1', source: 'tso', tsoHorizon: 'day_ahead',
};
const TSO_D7: ForecastModel = {
  id: 'tso-d7', label: 'ENTSO-E TSO · D+7', source: 'tso', tsoHorizon: 'week_ahead',
};
const LOAD_MODELS = [CATBOOST, XGBOOST, TSO_D1, TSO_D7];

const OPTS = { mlHorizon: 1 as const, countryCode: 'FR' };

function metrics(over: Partial<MeasuredMetrics> = {}): MeasuredMetrics {
  return { mae: 433.91, mape: 5.41, rmse: 522.92, dataPoints: 169, mapeSamples: 169, ...over };
}

/** What the server returns for a model that does not serve the country at all. */
const NO_COVERAGE: ModelMeasurement = {
  status: 'ok',
  coverage: 'no_model_coverage',
  metrics: { mae: null, mape: null, rmse: null, dataPoints: 0, mapeSamples: 0 },
};

describe('buildModelComparisonRows', () => {
  it('renders one row per registered model, in registry order', () => {
    const rows = buildModelComparisonRows(LOAD_MODELS, {}, OPTS);
    expect(rows.map((r) => r.id)).toEqual(['catboost', 'xgboost', 'tso-d1', 'tso-d7']);
  });

  it('keeps a model with no measurement yet as a loading row rather than dropping it', () => {
    const rows = buildModelComparisonRows(LOAD_MODELS, {}, OPTS);
    expect(rows.every((r) => r.state === 'loading')).toBe(true);
    expect(rows.every((r) => r.metrics === null)).toBe(true);
  });

  // The issue's stated bar: no coverage must read as "no data", never as a
  // perfect score, an empty bar, or a zero.
  it('gives a model with no coverage no metrics at all', () => {
    const rows = buildModelComparisonRows(LOAD_MODELS, { xgboost: NO_COVERAGE }, OPTS);
    const xgb = rows.find((r) => r.id === 'xgboost')!;
    expect(xgb.state).toBe('no_model_coverage');
    expect(xgb.metrics).toBeNull();
    expect(xgb.note).toBe('No data — this model does not forecast FR.');
  });

  it('never lets a zero-sample window through as a number, even when the server sent zeros', () => {
    const zeroed: ModelMeasurement = {
      status: 'ok',
      coverage: 'no_model_coverage',
      // A server that regressed to zeros instead of nulls must still not print them.
      metrics: { mae: 0, mape: 0, rmse: 0, dataPoints: 0, mapeSamples: 0 },
    };
    const rows = buildModelComparisonRows([XGBOOST], { xgboost: zeroed }, OPTS);
    expect(rows[0].metrics).toBeNull();
    expect(rows[0].state).toBe('no_model_coverage');
  });

  it('separates "forecast but no actuals yet" from "does not serve this country"', () => {
    const pending: ModelMeasurement = {
      status: 'ok',
      coverage: 'no_paired_actuals',
      metrics: { mae: null, mape: null, rmse: null, dataPoints: 0, mapeSamples: 0 },
    };
    const rows = buildModelComparisonRows([CATBOOST], { catboost: pending }, OPTS);
    expect(rows[0].state).toBe('no_paired_actuals');
    expect(rows[0].note).toContain('no actual has landed');
  });

  it('falls back to an unclassified empty window when no coverage was reported', () => {
    // The TSO accuracy route returns metrics without a coverage classification,
    // so an empty window there must not be reported as "does not forecast FR" —
    // that is a claim we did not verify.
    const empty: ModelMeasurement = {
      status: 'ok',
      metrics: { mae: null, mape: null, rmse: null, dataPoints: 0, mapeSamples: 0 },
    };
    const rows = buildModelComparisonRows([TSO_D1], { 'tso-d1': empty }, OPTS);
    expect(rows[0].state).toBe('no_measured_points');
    expect(rows[0].note).toBe('No data — no forecast/actual pairs for FR in this window.');
  });

  it('passes measured metrics through verbatim', () => {
    const rows = buildModelComparisonRows(
      [CATBOOST],
      { catboost: { status: 'ok', coverage: 'served', metrics: metrics() } },
      OPTS,
    );
    expect(rows[0].state).toBe('measured');
    expect(rows[0].metrics).toEqual(metrics());
    expect(rows[0].note).toBeNull();
  });

  it('keeps a measured MAPE of null as null on a row that has samples', () => {
    // Solar overnight: every actual is legitimately zero, so MAE is measurable
    // and MAPE is not. The row is measured; the cell is empty.
    const rows = buildModelComparisonRows(
      [CATBOOST],
      {
        catboost: {
          status: 'ok',
          coverage: 'served',
          metrics: metrics({ mape: null, mapeSamples: 0 }),
        },
      },
      OPTS,
    );
    expect(rows[0].state).toBe('measured');
    expect(rows[0].metrics!.mape).toBeNull();
  });

  it('keeps a genuinely measured zero as zero', () => {
    const rows = buildModelComparisonRows(
      [CATBOOST],
      {
        catboost: {
          status: 'ok',
          coverage: 'served',
          metrics: metrics({ mae: 0, mape: 0, rmse: 0, dataPoints: 24, mapeSamples: 24 }),
        },
      },
      OPTS,
    );
    expect(rows[0].state).toBe('measured');
    expect(rows[0].metrics!.mae).toBe(0);
  });

  it('reports a failed request as an error, not as an absence of data', () => {
    const rows = buildModelComparisonRows([CATBOOST], { catboost: { status: 'error' } }, OPTS);
    expect(rows[0].state).toBe('error');
    expect(rows[0].note).toContain('request failed');
  });

  it('still lists a model this panel cannot measure', () => {
    const rows = buildModelComparisonRows([TSO_D1], { 'tso-d1': { status: 'unsupported' } }, OPTS);
    expect(rows[0].state).toBe('unsupported');
    expect(rows[0].metrics).toBeNull();
  });

  it('labels each row with the horizon its numbers cover', () => {
    const rows = buildModelComparisonRows(LOAD_MODELS, {}, OPTS);
    expect(rows.map((r) => r.horizon)).toEqual(['D+1', 'D+1', 'D+1', 'D+7']);
  });

  it('labels ml rows with the horizon actually requested', () => {
    const rows = buildModelComparisonRows([CATBOOST], {}, { ...OPTS, mlHorizon: 2 });
    expect(rows[0].horizon).toBe('D+2');
  });

  it('holds the metrics/note invariant on every state', () => {
    const rows = buildModelComparisonRows(LOAD_MODELS, {
      catboost: { status: 'ok', coverage: 'served', metrics: metrics() },
      xgboost: NO_COVERAGE,
      'tso-d1': { status: 'error' },
      'tso-d7': { status: 'unsupported' },
    }, OPTS);
    for (const row of rows) {
      expect(row.metrics === null).toBe(row.note !== null);
    }
  });

  it('returns nothing when the registry has not loaded', () => {
    expect(buildModelComparisonRows(undefined, {}, OPTS)).toEqual([]);
  });
});

describe('measurementFromQuery', () => {
  it('reports a failed request as an error', () => {
    expect(measurementFromQuery({ isError: true })).toEqual({ status: 'error' });
  });

  it('reports a query with no data yet as loading', () => {
    expect(measurementFromQuery({ isError: false })).toEqual({ status: 'loading' });
  });

  it('treats a 200 with no metrics as a failure, not an empty window', () => {
    // The API serves an HTML error page for 4xx whenever client/dist exists,
    // so an unparseable body must not read as "this model has no data".
    expect(measurementFromQuery({ isError: false, data: {} })).toEqual({ status: 'error' });
  });

  it('carries the ml coverage classification through', () => {
    // Recorded from a local server on 2026-08-05:
    //   GET /api/forecast-comparison/FR/ml-accuracy?forecastType=load&horizon=1&model=catboost
    const m = measurementFromQuery({
      isError: false,
      data: {
        metrics: { mae: null, mape: null, rmse: null, dataPoints: 0, mapeSamples: 0 },
        coverage: 'no_model_coverage',
      },
    });
    expect(m).toEqual({
      status: 'ok',
      coverage: 'no_model_coverage',
      metrics: { mae: null, mape: null, rmse: null, dataPoints: 0, mapeSamples: 0 },
    });
  });

  it('leaves a TSO result unclassified, since that route reports no coverage', () => {
    // Recorded: GET /api/tso-forecast/accuracy/load/FR?model=tso-d7
    const m = measurementFromQuery({
      isError: false,
      data: { metrics: { mae: 1747.25, mape: 4.11, rmse: 2039.87, dataPoints: 7, mapeSamples: 7 } },
    });
    expect(m).toEqual({
      status: 'ok',
      metrics: { mae: 1747.25, mape: 4.11, rmse: 2039.87, dataPoints: 7, mapeSamples: 7 },
    });
    expect('coverage' in m).toBe(false);
  });
});

// End-to-end over the four responses a `load` comparison actually produces,
// recorded from a local server against energy_dashboard.db on 2026-08-05 for
// the window 2026-07-29T17:00Z .. 2026-08-05T17:00Z. FR and DE are the two
// halves of the disjoint-coverage case this panel exists to get right.
describe('a recorded FR/DE load comparison', () => {
  const FR = {
    catboost: { metrics: { mae: null, mape: null, rmse: null, dataPoints: 0, mapeSamples: 0 }, coverage: 'no_model_coverage' as const },
    xgboost: { metrics: { mae: 2845.56, mape: 6.62, rmse: 3485.03, dataPoints: 151, mapeSamples: 151 }, coverage: 'served' as const },
    'tso-d1': { metrics: { mae: 653.13, mape: 1.48, rmse: 804.69, dataPoints: 151, mapeSamples: 151 } },
    'tso-d7': { metrics: { mae: 1747.25, mape: 4.11, rmse: 2039.87, dataPoints: 7, mapeSamples: 7 } },
  };
  const DE = {
    catboost: { metrics: { mae: 4383.39, mape: 9.25, rmse: 5250.16, dataPoints: 151, mapeSamples: 151 }, coverage: 'served' as const },
    xgboost: { metrics: { mae: null, mape: null, rmse: null, dataPoints: 0, mapeSamples: 0 }, coverage: 'no_model_coverage' as const },
    'tso-d1': { metrics: { mae: 1941.09, mape: 3.99, rmse: 2396.35, dataPoints: 151, mapeSamples: 151 } },
    'tso-d7': { metrics: { mae: 6417.23, mape: 14.82, rmse: 7354, dataPoints: 7, mapeSamples: 7 } },
  };

  const rowsFor = (responses: Record<string, unknown>, cc: string) =>
    buildModelComparisonRows(
      LOAD_MODELS,
      Object.fromEntries(
        LOAD_MODELS.map((m) => [
          m.id,
          measurementFromQuery({ isError: false, data: responses[m.id] as never }),
        ]),
      ),
      { mlHorizon: 1, countryCode: cc },
    );

  it('shows the model that serves FR and says the other has no data', () => {
    const rows = rowsFor(FR, 'FR');
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(byId.xgboost.state).toBe('measured');
    expect(byId.xgboost.metrics!.mape).toBe(6.62);

    expect(byId.catboost.state).toBe('no_model_coverage');
    expect(byId.catboost.metrics).toBeNull();
    expect(byId.catboost.note).toBe('No data — this model does not forecast FR.');
  });

  it('is the mirror image in DE', () => {
    const byId = Object.fromEntries(rowsFor(DE, 'DE').map((r) => [r.id, r]));
    expect(byId.catboost.state).toBe('measured');
    expect(byId.catboost.metrics!.mape).toBe(9.25);
    expect(byId.xgboost.state).toBe('no_model_coverage');
    expect(byId.xgboost.metrics).toBeNull();
  });

  it('never lets the uncovered model look like the most accurate one', () => {
    for (const [responses, cc] of [[FR, 'FR'], [DE, 'DE']] as const) {
      const measured = rowsFor(responses, cc).filter((r) => r.state === 'measured');
      // The uncovered model is not among the measured rows at all, so it cannot
      // win a comparison by having the lowest (absent) error.
      expect(measured.map((r) => r.id).sort()).toEqual(
        cc === 'FR' ? ['tso-d1', 'tso-d7', 'xgboost'] : ['catboost', 'tso-d1', 'tso-d7'],
      );
      expect(measured.every((r) => r.metrics!.dataPoints > 0)).toBe(true);
    }
  });

  it('flags that the D+1 and D+7 rows are not comparable to each other', () => {
    const summary = summariseComparison(rowsFor(FR, 'FR'));
    expect(summary.measuredCount).toBe(3);
    expect(summary.horizons).toEqual(['D+1', 'D+7']);
    expect(summary.comparable).toBe(true); // xgboost + tso-d1 both at D+1
    expect(summary.caveats[0]).toContain('only rows sharing a horizon are comparable');
  });
});

describe('summariseComparison', () => {
  const measuredRow = (id: string, horizon: string, m: MeasuredMetrics = metrics()) => ({
    id, label: id, horizon, state: 'measured' as const, metrics: m, note: null,
  });

  it('does not call a single measured model a comparison', () => {
    const rows = buildModelComparisonRows(LOAD_MODELS, {
      catboost: { status: 'ok', coverage: 'served', metrics: metrics() },
      xgboost: NO_COVERAGE,
      'tso-d1': NO_COVERAGE,
      'tso-d7': NO_COVERAGE,
    }, OPTS);
    const summary = summariseComparison(rows);
    expect(summary.measuredCount).toBe(1);
    expect(summary.comparable).toBe(false);
    expect(summary.caveats[0]).toContain('nothing to compare it against');
  });

  it('is comparable once two measured rows share a horizon', () => {
    const summary = summariseComparison([measuredRow('a', 'D+1'), measuredRow('b', 'D+1')]);
    expect(summary.comparable).toBe(true);
  });

  it('is not comparable when the two measured rows sit at different horizons', () => {
    const summary = summariseComparison([measuredRow('a', 'D+1'), measuredRow('b', 'D+7')]);
    expect(summary.comparable).toBe(false);
    expect(summary.caveats[0]).toContain('rank the horizon, not the model');
  });

  it('warns that horizons differ when some rows are comparable and some are not', () => {
    const summary = summariseComparison([
      measuredRow('a', 'D+1'), measuredRow('b', 'D+1'), measuredRow('c', 'D+7'),
    ]);
    expect(summary.comparable).toBe(true);
    expect(summary.horizons).toEqual(['D+1', 'D+7']);
    expect(summary.caveats[0]).toContain('only rows sharing a horizon are comparable');
  });

  it('says a dash under MAPE is not a zero', () => {
    const summary = summariseComparison([
      measuredRow('a', 'D+1', metrics({ mape: null, mapeSamples: 0 })),
      measuredRow('b', 'D+1'),
    ]);
    expect(summary.caveats.some((c) => c.includes('does not mean zero error'))).toBe(true);
  });

  it('explains a MAPE sample count below the point count', () => {
    const summary = summariseComparison([
      measuredRow('a', 'D+1', metrics({ mapeSamples: 120 })),
      measuredRow('b', 'D+1'),
    ]);
    expect(summary.caveats.some((c) => c.includes('MAPE covers fewer points'))).toBe(true);
  });

  it('has nothing to caveat when nothing was measured', () => {
    const rows = buildModelComparisonRows(LOAD_MODELS, {
      catboost: NO_COVERAGE, xgboost: NO_COVERAGE, 'tso-d1': NO_COVERAGE, 'tso-d7': NO_COVERAGE,
    }, OPTS);
    const summary = summariseComparison(rows);
    expect(summary.measuredCount).toBe(0);
    expect(summary.caveats).toEqual([]);
  });
});

describe('divergent forecast basis (ABL-277)', () => {
  // What /tso-forecast/accuracy/load/NL returns: every point paired, but the
  // realized series and the TSO forecast measure different quantities, so the
  // server withholds the error measures and says why.
  const NL_BASIS_NOTE =
    'Not measurable here. ENTSO-E publishes the Dutch realized load net of ' +
    'behind-the-meter solar and the day-ahead forecast without it, so the ' +
    'difference between them is a definitional gap, not forecast error.';

  const NL_TSO = measurementFromQuery({
    isError: false,
    data: {
      metrics: {
        mae: null, mape: null, rmse: null, dataPoints: 168, mapeSamples: 168,
        basis: 'divergent_basis', basisNote: NL_BASIS_NOTE,
      },
    },
  });

  // What /forecast-comparison/NL/ml-accuracy?forecastType=load returns since
  // ABL-628: the same verdict on our OWN model, since the finding is about
  // what ENTSO-E nets out of NL's realized load and does not care who forecast
  // it. Shaped as `fetchMLForecastAccuracy` resolves it (api.ts:469) —
  // `coverage` beside `metrics`, which the TSO route does not carry.
  const NL_ML = measurementFromQuery({
    isError: false,
    data: {
      coverage: 'served',
      metrics: {
        mae: null, mape: null, rmse: null, dataPoints: 168, mapeSamples: 168,
        basis: 'divergent_basis', basisNote: NL_BASIS_NOTE,
      },
    },
  });

  it('carries the server verdict through the measurement mapping', () => {
    expect(NL_TSO).toMatchObject({ status: 'ok', basis: 'divergent_basis', basisNote: NL_BASIS_NOTE });
  });

  it('carries it from the ml route too, which also sends a coverage class', () => {
    expect(NL_ML).toMatchObject({
      status: 'ok', coverage: 'served', basis: 'divergent_basis', basisNote: NL_BASIS_NOTE,
    });
  });

  // The reported symptom of ABL-627, as this panel rendered it: tso-d1 said
  // "Not measurable — …" while catboost printed a real MAPE one row below it,
  // same country, same window, same forecast type. Both rows must now withhold.
  it('withholds our own model\'s row as well as the TSO\'s (ABL-628)', () => {
    const rows = buildModelComparisonRows(
      LOAD_MODELS, { 'tso-d1': NL_TSO, catboost: NL_ML }, { mlHorizon: 1, countryCode: 'NL' },
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(byId.catboost.state).toBe('divergent_basis');
    expect(byId.catboost.metrics).toBeNull();
    expect(byId.catboost.note).toBe(NL_BASIS_NOTE);
    // The ml row is the D+1 one, not the TSO row wearing its label.
    expect(byId.catboost.horizon).toBe('D+1');
    // Neither provider is measurable, so nothing is left to rank or compare.
    expect(byId['tso-d1'].state).toBe('divergent_basis');
    expect(summariseComparison(rows).measuredCount).toBe(0);
  });

  // `coverage: 'served'` with 168 paired points is precisely the shape that
  // reaches the `measured` branch on every other forecast type. The verdict,
  // not the sample count, is what withholds this row.
  it('is not mistaken for an empty ml window — the points paired, the claim did not', () => {
    const rows = buildModelComparisonRows(
      LOAD_MODELS, { catboost: NL_ML, xgboost: NO_COVERAGE }, { mlHorizon: 1, countryCode: 'NL' },
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.catboost.state).toBe('divergent_basis');
    expect(byId.xgboost.state).toBe('no_model_coverage');
    expect(byId.catboost.note).not.toEqual(byId.xgboost.note);
  });

  // The type gate, on the client side of the wire: `/ml-accuracy` sends no
  // `basis` key at all for NL price (the finding is about load), so the row
  // must stay measured. Over-suppressing here would blank the country
  // document's figure-2 accuracy badge, which reads the ml side of `/summary`
  // for price (CountryDocumentView.tsx:548) and has no TSO fallback —
  // ENTSO-E publishes no day-ahead price forecast.
  it('leaves NL price measured — no verdict on the wire means the question does not arise', () => {
    const rows = buildModelComparisonRows(
      [CATBOOST],
      {
        catboost: measurementFromQuery({
          isError: false,
          data: { coverage: 'served', metrics: metrics({ mape: 7.93 }) },
        }),
      },
      { mlHorizon: 1, countryCode: 'NL' },
    );
    expect(rows[0].state).toBe('measured');
    expect(rows[0].metrics?.mape).toBe(7.93);
    expect(rows[0].note).toBeNull();
  });

  it('does not render as a measured row, despite 168 paired points', () => {
    // The failure this prevents: all-em-dash metric cells beside "168 samples",
    // which reads as a sparse measurement rather than as no measurement.
    const rows = buildModelComparisonRows(
      LOAD_MODELS, { 'tso-d1': NL_TSO }, { mlHorizon: 1, countryCode: 'NL' },
    );
    const row = rows.find((r) => r.id === 'tso-d1')!;
    expect(row.state).toBe('divergent_basis');
    expect(row.metrics).toBeNull();
    expect(row.note).toBe(NL_BASIS_NOTE);
  });

  it('is not counted as comparable, so no ranking is built on it', () => {
    const rows = buildModelComparisonRows(
      LOAD_MODELS, { 'tso-d1': NL_TSO, catboost: { status: 'ok', metrics: metrics() } },
      { mlHorizon: 1, countryCode: 'NL' },
    );
    expect(summariseComparison(rows).measuredCount).toBe(1);
  });

  it('is distinguished from "no coverage" — the points exist, the claim does not', () => {
    const rows = buildModelComparisonRows(
      LOAD_MODELS, { 'tso-d1': NL_TSO, xgboost: NO_COVERAGE },
      { mlHorizon: 1, countryCode: 'NL' },
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['tso-d1'].state).toBe('divergent_basis');
    expect(byId.xgboost.state).toBe('no_model_coverage');
    expect(byId['tso-d1'].note).not.toEqual(byId.xgboost.note);
  });

  it('leaves a comparable country measured — the rule is per country, not global', () => {
    const rows = buildModelComparisonRows(
      LOAD_MODELS,
      { 'tso-d1': measurementFromQuery({ isError: false, data: { metrics: { ...metrics(), basis: 'comparable', basisNote: null } } }) },
      { mlHorizon: 1, countryCode: 'DE' },
    );
    const row = rows.find((r) => r.id === 'tso-d1')!;
    expect(row.state).toBe('measured');
    expect(row.metrics?.mape).toBe(5.41);
  });
});
