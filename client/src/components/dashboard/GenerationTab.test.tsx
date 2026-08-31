// @vitest-environment jsdom
//
// Component tests need a DOM; the rest of the suite is pure-module and runs
// in vitest's default node environment.
//
// variant="figure" — the country document's plot slot (Task 7b, following
// LoadTab.tsx's Task 7a pattern exactly). GenerationTab has only one render
// path (no model picker on this tab — CLAUDE.md's own note), so unlike
// LoadTab/PriceTab/WindTab this needs only one figure-mode test plus the
// default-variant regression guard.
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { GenerationTab } from './GenerationTab';
import { useDashboardStore } from '@/store/dashboardStore';

const fx = vi.hoisted(() => {
  const HOUR = 60 * 60 * 1000;
  const hour = Math.floor(Date.now() / HOUR) * HOUR;
  const iso = (offsetHours: number) => new Date(hour + offsetHours * HOUR).toISOString();

  return {
    seriesPoints: [
      {
        timestamp: iso(-1),
        nuclear: 700,
        solar: 100,
        wind: 300,
        hydro: 50,
        hydro_pumped: 0,
        fossil: 400,
        biomass: 20,
        waste: 10,
        other: 5,
      },
    ],
    mix: {
      solar: 100,
      wind_onshore: 200,
      wind_offshore: 100,
      hydro_run: 30,
      hydro_reservoir: 10,
      hydro_pumped: 0,
      biomass: 20,
      geothermal: 0,
      marine: 0,
      other_renewable: 5,
      energy_storage: 0,
      nuclear: 700,
      fossil_gas: 300,
      fossil_hard_coal: 50,
      fossil_brown_coal: 0,
      fossil_oil: 0,
      fossil_oil_shale: 0,
      fossil_peat: 0,
      fossil_coal_derived_gas: 0,
      waste: 10,
      other: 0,
      renewable_percentage: 42.5,
    },
  };
});

/* eslint-disable @typescript-eslint/require-await -- see LoadTab.test.tsx's identical note */
vi.mock('@/services/api', () => ({
  fetchCountries: vi.fn(async () => [{ country_code: 'BE', country_name: 'Belgium' }]),
  fetchGenerationMix: vi.fn(async () => fx.mix),
  fetchGenerationSeries: vi.fn(async () => fx.seriesPoints),
}));
/* eslint-enable @typescript-eslint/require-await */

function renderGenerationTab(props?: Parameters<typeof GenerationTab>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<GenerationTab {...props} />, { wrapper });
}

describe('GenerationTab — variant="figure"', () => {
  beforeEach(() => {
    useDashboardStore.setState({
      selectedCountry: 'BE',
      timePreset: '24h',
      timeOffset: 0,
    });
  });

  afterEach(() => cleanup());

  it('renders the trend chart with no AbleCard title, and omits the donut/table pair', async () => {
    renderGenerationTab({ variant: 'figure' });

    await screen.findByText(/GW · stacked by source · ENTSO-E/);
    expect(screen.queryByText('Generation mix')).toBeNull();
    // One plot per figure: the donut and by-source table (a second and third
    // chart) are gone entirely, not merely re-titled.
    expect(screen.queryByText('Window average')).toBeNull();
    expect(screen.queryByText('By source')).toBeNull();
  });

  it('default variant is unaffected: the tab still gets its card title and the donut/table pair', async () => {
    // Regression guard for the 'tab' shape itself — no production caller
    // passes it any more since Task 9b deleted the tab view
    // (CountryDashboardView.tsx), but the prop's default value and
    // behaviour are still part of GenerationTab's public contract.
    renderGenerationTab();

    expect(await screen.findByText('Generation mix')).toBeTruthy();
    expect(await screen.findByText('Window average')).toBeTruthy();
    expect(await screen.findByText('By source')).toBeTruthy();
  });
});
