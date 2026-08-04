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
// So these assert exactly that: which series values reach AbleLineChart for a
// given picker selection. The chart primitives are stubbed to expose their
// inputs — recharts renders nothing at jsdom's zero-width viewport, and the
// bug was in prop derivation, not in drawing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { LoadTab } from './LoadTab';
import { useDashboardStore } from '@/store/dashboardStore';

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

vi.mock('@/components/charts/AbleLineChart', () => ({
  AbleLineChart: ({ series }: { series: Array<{ forecast: number | null }> }) => (
    <div
      data-testid="line-chart"
      data-forecast-values={JSON.stringify(
        series.filter((p) => p.forecast != null).map((p) => p.forecast),
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

/** The forecast values the tab actually handed to the chart. */
async function forecastValuesOnChart(): Promise<number[]> {
  const chart = await screen.findByTestId('line-chart');
  return JSON.parse(chart.getAttribute('data-forecast-values') ?? '[]');
}

describe('LoadTab forecast overlay', () => {
  beforeEach(() => {
    // The store is a module singleton with a persist middleware, so state and
    // its localStorage backing both leak between tests unless reset.
    localStorage.clear();
    useDashboardStore.setState({
      selectedCountry: 'BE',
      timePreset: '24h',
      timeOffset: 0,
      selectedModelByType: {},
      showComparisonMode: false,
      showTSOComparisonMode: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('draws the ML forecast when the picker selects an ml model', async () => {
    useDashboardStore.setState({ selectedModelByType: { load: 'xgboost' } });

    renderLoadTab();

    expect(await forecastValuesOnChart()).toContain(fx.ML_VALUE);
    expect(await screen.findByText(/dashed = able-ml forecast/)).toBeTruthy();
  });

  it('draws the TSO forecast when the picker selects a tso model', async () => {
    useDashboardStore.setState({ selectedModelByType: { load: 'tso-d1' } });

    renderLoadTab();

    const values = await forecastValuesOnChart();
    expect(values).toContain(fx.TSO_VALUE);
    // Selecting TSO must swap the source, not add to it.
    expect(values).not.toContain(fx.ML_VALUE);
    expect(await screen.findByText(/dashed = ENTSO-E TSO forecast/)).toBeTruthy();
  });

  it('falls back to the production model when the user has picked nothing', async () => {
    // Default state: `selectedModelByType` is empty. The type's production
    // model (catboost, an ml model) applies, so the overlay still draws.
    renderLoadTab();

    expect(await forecastValuesOnChart()).toContain(fx.ML_VALUE);
  });

  it('draws no forecast when the picker hides it', async () => {
    // null is the picker's "hidden", distinct from undefined ("no preference").
    useDashboardStore.setState({ selectedModelByType: { load: null } });

    renderLoadTab();

    expect(await forecastValuesOnChart()).toEqual([]);
    expect(screen.queryByText(/dashed =/)).toBeNull();
  });
});
