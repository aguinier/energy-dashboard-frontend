// @vitest-environment jsdom
//
// Component tests need a DOM; the rest of the suite is pure-module and runs
// in vitest's default node environment.
//
// variant="figure" — the country document's plot slot (Task 7b, following
// LoadTab.tsx's Task 7a pattern exactly). One plot per figure: no AbleCard
// header on the primary chart. Both WindTab render paths are covered —
// WindDefaultView (nothing checked in the picker) and WindSelectionView (a
// model pinned) — because the two are separate components with separate
// return statements, and a fix proven on only one would not prove anything
// about the other.
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { WindTab } from './WindTab';
import { useDashboardStore } from '@/store/dashboardStore';

const fx = vi.hoisted(() => {
  const HOUR = 60 * 60 * 1000;
  const hour = Math.floor(Date.now() / HOUR) * HOUR;
  const iso = (offsetHours: number) => new Date(hour + offsetHours * HOUR).toISOString();

  return {
    windPoints: [
      { timestamp: iso(-2), wind_onshore: 900, wind_offshore: 400 },
      { timestamp: iso(-1), wind_onshore: 950, wind_offshore: 420 },
    ],
    forecastPoints: [
      {
        timestamp: iso(1),
        value: 1000,
        type: 'wind_onshore',
        generated_at: iso(-3),
        horizon_hours: 4,
        model_name: 'catboost',
      },
    ],
    tsoPoints: [
      { timestamp: iso(1), solar_mw: null, wind_onshore_mw: 1100, wind_offshore_mw: 500, total_forecast_mw: 1600 },
    ],
    registry: {
      wind_onshore: {
        production: 'catboost',
        models: [{ id: 'catboost', label: 'able-ml · catboost', source: 'ml', modelName: 'catboost' }],
      },
      wind_offshore: {
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
  fetchWindGenerationSeries: vi.fn(async () => fx.windPoints),
  fetchForecastData: vi.fn(async () => ({ points: fx.forecastPoints, servedModelId: 'catboost' })),
  fetchTSOGenerationForecast: vi.fn(async () => fx.tsoPoints),
}));
/* eslint-enable @typescript-eslint/require-await */

vi.mock('@/components/charts/AbleLineChart', () => ({
  AbleLineChart: () => <div data-testid="line-chart" />,
}));

function renderWindTab(props?: Parameters<typeof WindTab>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<WindTab windType="wind_onshore" {...props} />, { wrapper });
}

describe('WindTab — variant="figure"', () => {
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

  it('WindDefaultView: renders the chart with no AbleCard title', async () => {
    renderWindTab({ windType: 'wind_onshore', variant: 'figure' });

    await screen.findByTestId('line-chart');
    expect(screen.queryByText('Onshore wind generation')).toBeNull();
    // The "GW · … · ENTSO-E …" line that would otherwise live in the card
    // subtitle is still stated, just no longer inside a card header.
    expect(await screen.findByText(/GW · Belgium · ENTSO-E/)).toBeTruthy();
  });

  it('WindSelectionView: renders the chart with no AbleCard title', async () => {
    // A checked model routes to WindSelectionView — the tab's second render path.
    useDashboardStore.setState({ selectedModelsByType: { wind_onshore: ['catboost'] } });

    renderWindTab({ windType: 'wind_onshore', variant: 'figure' });

    await screen.findByTestId('line-chart');
    expect(screen.queryByText('Onshore wind generation')).toBeNull();
    expect(await screen.findByText(/comparing 1 forecast model/)).toBeTruthy();
  });

  it('default variant is unaffected: the tab still gets its card title', async () => {
    // Regression guard for "byte-identical to today" — `variant` defaults to
    // 'tab' so every existing caller (WindOnshoreTab/WindOffshoreTab via
    // CountryDashboardView) is unchanged.
    renderWindTab({ windType: 'wind_onshore' });

    await screen.findByTestId('line-chart');
    expect(screen.queryByText('Onshore wind generation')).not.toBeNull();
  });
});
