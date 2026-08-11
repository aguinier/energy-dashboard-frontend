import { useEffect } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useDashboardStore } from '@/store/dashboardStore';
import {
  fetchLoadData,
  fetchForecastData,
  fetchForecastComparison,
  fetchMultiHorizonForecast,
  fetchTSOLoadForecast,
  fetchTSOLoadForecastAccuracy,
} from '@/services/api';
import type { ForecastFetchResult } from '@/services/api';
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
import type {
  LoadDataPoint,
  ForecastDataPoint,
  ForecastComparisonData,
  MultiHorizonForecastDataPoint,
  TSOLoadForecastDataPoint,
  TSOForecastAccuracyDataPoint,
  TSOForecastAccuracyMetrics,
  TSOHorizon,
} from '@/types';

/** One explicitly-checked model's normalized forecast, for the multi-select picker (ABL-204). */
export interface LoadModelQuery {
  id: string;
  label: string;
  color: string;
  dash: string;
  points: NormalizedForecastPoint[] | undefined;
  isLoading: boolean;
  isError: boolean;
}

// Helper to extend date range for forecast overlay
function getTSOForecastDateRange(
  startDate: Date,
  endDate: Date,
  futureDays: number = 7
): { start: string; end: string } {
  const extendedEnd = new Date(Math.max(endDate.getTime(), Date.now() + futureDays * 24 * 60 * 60 * 1000));
  return { start: startDate.toISOString(), end: extendedEnd.toISOString() };
}

export interface LoadChartData {
  // Actual load data
  loadData: LoadDataPoint[] | undefined;
  isLoadingLoad: boolean;

  // ML forecast data
  forecastData: ForecastDataPoint[] | undefined;
  isLoadingForecast: boolean;
  /** `meta.model` from the most recent forecast response — which model actually served. */
  servedModelId: string | null;

  // ML multi-horizon data
  multiHorizonData: MultiHorizonForecastDataPoint[] | undefined;
  isLoadingMultiHorizon: boolean;

  // ML comparison data
  comparisonData: ForecastComparisonData | undefined;
  isLoadingComparison: boolean;

  // TSO forecast data
  tsoForecastData: TSOLoadForecastDataPoint[] | undefined;
  isLoadingTSOForecast: boolean;

  // TSO accuracy data
  tsoAccuracyData: { data: TSOForecastAccuracyDataPoint[]; metrics: TSOForecastAccuracyMetrics } | undefined;
  isLoadingTSOAccuracy: boolean;

  // Aggregate loading state
  isLoading: boolean;
  isError: boolean;

  /**
   * Multi-model selection (ABL-204) — one entry per model explicitly checked
   * in `ModelPicker`, empty in "Default" mode. The fields above (`forecastData`,
   * `tsoForecastData`, `servedModelId`, …) describe the single unpinned or
   * legacy single-pinned request and are unchanged by this — `ForecastTab`
   * still reads them directly for its own single-line overlay, regardless of
   * what is checked in the Load tab's picker.
   */
  modelSelection: LoadModelQuery[];
}

/**
 * Batched hook for LoadChart that fetches all data in parallel.
 * This replaces 5 separate useQuery hooks with a single useQueries call,
 * reducing load time from ~1500ms to ~300ms when forecasts are enabled.
 */
export function useLoadChartData(): LoadChartData {
  // Use selective store subscriptions to minimize re-renders
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const timePreset = useDashboardStore((s) => s.timePreset);
  const timeOffset = useDashboardStore((s) => s.timeOffset);
  const showComparisonMode = useDashboardStore((s) => s.showComparisonMode);
  const showTSOComparisonMode = useDashboardStore((s) => s.showTSOComparisonMode);
  const setServedModel = useDashboardStore((s) => s.setServedModel);

  // The picker is the single source of truth for which model this chart shows.
  const { selected, requestModelId } = useModelSelection('load');
  const showForecast = selected?.source === 'ml';
  const showTSOForecast = selected?.source === 'tso';
  const tsoHorizon = (selected?.tsoHorizon ?? 'day_ahead') as TSOHorizon;

  // Pin only what the user pinned; otherwise let the server pick a model that
  // has data for this country.
  const modelId = selected?.source === 'ml' ? requestModelId : undefined;
  const selectedMLHorizons = useDashboardStore((s) => s.selectedMLHorizons);

  // Calculate date ranges
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);
  const granularity = getGranularityForPreset(timePreset);
  const { start: tsoStart, end: tsoEnd } = getTSOForecastDateRange(start, end, 7);

  // ML forecast date range (window start to max(window end, now+48h))
  const { start: mlForecastStart, end: mlForecastEnd } = getMLForecastDateRange(start, end, 48);

  // Should fetch multi-horizon data? (when showing forecast and multiple horizons selected)
  const shouldFetchMultiHorizon = showForecast && selectedMLHorizons.length > 1;

  const queries = useQueries({
    queries: [
      // Query 0: Actual load data (always fetched)
      {
        queryKey: ['load', selectedCountry, timePreset, timeOffset, granularity],
        queryFn: () =>
          fetchLoadData({
            country: selectedCountry,
            start: start.toISOString(),
            end: end.toISOString(),
            granularity,
          }),
        staleTime: REFRESH_INTERVALS.dashboard,
      },
      // Query 1: ML forecast data
      {
        queryKey: ['forecast', selectedCountry, 'load', timePreset, timeOffset, granularity, modelId],
        queryFn: () =>
          fetchForecastData({
            country: selectedCountry,
            type: 'load',
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
        queryKey: ['forecast', 'comparison', selectedCountry, 'load', timePreset, timeOffset],
        queryFn: () =>
          fetchForecastComparison({
            country: selectedCountry,
            type: 'load',
            start: start.toISOString(),
            end: end.toISOString(),
          }),
        enabled: showForecast && showComparisonMode,
        staleTime: REFRESH_INTERVALS.dashboard,
      },
      // Query 2b: ML multi-horizon forecast data
      {
        queryKey: ['forecast', 'multi-horizon', selectedCountry, 'load', timePreset, timeOffset, selectedMLHorizons],
        queryFn: () =>
          fetchMultiHorizonForecast({
            country: selectedCountry,
            type: 'load',
            start: mlForecastStart,
            end: mlForecastEnd,
          }),
        enabled: shouldFetchMultiHorizon,
        staleTime: REFRESH_INTERVALS.dashboard,
      },
      // Query 3: TSO load forecast
      {
        queryKey: ['tso-forecast', 'load', selectedCountry, timePreset, timeOffset, tsoHorizon, granularity],
        queryFn: () =>
          fetchTSOLoadForecast({
            countryCode: selectedCountry,
            start: tsoStart,
            end: tsoEnd,
            forecastType: tsoHorizon,
            granularity,
          }),
        enabled: showTSOForecast,
        staleTime: REFRESH_INTERVALS.dashboard,
      },
      // Query 4: TSO accuracy data
      {
        queryKey: ['tso-forecast', 'accuracy', 'load', selectedCountry, timePreset, timeOffset, tsoHorizon, granularity],
        queryFn: () =>
          fetchTSOLoadForecastAccuracy({
            countryCode: selectedCountry,
            start: start.toISOString(),
            end: end.toISOString(),
            forecastType: tsoHorizon,
            granularity,
          }),
        enabled: showTSOForecast && showTSOComparisonMode,
        staleTime: REFRESH_INTERVALS.dashboard,
      },
    ],
  });

  const [loadQuery, forecastQuery, comparisonQuery, multiHorizonQuery, tsoForecastQuery, tsoAccuracyQuery] = queries;

  const forecastData = forecastQuery.data?.points;
  // Masked by the same flag that gates the query above (`enabled: showForecast`)
  // — see maskServedModel's doc comment for why this can't just read the data.
  const servedModelId = maskServedModel(showForecast, forecastQuery.data?.servedModelId);

  useEffect(() => {
    setServedModel('load', servedModelId);
  }, [setServedModel, servedModelId]);

  // Multi-model selection (ABL-204) — one query per model explicitly checked
  // in the picker, fanned out the same way `useNetPositionData` fans out net
  // position's picker: ml via `fetchForecastData` pinned to that model id,
  // tso via `fetchTSOLoadForecast` pinned to that model's horizon (`load` is
  // the one type where a selection can mix both sources). A separate
  // `useQueries` call from the one above — both still run their requests
  // concurrently, this just keeps the fixed single-model queries and the
  // variable-length selection queries from having to share one array shape.
  const { models: allLoadModels, selectedIds } = useMultiModelSelection('load');

  const selectionQueries = useQueries({
    queries: selectedIds.map((id) => {
      const model = allLoadModels.find((m) => m.id === id);
      if (model?.source === 'tso') {
        return {
          queryKey: ['tso-forecast', 'load', selectedCountry, timePreset, timeOffset, model.tsoHorizon, granularity],
          queryFn: () =>
            fetchTSOLoadForecast({
              countryCode: selectedCountry,
              start: tsoStart,
              end: tsoEnd,
              forecastType: model.tsoHorizon,
              granularity,
            }),
          staleTime: REFRESH_INTERVALS.dashboard,
        };
      }
      return {
        queryKey: ['forecast', selectedCountry, 'load', timePreset, timeOffset, granularity, id],
        queryFn: () =>
          fetchForecastData({
            country: selectedCountry,
            type: 'load',
            start: mlForecastStart,
            end: mlForecastEnd,
            granularity,
            model: id,
          }),
        staleTime: REFRESH_INTERVALS.dashboard,
      };
    }),
  });

  const modelSelection: LoadModelQuery[] = selectedIds.map((id, i) => {
    const model = allLoadModels.find((m) => m.id === id);
    const q = selectionQueries[i];
    const token = forecastLineToken(id);
    let points: NormalizedForecastPoint[] | undefined;
    if (model?.source === 'tso') {
      const tso = q.data as TSOLoadForecastDataPoint[] | undefined;
      points = tso?.map((p) => ({
        timestamp: p.timestamp,
        value: p.forecast_value_mw,
        min: p.forecast_min_mw,
        max: p.forecast_max_mw,
      }));
    } else {
      const ml = q.data as ForecastFetchResult | undefined;
      points = ml?.points.map((p) => ({ timestamp: p.timestamp, value: p.value }));
    }
    return {
      id,
      label: model?.label ?? id,
      color: token.color,
      dash: token.dash,
      points,
      isLoading: q.isLoading,
      isError: q.isError,
    };
  });

  return {
    // Actual load data
    loadData: loadQuery.data,
    isLoadingLoad: loadQuery.isLoading,

    // ML forecast data
    forecastData,
    isLoadingForecast: forecastQuery.isLoading,
    servedModelId,

    // ML multi-horizon data
    multiHorizonData: multiHorizonQuery.data,
    isLoadingMultiHorizon: multiHorizonQuery.isLoading,

    // ML comparison data
    comparisonData: comparisonQuery.data,
    isLoadingComparison: comparisonQuery.isLoading,

    // TSO forecast data
    tsoForecastData: tsoForecastQuery.data,
    isLoadingTSOForecast: tsoForecastQuery.isLoading,

    // TSO accuracy data
    tsoAccuracyData: tsoAccuracyQuery.data,
    isLoadingTSOAccuracy: tsoAccuracyQuery.isLoading,

    // Aggregate states
    isLoading: loadQuery.isLoading, // Only consider primary data loading
    isError: queries.some((q) => q.isError),

    modelSelection,
  };
}
