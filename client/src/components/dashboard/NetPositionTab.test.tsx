// @vitest-environment jsdom
//
// Component tests need a DOM; the rest of the suite is pure-module and runs
// in vitest's default node environment.
//
// variant="figure" — the country document's plot slot (Task 7b, following
// LoadTab.tsx's Task 7a pattern exactly). NetPositionTab has THREE render
// paths — NetPositionDefaultView (nothing checked), NetPositionSelectionView
// (a model pinned) and CoreNetPositionView (the Core CCR scope toggle) — and
// all three are covered here: a prop honoured in two of three and silently
// ignored in the third is the exact bug class Task 7a exists to prevent.
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { NetPositionTab } from './NetPositionTab';
import { useDashboardStore } from '@/store/dashboardStore';

const fx = vi.hoisted(() => {
  const HOUR = 60 * 60 * 1000;
  const hour = Math.floor(Date.now() / HOUR) * HOUR;
  const iso = (offsetHours: number) => new Date(hour + offsetHours * HOUR).toISOString();

  const netPosition = {
    actual: [{ timestamp: iso(-1), net_position_mw: 120 }],
    forecast: [] as unknown[],
    meta: {
      bidding_zone: 'BE',
      model_name: 'catboost',
      vintages: [],
      has_band: false,
      last_seen: iso(-1),
      forecast_coverage: 'served',
      degenerate_forecast: null,
      actual_coverage: 'served',
      degenerate_actual: null,
    },
  };

  return {
    iso,
    netPosition,
    registry: {
      net_position: {
        production: 'catboost',
        models: [{ id: 'catboost', label: 'able-ml · catboost', source: 'ml', modelName: 'catboost' }],
      },
    },
    coreNetPosition: {
      actual: [{ timestamp: iso(-1), net_position_mw: 80 }],
      meta: { country_code: 'BE', bidding_zone: 'BE', in_core: true, coverage: 'served', last_seen: iso(-1) },
    },
  };
});

/* eslint-disable @typescript-eslint/require-await -- see LoadTab.test.tsx's identical note */
vi.mock('@/services/api', () => ({
  fetchCountries: vi.fn(async () => [{ country_code: 'BE', country_name: 'Belgium' }]),
  fetchForecastModels: vi.fn(async () => fx.registry),
  fetchRecommendedModel: vi.fn(async () => undefined),
  fetchNetPosition: vi.fn(async () => fx.netPosition),
  fetchCoreNetPosition: vi.fn(async () => fx.coreNetPosition),
  fetchCoreNetPositionMap: vi.fn(async () => []),
}));
/* eslint-enable @typescript-eslint/require-await */

vi.mock('@/components/charts/AbleLineChart', () => ({
  AbleLineChart: () => <div data-testid="line-chart" />,
}));

function renderNetPositionTab(props?: Parameters<typeof NetPositionTab>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<NetPositionTab {...props} />, { wrapper });
}

describe('NetPositionTab — variant="figure"', () => {
  beforeEach(() => {
    useDashboardStore.setState({
      selectedCountry: 'BE',
      timePreset: '24h',
      timeOffset: 0,
      selectedModelsByType: {},
      forecastHiddenByType: {},
      netPositionScope: 'all_coupled',
      showComparisonMode: false,
      showTSOComparisonMode: false,
    });
  });

  afterEach(() => cleanup());

  it('NetPositionDefaultView: renders the chart with no AbleCard title', async () => {
    renderNetPositionTab({ variant: 'figure' });

    await screen.findByTestId('line-chart');
    // "Net position" is both the AbleCard title and the chart's `label` prop
    // in `'tab'`; the mocked AbleLineChart drops the label, so the only
    // surviving occurrence in `'figure'` mode would be the card title — gone.
    expect(screen.queryByText('Net position')).toBeNull();
    // The subtitle line ("MW · positive = exporter · …") is still stated,
    // just no longer inside a card header.
    expect(await screen.findByText(/MW · positive = exporter/)).toBeTruthy();
  });

  it('NetPositionSelectionView: renders the chart with no AbleCard title', async () => {
    // A checked model routes to NetPositionSelectionView — the tab's second render path.
    useDashboardStore.setState({ selectedModelsByType: { net_position: ['catboost'] } });

    renderNetPositionTab({ variant: 'figure' });

    await screen.findByTestId('line-chart');
    expect(screen.queryByText('Net position')).toBeNull();
    expect(await screen.findByText(/MW · positive = exporter/)).toBeTruthy();
  });

  it('CoreNetPositionView: renders the chart with no AbleCard title', async () => {
    // The Core CCR scope toggle routes to CoreNetPositionView — the tab's third render path.
    useDashboardStore.setState({ netPositionScope: 'core' });

    renderNetPositionTab({ variant: 'figure' });

    await screen.findByTestId('line-chart');
    expect(screen.queryByText('Net position')).toBeNull();
    expect(await screen.findByText(/MW · positive = exporter/)).toBeTruthy();
  });

  it('default variant is unaffected: all three paths still get their card title', async () => {
    // Regression guard for the 'tab' shape itself — no production caller
    // passes it any more since Task 9b deleted the tab view
    // (CountryDashboardView.tsx), but the prop's default value and
    // behaviour are still part of NetPositionTab's public contract.
    const { unmount } = renderNetPositionTab();
    await screen.findByTestId('line-chart');
    expect(screen.queryByText('Net position')).not.toBeNull();
    unmount();

    useDashboardStore.setState({ selectedModelsByType: { net_position: ['catboost'] } });
    renderNetPositionTab();
    await screen.findByTestId('line-chart');
    expect(screen.queryByText('Net position')).not.toBeNull();
  });
});
