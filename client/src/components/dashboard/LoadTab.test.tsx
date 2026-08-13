// @vitest-environment jsdom
//
// Component tests need a DOM; the rest of the suite is pure-module and runs in
// vitest's default node environment. The annotation above opts this file in on
// its own so the other 16 test files keep running exactly as before.
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
import { useDashboardStore } from '@/store/dashboardStore';

// Ensure a functional localStorage is present before the zustand persist
// middleware initialises (which happens at dashboardStore module import time).
// jsdom 30 + vitest worker threads may expose localStorage without a proper
// Storage prototype in some configurations, so we normalise it here.
vi.hoisted(() => {
  const store: Record<string, string> = {};
  const mock = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
  Object.defineProperty(globalThis, 'localStorage', { value: mock, writable: true });
});

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

  return {
    iso,
    ML_VALUE,
    TSO_VALUE,
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
  fetchLoadData: vi.fn(async () => fx.loadPoints),
  fetchForecastData: vi.fn(async () => ({ points: fx.mlPoints, servedModelId: 'xgboost' })),
  fetchTSOLoadForecast: vi.fn(async () => fx.tsoPoints),
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
    forecastSeries?: Array<{ id: string }>;
  }) => (
    <div
      data-testid="line-chart"
      data-forecast-values={JSON.stringify(
        series.filter((p) => p.forecast != null).map((p) => p.forecast),
      )}
      data-forecast-series-ids={JSON.stringify((forecastSeries ?? []).map((s) => s.id))}
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
