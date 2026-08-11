import { useEffect } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useDashboardStore } from '@/store/dashboardStore';
import {
  fetchWindGenerationSeries,
  fetchForecastData,
  fetchTSOGenerationForecast,
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
  WindGenerationSeriesPoint,
  ForecastDataPoint,
  TSOGenerationForecastDataPoint,
} from '@/types';

export type WindType = 'wind_onshore' | 'wind_offshore';

function windValue(windType: WindType, onshore: number | null, offshore: number | null): number | null {
  return windType === 'wind_onshore' ? onshore : offshore;
}

/** One explicitly-checked model's normalized forecast, for the multi-select picker (ABL-204/ABL-235). */
export interface WindModelQuery {
  id: string;
  label: string;
  color: string;
  dash: string;
  points: NormalizedForecastPoint[] | undefined;
  isLoading: boolean;
  isError: boolean;
}

export interface WindChartData {
  windData: WindGenerationSeriesPoint[] | undefined;
  isLoadingWind: boolean;

  forecastData: ForecastDataPoint[] | undefined;
  isLoadingForecast: boolean;
  /** `meta.model` from the most recent forecast response — which model actually served. */
  servedModelId: string | null;

  tsoForecastData: TSOGenerationForecastDataPoint[] | undefined;
  isLoadingTSOForecast: boolean;

  isLoading: boolean;
  isError: boolean;

  /** Multi-model selection (ABL-204/ABL-235) — see the identical field on `LoadChartData`. */
  modelSelection: WindModelQuery[];
}

/**
 * Batched hook for one wind type's chart (ABL-235), mirroring
 * `useLoadChartData`/`usePriceChartData`'s shape. Closer to Load's than
 * Price's: `wind_onshore`/`wind_offshore` both register `TSO_D1`
 * (`forecastModels.ts`), so — like Load, unlike Price — a selection can mix
 * ml and tso sources. No multi-horizon or comparison-mode query: those back
 * the Load/Price accuracy panel (`ForecastTab`), which is out of this
 * issue's scope (ABL-235 only asks for actuals + a production/shadow
 * overlay, the net_position pattern).
 */
export function useWindChartData(windType: WindType): WindChartData {
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const timePreset = useDashboardStore((s) => s.timePreset);
  const timeOffset = useDashboardStore((s) => s.timeOffset);
  const setServedModel = useDashboardStore((s) => s.setServedModel);

  // The picker is the single source of truth for which model this chart shows.
  const { selected, requestModelId } = useModelSelection(windType);
  const showForecast = selected?.source === 'ml';
  const showTSOForecast = selected?.source === 'tso';

  const modelId = selected?.source === 'ml' ? requestModelId : undefined;

  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);
  const granularity = getGranularityForPreset(timePreset);

  // ML forecast date range (window start to max(window end, now+48h)).
  const { start: mlForecastStart, end: mlForecastEnd } = getMLForecastDateRange(start, end, 48);

  // Generation TSO forecast is day-ahead only (no week-ahead registered for
  // wind, unlike load's tso-d7) — a 1-day lookahead covers it, not load's 7.
  const tsoEnd = new Date(Math.max(end.getTime(), Date.now() + 24 * 60 * 60 * 1000));

  const queries = useQueries({
    queries: [
      // Query 0: actual wind data (always fetched).
      {
        queryKey: ['wind', windType, selectedCountry, timePreset, timeOffset, granularity],
        queryFn: () =>
          fetchWindGenerationSeries({
            country: selectedCountry,
            start: start.toISOString(),
            end: end.toISOString(),
            granularity,
          }),
        staleTime: REFRESH_INTERVALS.dashboard,
      },
      // Query 1: ML forecast data.
      {
        queryKey: ['forecast', selectedCountry, windType, timePreset, timeOffset, granularity, modelId],
        queryFn: () =>
          fetchForecastData({
            country: selectedCountry,
            type: windType,
            start: mlForecastStart,
            end: mlForecastEnd,
            granularity,
            model: modelId,
          }),
        enabled: showForecast,
        staleTime: REFRESH_INTERVALS.dashboard,
      },
      // Query 2: TSO generation forecast (bundled solar+wind_onshore+wind_offshore).
      {
        queryKey: ['tso-forecast', 'generation', selectedCountry, timePreset, timeOffset, granularity],
        queryFn: () =>
          fetchTSOGenerationForecast({
            countryCode: selectedCountry,
            start: start.toISOString(),
            end: tsoEnd.toISOString(),
            granularity,
          }),
        enabled: showTSOForecast,
        staleTime: REFRESH_INTERVALS.dashboard,
      },
    ],
  });

  const [windQuery, forecastQuery, tsoForecastQuery] = queries;

  const forecastData = forecastQuery.data?.points;
  // Masked by the same flag that gates the query above (`enabled: showForecast`)
  // — see maskServedModel's doc comment for why this can't just read the data.
  const servedModelId = maskServedModel(showForecast, forecastQuery.data?.servedModelId);

  useEffect(() => {
    setServedModel(windType, servedModelId);
  }, [setServedModel, servedModelId, windType]);

  // Multi-model selection (ABL-235) — one query per model explicitly checked
  // in the picker, mixing ml and tso sources freely (see useLoadChartData's
  // identical fan-out).
  const { models: allWindModels, selectedIds } = useMultiModelSelection(windType);

  const selectionQueries = useQueries({
    queries: selectedIds.map((id) => {
      const model = allWindModels.find((m) => m.id === id);
      if (model?.source === 'tso') {
        return {
          queryKey: ['tso-forecast', 'generation', selectedCountry, timePreset, timeOffset, granularity, id],
          queryFn: () =>
            fetchTSOGenerationForecast({
              countryCode: selectedCountry,
              start: start.toISOString(),
              end: tsoEnd.toISOString(),
              granularity,
            }),
          staleTime: REFRESH_INTERVALS.dashboard,
        };
      }
      return {
        queryKey: ['forecast', selectedCountry, windType, timePreset, timeOffset, granularity, id],
        queryFn: () =>
          fetchForecastData({
            country: selectedCountry,
            type: windType,
            start: mlForecastStart,
            end: mlForecastEnd,
            granularity,
            model: id,
          }),
        staleTime: REFRESH_INTERVALS.dashboard,
      };
    }),
  });

  const modelSelection: WindModelQuery[] = selectedIds.map((id, i) => {
    const model = allWindModels.find((m) => m.id === id);
    const q = selectionQueries[i];
    const token = forecastLineToken(id);
    let points: NormalizedForecastPoint[] | undefined;
    if (model?.source === 'tso') {
      const tso = q.data as TSOGenerationForecastDataPoint[] | undefined;
      points = tso?.map((p) => ({
        timestamp: p.timestamp,
        value: windValue(windType, p.wind_onshore_mw, p.wind_offshore_mw),
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
    windData: windQuery.data,
    isLoadingWind: windQuery.isLoading,

    forecastData,
    isLoadingForecast: forecastQuery.isLoading,
    servedModelId,

    tsoForecastData: tsoForecastQuery.data,
    isLoadingTSOForecast: tsoForecastQuery.isLoading,

    isLoading: windQuery.isLoading,
    isError: queries.some((q) => q.isError),

    modelSelection,
  };
}
