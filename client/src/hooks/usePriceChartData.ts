import { useEffect } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useDashboardStore } from '@/store/dashboardStore';
import {
  fetchPriceData,
  fetchForecastData,
  fetchForecastComparison,
} from '@/services/api';
import { REFRESH_INTERVALS } from '@/lib/constants';
import { maskServedModel } from '@/lib/servedModel';
import { useModelSelection, useMultiModelSelection } from './useForecastModels';
import { forecastLineToken } from '@/components/dashboard/forecastLineTokens';
import type { NormalizedForecastPoint } from '@/lib/multiForecastSeries';
import {
  getDateRangeForPreset,
  getGranularityForPreset,
  getMLForecastDateRange,
} from './useDashboardData';
import { getPriceWindowEnd } from '@/lib/priceWindow';
import type {
  PriceDataPoint,
  ForecastDataPoint,
  ForecastComparisonData,
} from '@/types';

/** One explicitly-checked model's normalized forecast, for the multi-select picker (ABL-204). Price has no TSO model registered, so every entry is ml. */
export interface PriceModelQuery {
  id: string;
  label: string;
  color: string;
  dash: string;
  points: NormalizedForecastPoint[] | undefined;
  isLoading: boolean;
  isError: boolean;
}

export interface PriceChartData {
  // Actual price data
  priceData: PriceDataPoint[] | undefined;
  isLoadingPrice: boolean;

  // ML forecast data
  forecastData: ForecastDataPoint[] | undefined;
  isLoadingForecast: boolean;
  /** `meta.model` from the most recent forecast response — which model actually served. */
  servedModelId: string | null;

  // ML comparison data
  comparisonData: ForecastComparisonData | undefined;
  isLoadingComparison: boolean;

  // Aggregate loading state
  isLoading: boolean;
  isError: boolean;

  /** Multi-model selection (ABL-204) — see the identical field on `LoadChartData` for why this is separate from `forecastData` above. */
  modelSelection: PriceModelQuery[];
}

/**
 * Batched hook for PriceChart that fetches all data in parallel.
 * PriceChart doesn't have TSO forecasts (ENTSO-E doesn't provide price forecasts).
 */
export function usePriceChartData(): PriceChartData {
  // Use selective store subscriptions to minimize re-renders
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const timePreset = useDashboardStore((s) => s.timePreset);
  const timeOffset = useDashboardStore((s) => s.timeOffset);
  const showComparisonMode = useDashboardStore((s) => s.showComparisonMode);
  const setServedModel = useDashboardStore((s) => s.setServedModel);

  // The picker is the single source of truth for which model this chart shows
  // (see useLoadChartData.ts — same treatment). The legacy `showForecast` store
  // boolean has no UI setter for the price tab, so gating on it left the query
  // permanently disabled while the picker still advertised a model as serving.
  const { selected, requestModelId } = useModelSelection('price');
  const showForecast = selected?.source === 'ml';

  // Pin only what the user pinned; otherwise let the server pick a model that
  // has data for this country.
  const modelId = selected?.source === 'ml' ? requestModelId : undefined;

  // Calculate date ranges
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);
  const granularity = getGranularityForPreset(timePreset);

  // Shared with usePriceData — both hooks use the same ['prices', …] query
  // key, so their windows must be identical (see getPriceWindowEnd).
  const priceEnd = getPriceWindowEnd(end);

  // ML forecast date range (window start to max(window end, now+48h))
  const { start: mlForecastStart, end: mlForecastEnd } = getMLForecastDateRange(start, end, 48);

  const queries = useQueries({
    queries: [
      // Query 0: Actual price data (always fetched)
      {
        queryKey: ['prices', selectedCountry, timePreset, timeOffset, granularity],
        queryFn: () =>
          fetchPriceData({
            country: selectedCountry,
            start: start.toISOString(),
            end: priceEnd.toISOString(),
            granularity,
          }),
        staleTime: REFRESH_INTERVALS.dashboard,
      },
      // Query 1: ML forecast data
      {
        queryKey: ['forecast', selectedCountry, 'price', timePreset, timeOffset, granularity, modelId],
        queryFn: () =>
          fetchForecastData({
            country: selectedCountry,
            type: 'price',
            start: mlForecastStart,
            end: mlForecastEnd,
            granularity,
            model: modelId,
          }),
        enabled: showForecast,
        staleTime: REFRESH_INTERVALS.dashboard,
      },
      // Query 2: ML forecast comparison
      {
        queryKey: ['forecast', 'comparison', selectedCountry, 'price', timePreset, timeOffset],
        queryFn: () =>
          fetchForecastComparison({
            country: selectedCountry,
            type: 'price',
            start: start.toISOString(),
            end: end.toISOString(),
          }),
        enabled: showForecast && showComparisonMode,
        staleTime: REFRESH_INTERVALS.dashboard,
      },
    ],
  });

  const [priceQuery, forecastQuery, comparisonQuery] = queries;

  const forecastData = forecastQuery.data?.points;
  // Masked by the same flag that gates the query above (`enabled: showForecast`)
  // — see maskServedModel's doc comment for why this can't just read the data.
  const servedModelId = maskServedModel(showForecast, forecastQuery.data?.servedModelId);

  useEffect(() => {
    setServedModel('price', servedModelId);
  }, [setServedModel, servedModelId]);

  // Multi-model selection (ABL-204) — one query per model explicitly checked
  // in the picker. Price registers only ml models, so unlike Load's
  // counterpart this never branches on source.
  const { models: allPriceModels, selectedIds } = useMultiModelSelection('price');

  const selectionQueries = useQueries({
    queries: selectedIds.map((id) => ({
      queryKey: ['forecast', selectedCountry, 'price', timePreset, timeOffset, granularity, id],
      queryFn: () =>
        fetchForecastData({
          country: selectedCountry,
          type: 'price',
          start: mlForecastStart,
          end: mlForecastEnd,
          granularity,
          model: id,
        }),
      staleTime: REFRESH_INTERVALS.dashboard,
    })),
  });

  const modelSelection: PriceModelQuery[] = selectedIds.map((id, i) => {
    const model = allPriceModels.find((m) => m.id === id);
    const q = selectionQueries[i];
    const token = forecastLineToken(id);
    return {
      id,
      label: model?.label ?? id,
      color: token.color,
      dash: token.dash,
      points: q.data?.points.map((p) => ({ timestamp: p.timestamp, value: p.value })),
      isLoading: q.isLoading,
      isError: q.isError,
    };
  });

  return {
    // Actual price data
    priceData: priceQuery.data,
    isLoadingPrice: priceQuery.isLoading,

    // ML forecast data
    forecastData,
    isLoadingForecast: forecastQuery.isLoading,
    servedModelId,

    // ML comparison data
    comparisonData: comparisonQuery.data,
    isLoadingComparison: comparisonQuery.isLoading,

    // Aggregate states
    isLoading: priceQuery.isLoading, // Only consider primary data loading
    isError: queries.some((q) => q.isError),

    modelSelection,
  };
}
