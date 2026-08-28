// @vitest-environment jsdom
//
// Component tests need a DOM; the rest of the suite is pure-module and runs in
// vitest's default node environment. The annotation above opts this file in on
// its own so the other test files keep running exactly as before.
//
// Regression guard for the bug fixed in b057f63: LoadTab gated its forecast
// overlay on `layers.ml/tso.enabled`, a store slice nothing wrote to and that
// defaulted to false. The picker fetched the forecast, the chart never drew it,
// and no selection could take effect. Nothing caught that, because the only
// thing that changed was which props reached the chart.
//
// Architecture note (post-ABL-204): checking any model in the multi-select
// picker sets selectedModelsByType and routes to LoadSelectionView; the
// single-model AbleLineChart path only activates when no model is pinned
// (modelSelection.length === 0). Tests that guard explicit ML/TSO selection
// therefore verify LoadSelectionView's entries, not AbleLineChart series.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { LoadTab } from './LoadTab';
import { WITHHELD_LEGEND_NOTE } from './forecastBasisNote';
import * as api from '@/services/api';
import { useDashboardStore } from '@/store/dashboardStore';

// The functional `localStorage` this file used to install for itself now comes
// from `src/test/setup.ts`, which does it for every test file rather than only
// this one (ABL-320). A setup file still runs before this module is imported,
// so it is ahead of the zustand persist middleware, which resolves storage at
// `dashboardStore` import time and never looks again.

// vi.mock factories run before the module body, so shared fixtures have to be
// hoisted alongside them rather than declared as ordinary consts below.
const fx = vi.hoisted(() => {
  const HOUR = 60 * 60 * 1000;
  const hour = Math.floor(Date.now() / HOUR) * HOUR;
  const iso = (offsetHours: number) => new Date(hour + offsetHours * HOUR).toISOString();

  // Distinct magic values per source: both ML and TSO land in the same
  // `forecast` field of the series, so the value is the only way to tell which
  // one the tab actually forwarded.
  const ML_VALUE = 1111;
  const TSO_VALUE = 2222;

  // The wire shape of `meta.basis`/`basisNote`/`withheldPoints` (ABL-501).
  // `BASIS_NOTE` stands in for the sentence the server sends from
  // `loadForecastBasis.ts`'s registry — the client owns none of these words, so
  // the fixture deliberately does not copy the production one.
  const BASIS_NOTE = 'Forecast withheld. Test sentence explaining the basis gap.';

  return {
    iso,
    ML_VALUE,
    TSO_VALUE,
    BASIS_NOTE,
    comparable: { basis: 'comparable' as const, basisNote: null, withheldPoints: 0 },
    withheld: { basis: 'divergent_basis' as const, basisNote: BASIS_NOTE, withheldPoints: 24 },
    loadPoints: [
      { timestamp: iso(-2), load: 9000 },
      { timestamp: iso(-1), load: 9500 },
    ],
    mlPoints: [
      {
        timestamp: iso(1),
        value: ML_VALUE,
        type: 'load',
        generated_at: iso(-3),
        horizon_hours: 4,
        model_name: 'xgboost',
      },
    ],
    tsoPoints: [
      {
        timestamp: iso(1),
        forecast_value_mw: TSO_VALUE,
        forecast_min_mw: null,
        forecast_max_mw: null,
        forecast_type: 'day_ahead',
        publication_timestamp_utc: null,
      },
    ],
    registry: {
      load: {
        production: 'catboost',
        models: [
          { id: 'catboost', label: 'able-ml · catboost', source: 'ml', modelName: 'catboost' },
          { id: 'xgboost', label: 'able-ml · xgboost', source: 'ml', modelName: 'xgboost' },
          { id: 'tso-d1', label: 'ENTSO-E TSO · D+1', source: 'tso', tsoHorizon: 'day_ahead' },
        ],
      },
    },
  };
});

// Only the network boundary is mocked. The store, React Query, useModelSelection
// and the series adapter all run for real — that chain is where the bug lived.
//
// `async` with no `await` is deliberate here and not an oversight: each of these
// stands in for a real API function that returns a promise, and the code under
// test awaits them. Dropping `async` would hand it a bare value and stop
// exercising the await. (The two halves of ABL-282 — the flat config and this
// file — were built on separate branches and first met when ABL-317 published
// them together, which is why this disable is being added after the fact.)
/* eslint-disable @typescript-eslint/require-await */
vi.mock('@/services/api', () => ({
  fetchCountries: vi.fn(async () => [{ country_code: 'BE', country_name: 'Belgium' }]),
  fetchForecastModels: vi.fn(async () => fx.registry),
  // ABL-469. `undefined` is the no-recommendation case and is what every test
  // below except the two auto-selection ones wants — it reproduces the state
  // before auto-selection existed. It has to be mocked explicitly rather than
  // left off: `vi.mock` with a factory replaces the whole module, so an absent
  // export is `undefined` and calling it throws inside the query, where React
  // Query swallows it. That happened to produce the right answer for the wrong
  // reason, which is exactly the kind of accident a test file should not rest on.
  fetchRecommendedModel: vi.fn(async () => undefined),
  fetchLoadData: vi.fn(async () => fx.loadPoints),
  fetchForecastData: vi.fn(async () => ({ points: fx.mlPoints, servedModelId: 'xgboost', ...fx.comparable })),
  fetchTSOLoadForecast: vi.fn(async () => ({ points: fx.tsoPoints, ...fx.comparable })),
  fetchForecastComparison: vi.fn(async () => ({ forecasts: [], actuals: [] })),
  fetchMultiHorizonForecast: vi.fn(async () => []),
  fetchTSOLoadForecastAccuracy: vi.fn(async () => ({
    data: [],
    metrics: { mae: null, mape: null, rmse: null, dataPoints: 0, mapeSamples: 0 },
  })),
}));
/* eslint-enable @typescript-eslint/require-await */

// The AbleLineChart mock exposes two data attributes so both rendering paths
// are testable:
//   data-forecast-values  — `series[].forecast` values (single-model path via
//                           adaptLoadSeries; empty for the multi-model path)
//   data-forecast-series-ids — `forecastSeries[].id` values (multi-model path
//                              via buildMultiForecastSeries; empty for single)
vi.mock('@/components/charts/AbleLineChart', () => ({
  AbleLineChart: ({
    series,
    forecastSeries,
  }: {
    series: Array<{ forecast: number | null }>;
    forecastSeries?: Array<{ id: string; coverageNote?: string }>;
  }) => (
    <div
      data-testid="line-chart"
      data-forecast-values={JSON.stringify(
        series.filter((p) => p.forecast != null).map((p) => p.forecast),
      )}
      data-forecast-series-ids={JSON.stringify((forecastSeries ?? []).map((s) => s.id))}
      // The legend text for an uncovered entry (ABL-501): "not available" and
      // "withheld" are the same hatched swatch and two different claims, and
      // this is the only place the difference is visible.
      data-forecast-coverage-notes={JSON.stringify(
        (forecastSeries ?? []).map((s) => s.coverageNote ?? null),
      )}
    />
  ),
}));

vi.mock('@/components/charts/AblePriceHeatmap', () => ({
  AblePriceHeatmap: () => <div data-testid="heatmap" />,
}));

function renderLoadTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<LoadTab />, { wrapper });
}

/** The forecast values the tab handed to AbleLineChart (single-model path). */
async function forecastValuesOnChart(): Promise<number[]> {
  const chart = await screen.findByTestId('line-chart');
  return JSON.parse(chart.getAttribute('data-forecast-values') ?? '[]') as number[];
}

/** The forecastSeries ids handed to AbleLineChart (multi-model path). */
async function forecastSeriesIdsOnChart(): Promise<string[]> {
  // There may be multiple line-chart elements (one per model entry in
  // LoadSelectionView). Use findAllByTestId and take the first non-empty hit.
  const charts = await screen.findAllByTestId('line-chart');
  for (const chart of charts) {
    const ids = JSON.parse(chart.getAttribute('data-forecast-series-ids') ?? '[]') as string[];
    if (ids.length > 0) return ids;
  }
  return [];
}

describe('LoadTab forecast overlay', () => {
  beforeEach(() => {
    // The store is a module singleton with a persist middleware. The middleware
    // only reads localStorage at initialization (module import), not between
    // tests, so setting state directly is sufficient to isolate tests.
    useDashboardStore.setState({
      selectedCountry: 'BE',
      timePreset: '24h',
      timeOffset: 0,
      selectedModelsByType: {},
      forecastHiddenByType: {},
      showComparisonMode: false,
      showTSOComparisonMode: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('draws the ML forecast when the picker selects an ml model', async () => {
    // Pinning a model routes to LoadSelectionView (multi-model path). The
    // forecast reaches AbleLineChart via forecastSeries, not series[].forecast.
    useDashboardStore.setState({ selectedModelsByType: { load: ['xgboost'] } });

    renderLoadTab();

    const ids = await forecastSeriesIdsOnChart();
    expect(ids).toContain('xgboost');
  });

  it('draws the TSO forecast when the picker selects a tso model', async () => {
    // Pinning a TSO model also routes to LoadSelectionView. The entry id must
    // be 'tso-d1' and must not include an ML model.
    useDashboardStore.setState({ selectedModelsByType: { load: ['tso-d1'] } });

    renderLoadTab();

    const ids = await forecastSeriesIdsOnChart();
    expect(ids).toContain('tso-d1');
    expect(ids).not.toContain('xgboost');
    expect(ids).not.toContain('catboost');
  });

  it('falls back to the production model when the user has picked nothing', async () => {
    // Default state: `selectedModelsByType` is empty. The type's production
    // model (catboost, an ml model) applies, so the overlay still draws.
    renderLoadTab();

    expect(await forecastValuesOnChart()).toContain(fx.ML_VALUE);
  });

  it('draws no forecast when the picker hides it', async () => {
    // forecastHiddenByType is the "hidden" signal — separate from selection.
    useDashboardStore.setState({ forecastHiddenByType: { load: true } });

    renderLoadTab();

    expect(await forecastValuesOnChart()).toEqual([]);
    expect(screen.queryByText(/dashed =/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ABL-501 — a forecast on a different basis from the actuals is withheld by
// the server, and the tab has to say so instead of drawing it or going quiet.
//
// The live defect this guards: NL's Load tab drew catboost's gross-basis
// prediction at ~9.4 GW over a realized ~4.4 GW at midday, with nothing on the
// card saying the two lines were different quantities.
// ---------------------------------------------------------------------------
describe('LoadTab — withheld forecast (divergent basis)', () => {
  beforeEach(() => {
    useDashboardStore.setState({
      selectedCountry: 'BE',
      timePreset: '24h',
      timeOffset: 0,
      selectedModelsByType: {},
      forecastHiddenByType: {},
      showComparisonMode: false,
      showTSOComparisonMode: false,
    });
    vi.mocked(api.fetchForecastData).mockResolvedValue({
      points: fx.mlPoints,
      servedModelId: 'xgboost',
      ...fx.comparable,
    });
    vi.mocked(api.fetchTSOLoadForecast).mockResolvedValue({
      points: fx.tsoPoints,
      ...fx.comparable,
    });
  });

  afterEach(() => cleanup());

  /** What the server sends for a withheld series: no rows, and the reason. */
  const withheldMl = () =>
    vi.mocked(api.fetchForecastData).mockResolvedValue({
      points: [],
      servedModelId: 'catboost',
      ...fx.withheld,
    });

  it('default view: prints the reason instead of a line', async () => {
    withheldMl();

    renderLoadTab();

    expect(await screen.findByText(fx.BASIS_NOTE)).toBeTruthy();
    expect(await forecastValuesOnChart()).toEqual([]);
  });

  it('default view: stops claiming a dashed forecast line that is not drawn', async () => {
    // The subtitle read "dashed = able-ml forecast" beside a chart with no
    // dashed line — a caption describing a mark that is not there.
    withheldMl();

    renderLoadTab();

    await screen.findByText(fx.BASIS_NOTE);
    expect(screen.queryByText(/dashed =/)).toBeNull();
  });

  it('default view: says nothing when the series is comparable', async () => {
    renderLoadTab();

    expect(await forecastValuesOnChart()).toContain(fx.ML_VALUE);
    expect(screen.queryByText(fx.BASIS_NOTE)).toBeNull();
  });

  /**
   * A measured TSO recommendation — the smallest fixture that makes
   * `describeAutoSelection` actually speak. `tso` is used rather than `ml`
   * because it displays what was measured immediately, where an `ml` label
   * additionally waits for `meta.model` to agree (`resolveSelection`).
   */
  const recommendTso = () =>
    vi.mocked(api.fetchRecommendedModel).mockResolvedValue({
      modelId: 'tso-d1',
      label: 'ENTSO-E TSO · D+1',
      source: 'tso',
      wape: 3.45,
      dataPoints: 700,
      fallback: false,
      windowStart: fx.iso(-720),
      windowEnd: fx.iso(0),
      windowDays: 30,
      candidates: [],
    });

  const AUTO_SENTENCE = /automatically selected as the most accurate/;

  it('default view: an auto-selected default IS announced when its line is drawn', async () => {
    // Negative control for the test below. Without this passing, the assertion
    // that the sentence disappears when withheld would pass vacuously — which
    // is the failure mode a "check something is absent" test invites.
    recommendTso();

    renderLoadTab();

    expect(await screen.findByText(AUTO_SENTENCE)).toBeTruthy();
  });

  it('default view: never announces a withheld series as the most accurate forecast', async () => {
    // The trap this merge created (ABL-469 + ABL-501). That sentence is a claim
    // about a line, and a withheld pair has no line — nor any attributable
    // accuracy for a default to have been selected *on*, which is the whole of
    // ABL-493. Printing it would republish, as a commendation, the very measure
    // suppressed everywhere else.
    recommendTso();
    vi.mocked(api.fetchTSOLoadForecast).mockResolvedValue({ points: [], ...fx.withheld });

    renderLoadTab();

    await screen.findByText(fx.BASIS_NOTE);
    expect(screen.queryByText(AUTO_SENTENCE)).toBeNull();
    // And no line to describe, which is what makes the sentence wrong.
    expect(await forecastValuesOnChart()).toEqual([]);
  });

  it('selection view: names the withheld model and gives the reason', async () => {
    useDashboardStore.setState({ selectedModelsByType: { load: ['catboost'] } });
    withheldMl();

    renderLoadTab();

    expect(await screen.findByText(/able-ml · catboost: /)).toBeTruthy();
    expect(screen.getByText(new RegExp(fx.BASIS_NOTE.slice(0, 30)))).toBeTruthy();
  });

  it('selection view: never calls a withheld model unavailable', async () => {
    // The regression this fix could easily have introduced. A withheld entry
    // has zero points, which is exactly what a coverage gap looks like — and
    // the copy for that is "<model> has no forecast for Belgium in this
    // window", which would be false: the rows exist and we are declining to
    // draw them.
    useDashboardStore.setState({ selectedModelsByType: { load: ['catboost'] } });
    withheldMl();

    renderLoadTab();

    await screen.findByText(/able-ml · catboost: /);
    expect(screen.queryByText(/has no forecast for/)).toBeNull();
    expect(screen.queryByText(/not available in/i)).toBeNull();
  });

  it('selection view: the legend key says withheld, not unavailable', async () => {
    useDashboardStore.setState({ selectedModelsByType: { load: ['catboost'] } });
    withheldMl();

    renderLoadTab();

    await screen.findByText(/able-ml · catboost: /);
    const charts = await screen.findAllByTestId('line-chart');
    const notes = charts.flatMap(
      (c) => JSON.parse(c.getAttribute('data-forecast-coverage-notes') ?? '[]') as (string | null)[],
    );
    expect(notes).toContain(WITHHELD_LEGEND_NOTE);
    expect(notes.some((n) => n?.includes('Not available'))).toBe(false);
  });

  it('selection view: a withheld model and an uncovered one get different words', async () => {
    // Two checked models, one withheld and one genuinely absent. Both draw a
    // hatched key; only one of them is a gap the user could act on.
    useDashboardStore.setState({ selectedModelsByType: { load: ['catboost', 'tso-d1'] } });
    withheldMl();
    vi.mocked(api.fetchTSOLoadForecast).mockResolvedValue({ points: [], ...fx.comparable });

    renderLoadTab();

    expect(await screen.findByText(/able-ml · catboost: /)).toBeTruthy();
    expect(screen.getByText(/ENTSO-E TSO · D\+1 has no forecast for Belgium/)).toBeTruthy();
  });
});
