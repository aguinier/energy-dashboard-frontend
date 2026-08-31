// @vitest-environment jsdom
//
// Task 9a: `ModelPicker` moves from reading `useActiveForecastType()`
// internally to taking `forecastType` as a prop, so a scrolling document with
// six figures can mount six independent pickers — one per figure — none of
// which share a single global "active tab". The regression this guards
// against is the reason the prop exists at all: two pickers on screen at once
// must resolve two different model sets and write to two different store
// slices, never collapsing onto whichever forecast type happens to be
// "active".
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ModelPicker } from './ModelPicker';
import { useDashboardStore } from '@/store/dashboardStore';

const fx = vi.hoisted(() => ({
  registry: {
    load: {
      production: 'catboost',
      models: [
        { id: 'catboost', label: 'able-ml · catboost', source: 'ml', modelName: 'catboost' },
        { id: 'xgboost', label: 'able-ml · xgboost', source: 'ml', modelName: 'xgboost' },
      ],
    },
    price: {
      production: 'tso-d1',
      models: [{ id: 'tso-d1', label: 'TSO · day-ahead', source: 'tso', tsoHorizon: 'day_ahead' }],
    },
  },
}));

/* eslint-disable @typescript-eslint/require-await -- mocked API, sync fixture data */
vi.mock('@/services/api', () => ({
  fetchForecastModels: vi.fn(async () => fx.registry),
  fetchRecommendedModel: vi.fn(async () => null),
}));
/* eslint-enable @typescript-eslint/require-await */

function renderPicker(forecastType: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<ModelPicker forecastType={forecastType} />, { wrapper });
}

describe('ModelPicker — forecastType prop', () => {
  beforeEach(() => {
    useDashboardStore.setState({
      selectedCountry: 'BE',
      selectedModelsByType: {},
      forecastHiddenByType: {},
    });
  });

  afterEach(() => cleanup());

  it('reads the model set for the given forecastType, not a global "active" one', async () => {
    renderPicker('load');
    // load's registry has two models; the button reflects "Default" until one
    // is checked, and opening the popover lists both load models — proof the
    // component resolved `load`, not some other type.
    expect(await screen.findByText(/Models · Default/)).toBeTruthy();
    fireEvent.click(screen.getByText(/Models · Default/));
    expect(await screen.findByText('able-ml · catboost')).toBeTruthy();
    expect(await screen.findByText('able-ml · xgboost')).toBeTruthy();
  });

  it('two pickers with different forecastType props resolve independent model sets and stores', async () => {
    const { unmount } = renderPicker('load');
    fireEvent.click(await screen.findByText(/Models · Default/));
    // Check a load model — writes selectedModelsByType.load only.
    fireEvent.click(await screen.findByText('able-ml · xgboost'));
    expect(useDashboardStore.getState().selectedModelsByType).toEqual({ load: ['xgboost'] });
    unmount();
    cleanup();

    // A second, independent picker for `price` must not see load's selection,
    // must not offer load's models, and must not write into load's slot.
    renderPicker('price');
    expect(await screen.findByText(/Models · Default/)).toBeTruthy();
    fireEvent.click(screen.getByText(/Models · Default/));
    expect(screen.queryByText('able-ml · catboost')).toBeNull();
    expect(screen.queryByText('able-ml · xgboost')).toBeNull();
    expect(await screen.findByText('TSO · day-ahead')).toBeTruthy();

    fireEvent.click(screen.getByText('TSO · day-ahead'));
    const state = useDashboardStore.getState().selectedModelsByType;
    expect(state.load).toEqual(['xgboost']); // untouched by the price picker
    expect(state.price).toEqual(['tso-d1']);
  });
});
