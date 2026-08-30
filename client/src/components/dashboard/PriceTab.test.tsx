// @vitest-environment jsdom
//
// Component tests need a DOM; the rest of the suite is pure-module and runs
// in vitest's default node environment.
//
// variant="figure" — the country document's plot slot (Task 7b, following
// LoadTab.tsx's Task 7a pattern exactly). One plot per figure: no AbleCard
// header on the primary chart, and no second chart (the hour×day heatmap).
// Both PriceTab render paths are covered — PriceDefaultView (nothing checked
// in the picker) and PriceSelectionView (a model pinned) — because the two
// are separate components with separate return statements, and a fix proven
// on only one would not prove anything about the other.
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { PriceTab } from './PriceTab';
import { useDashboardStore } from '@/store/dashboardStore';

const fx = vi.hoisted(() => {
  const HOUR = 60 * 60 * 1000;
  const hour = Math.floor(Date.now() / HOUR) * HOUR;
  const iso = (offsetHours: number) => new Date(hour + offsetHours * HOUR).toISOString();

  return {
    pricePoints: [
      { timestamp: iso(-2), price: 45.2 },
      { timestamp: iso(-1), price: 50.1 },
    ],
    forecastPoints: [
      {
        timestamp: iso(1),
        value: 55,
        type: 'price',
        generated_at: iso(-3),
        horizon_hours: 4,
        model_name: 'catboost',
      },
    ],
    registry: {
      price: {
        production: 'catboost',
        models: [{ id: 'catboost', label: 'able-ml · catboost', source: 'ml', modelName: 'catboost' }],
      },
    },
  };
});

/* eslint-disable @typescript-eslint/require-await -- see LoadTab.test.tsx's identical note */
vi.mock('@/services/api', () => ({
  fetchCountries: vi.fn(async () => [{ country_code: 'BE', country_name: 'Belgium' }]),
  fetchForecastModels: vi.fn(async () => fx.registry),
  fetchRecommendedModel: vi.fn(async () => undefined),
  fetchPriceData: vi.fn(async () => fx.pricePoints),
  fetchForecastData: vi.fn(async () => ({ points: fx.forecastPoints, servedModelId: 'catboost' })),
  fetchForecastComparison: vi.fn(async () => ({ forecasts: [], actuals: [] })),
}));
/* eslint-enable @typescript-eslint/require-await */

vi.mock('@/components/charts/AbleLineChart', () => ({
  AbleLineChart: () => <div data-testid="line-chart" />,
}));

vi.mock('@/components/charts/AblePriceHeatmap', () => ({
  AblePriceHeatmap: () => <div data-testid="heatmap" />,
}));

function renderPriceTab(props?: Parameters<typeof PriceTab>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<PriceTab {...props} />, { wrapper });
}

describe('PriceTab — variant="figure"', () => {
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
  });

  afterEach(() => cleanup());

  it('PriceDefaultView: renders the chart with no AbleCard title and no heatmap', async () => {
    renderPriceTab({ variant: 'figure' });

    await screen.findByTestId('line-chart');
    expect(screen.queryByText('Day-ahead spot price')).toBeNull();
    // The "€/MWh · … · EPEX …" line that would otherwise live in the card
    // subtitle is still stated, just no longer inside a card header.
    expect(await screen.findByText(/€\/MWh · Belgium · EPEX/)).toBeTruthy();
    expect(screen.queryByText('Price by hour × day')).toBeNull();
    expect(screen.queryByTestId('heatmap')).toBeNull();
  });

  it('PriceSelectionView: renders the chart with no AbleCard title and no heatmap', async () => {
    // A checked model routes to PriceSelectionView — the tab's second render path.
    useDashboardStore.setState({ selectedModelsByType: { price: ['catboost'] } });

    renderPriceTab({ variant: 'figure' });

    await screen.findByTestId('line-chart');
    expect(screen.queryByText('Day-ahead spot price')).toBeNull();
    expect(await screen.findByText(/comparing 1 forecast model/)).toBeTruthy();
    expect(screen.queryByText('Price by hour × day')).toBeNull();
    expect(screen.queryByTestId('heatmap')).toBeNull();
  });

  it('default variant is unaffected: the tab still gets its card title and the heatmap', async () => {
    // Regression guard for "byte-identical to today" — `variant` defaults to
    // 'tab' so every existing caller (CountryDashboardView) is unchanged.
    renderPriceTab();

    await screen.findByTestId('line-chart');
    expect(screen.queryByText('Day-ahead spot price')).not.toBeNull();
    expect(screen.queryByText('Price by hour × day')).not.toBeNull();
    expect(screen.queryByTestId('heatmap')).not.toBeNull();
  });
});
