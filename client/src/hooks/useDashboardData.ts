import { useQuery } from '@tanstack/react-query';
import {
  fetchDashboardOverview,
  fetchMapData,
  fetchCombinedTimeseries,
  fetchLoadData,
  fetchPriceData,
  fetchRenewableData,
  fetchRenewableMix,
  fetchGenerationMix,
  fetchPriceHeatmap,
  fetchLoadComparison,
  fetchForecastData,
  fetchLatestForecast,
  fetchAvailableForecastTypes,
  fetchForecastComparison,
  fetchMultiHorizonForecast,
  fetchDataFreshness,
  fetchForecastComparisonSummary,
  fetchCrossCountryMetrics,
} from '@/services/api';
import { useDashboardStore } from '@/store/dashboardStore';
import { REFRESH_INTERVALS } from '@/lib/constants';
import { getTodayBrussels, getNextDayBrussels } from '@/lib/timezone';
import type { TimePreset, TimeAnchor, Granularity, MetricType, ForecastType } from '@/types';

// ============================================================================
// New time navigation functions
// ============================================================================

/**
 * Get the time anchor from a preset
 */
export function getAnchorFromPreset(preset: TimePreset): TimeAnchor {
  if (['24h', '7d', '30d', '90d', '1y'].includes(preset)) return 'past';
  if (['today', 'thisWeek'].includes(preset)) return 'now';
  return 'future';
}

/**
 * Calculate date range based on new TimePreset system
 * @param preset - The time preset (e.g., '7d', 'today', 'next7d')
 * @param offsetHours - Hours to offset from now (for navigation arrows)
 * @returns Object with start and end ISO date strings
 */
export function getDateRangeForPreset(
  preset: TimePreset,
  offsetHours: number = 0
): { start: Date; end: Date; anchor: TimeAnchor } {
  const now = new Date();
  const offsetMs = offsetHours * 60 * 60 * 1000;
  const adjustedNow = new Date(now.getTime() + offsetMs);

  let start: Date;
  let end: Date;
  let anchor: TimeAnchor;

  switch (preset) {
    // Historical presets (backward-looking from adjusted now)
    case '24h':
      start = new Date(adjustedNow.getTime() - 24 * 60 * 60 * 1000);
      end = adjustedNow;
      anchor = 'past';
      break;
    case '7d':
      start = new Date(adjustedNow.getTime() - 7 * 24 * 60 * 60 * 1000);
      end = adjustedNow;
      anchor = 'past';
      break;
    case '30d':
      start = new Date(adjustedNow.getTime() - 30 * 24 * 60 * 60 * 1000);
      end = adjustedNow;
      anchor = 'past';
      break;
    case '90d':
      start = new Date(adjustedNow.getTime() - 90 * 24 * 60 * 60 * 1000);
      end = adjustedNow;
      anchor = 'past';
      break;
    case '1y':
      start = new Date(adjustedNow.getTime() - 365 * 24 * 60 * 60 * 1000);
      end = adjustedNow;
      anchor = 'past';
      break;

     // Around now presets - Brussels timezone-based
     case 'today': {
       const todayRange = getTodayBrussels(adjustedNow);
       start = todayRange.start;
       end = todayRange.end;
       anchor = 'now';
       break;
     }
    case 'thisWeek':
      start = new Date(adjustedNow.getTime() - 3 * 24 * 60 * 60 * 1000);
      end = new Date(adjustedNow.getTime() + 4 * 24 * 60 * 60 * 1000);
      anchor = 'now';
      break;

     // Forecast presets - Brussels timezone-based
     case 'next1d': {
       const nextDayRange = getNextDayBrussels(adjustedNow);
       start = nextDayRange.start;
       end = nextDayRange.end;
       anchor = 'future';
       break;
     }
    case 'next24h':
      start = adjustedNow;
      end = new Date(adjustedNow.getTime() + 24 * 60 * 60 * 1000);
      anchor = 'future';
      break;
    case 'next48h':
      start = adjustedNow;
      end = new Date(adjustedNow.getTime() + 48 * 60 * 60 * 1000);
      anchor = 'future';
      break;
    case 'next7d':
      start = adjustedNow;
      end = new Date(adjustedNow.getTime() + 7 * 24 * 60 * 60 * 1000);
      anchor = 'future';
      break;

    default:
      // Default to 7d historical
      start = new Date(adjustedNow.getTime() - 7 * 24 * 60 * 60 * 1000);
      end = adjustedNow;
      anchor = 'past';
  }

  return { start, end, anchor };
}

/**
 * Get granularity based on new TimePreset
 */
export function getGranularityForPreset(preset: TimePreset): Granularity {
  switch (preset) {
    case '24h':
    case 'today':
    case 'next1d':
    case 'next24h':
    case 'next48h':
      return 'hourly';
    case '7d':
    case 'thisWeek':
    case 'next7d':
      return 'hourly';
    case '30d':
    case '90d':
      return 'daily';
    case '1y':
      return 'weekly';
    default:
      return 'hourly';
  }
}

// AbleStatRow's stat strip and the header qualifier (windowLabel.ts) both
// need to describe the same window — this is what the fetch actually uses,
// so the two can no longer disagree the way `timeRange`/`timePreset` did
// (see Task 8's "+24h" Critical finding, and the deferral note in Task 16).
export function useDashboardOverview() {
  const { selectedCountry, timePreset, timeOffset } = useDashboardStore();
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);

  return useQuery({
    queryKey: ['dashboard', 'overview', selectedCountry, timePreset, timeOffset],
    queryFn: () =>
      fetchDashboardOverview({
        country: selectedCountry,
        start: start.toISOString(),
        end: end.toISOString(),
      }),
    staleTime: REFRESH_INTERVALS.dashboard,
    refetchInterval: REFRESH_INTERVALS.dashboard,
  });
}

// The map has no time-navigation control of its own (confirmed: `EuropeMap`
// is the only caller, and it passes neither argument). Before this refactor
// it inherited whatever the legacy `timeRange` enum last landed on — which
// `setTimePreset` had already collapsed back to a historical value ('7d' by
// default) for every non-historical preset, so the map incidentally never
// saw a future/"now" window even though nothing made that guarantee on
// purpose.
//
// `getDashboardOverview`'s siblings (`getMapLoadData`/`getMapPriceData`/
// `getMapRenewableData`/`getMapNetPositionData` in dashboardService.ts) all
// read actuals-only tables — there is no forecast overlay for the map. Wiring
// this straight to the country page's live `timePreset`/`timeOffset` (as
// `useDashboardOverview` now does) would carry over a future-facing preset
// like `next7d`/`today` the moment the user left the country tab set that
// way, and the map would render every country as "no data" — a real
// regression, not just a style change. So the map keeps its own fixed,
// independent window instead of reusing the country page's live selection.
const MAP_WINDOW_PRESET: TimePreset = '7d';

export function useMapData(metric?: MetricType) {
  const mapMetricFromStore = useDashboardStore((state) => state.mapMetric);
  const m = metric ?? mapMetricFromStore;
  const { start, end } = getDateRangeForPreset(MAP_WINDOW_PRESET, 0);

  return useQuery({
    queryKey: ['dashboard', 'map', m],
    queryFn: () =>
      fetchMapData({
        metric: m,
        start: start.toISOString(),
        end: end.toISOString(),
      }),
    staleTime: REFRESH_INTERVALS.map,
    refetchOnWindowFocus: false,
  });
}

// No callers anywhere in client/src (confirmed by the Task 16 audit and
// re-confirmed here) — /dashboard/timeseries has been superseded by the
// per-tab hooks below (useLoadData/usePriceData/useRenewableData). Kept
// wired to the shared getDateRangeForPreset source rather than deleted,
// since deleting exported, currently-dead code is a separate call from
// removing the field it depended on.
export function useCombinedTimeseries() {
  const { selectedCountry, timePreset, timeOffset } = useDashboardStore();
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);

  return useQuery({
    queryKey: ['dashboard', 'timeseries', selectedCountry, timePreset, timeOffset],
    queryFn: () =>
      fetchCombinedTimeseries({
        country: selectedCountry,
        start: start.toISOString(),
        end: end.toISOString(),
      }),
    staleTime: REFRESH_INTERVALS.dashboard,
  });
}

export function useLoadData() {
  const { selectedCountry, timePreset, timeOffset } = useDashboardStore();
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);
  const granularity = getGranularityForPreset(timePreset);

  return useQuery({
    queryKey: ['load', selectedCountry, timePreset, timeOffset, granularity],
    queryFn: () => fetchLoadData({ country: selectedCountry, start: start.toISOString(), end: end.toISOString(), granularity }),
    staleTime: REFRESH_INTERVALS.dashboard,
  });
}

/**
 * Day-ahead auctions publish the whole next day's prices ~12:45 CET, so the
 * price window always extends past the preset's end. Every caller that shares
 * the ['prices', …] query key MUST use this — the key doesn't encode the
 * window, so two hooks with different windows silently poison each other's
 * cache (that bug hid tomorrow's prices even after the chart fix).
 */
export function getPriceWindowEnd(end: Date): Date {
  return new Date(Math.max(end.getTime(), Date.now() + 36 * 60 * 60 * 1000));
}

export function usePriceData() {
  const { selectedCountry, timePreset, timeOffset } = useDashboardStore();
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);
  const granularity = getGranularityForPreset(timePreset);

  return useQuery({
    queryKey: ['prices', selectedCountry, timePreset, timeOffset, granularity],
    queryFn: () =>
      fetchPriceData({
        country: selectedCountry,
        start: start.toISOString(),
        end: getPriceWindowEnd(end).toISOString(),
        granularity,
      }),
    staleTime: REFRESH_INTERVALS.dashboard,
  });
}

export function useRenewableData() {
  const { selectedCountry, timePreset, timeOffset } = useDashboardStore();
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);
  const granularity = getGranularityForPreset(timePreset);

  return useQuery({
    queryKey: ['renewables', selectedCountry, timePreset, timeOffset, granularity],
    queryFn: () => fetchRenewableData({ country: selectedCountry, start: start.toISOString(), end: end.toISOString(), granularity }),
    staleTime: REFRESH_INTERVALS.dashboard,
  });
}

export function useRenewableMix() {
  const { selectedCountry, timePreset, timeOffset } = useDashboardStore();
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);

  return useQuery({
    queryKey: ['renewables', 'mix', selectedCountry, timePreset, timeOffset],
    queryFn: () => fetchRenewableMix({ country: selectedCountry, start: start.toISOString(), end: end.toISOString() }),
    staleTime: REFRESH_INTERVALS.dashboard,
  });
}

// Full A75 generation mix (nuclear + fossil + renewables) for GenerationTab's
// donut and SourceTable. Same window as useRenewableMix so the two would
// agree if both were still in use; this hook is what actually feeds those
// two views now - see sourceRows.ts.
export function useGenerationMix() {
  const { selectedCountry, timePreset, timeOffset } = useDashboardStore();
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);

  return useQuery({
    queryKey: ['generation', 'mix', selectedCountry, timePreset, timeOffset],
    queryFn: () => fetchGenerationMix({ country: selectedCountry, start: start.toISOString(), end: end.toISOString() }),
    staleTime: REFRESH_INTERVALS.dashboard,
  });
}

export function usePriceHeatmap(days: number = 30) {
  const { selectedCountry } = useDashboardStore();

  return useQuery({
    queryKey: ['prices', 'heatmap', selectedCountry, days],
    queryFn: () => fetchPriceHeatmap({ country: selectedCountry, days }),
    staleTime: REFRESH_INTERVALS.map,
  });
}

export function useLoadComparison() {
  const { comparisonCountries, timePreset, timeOffset } = useDashboardStore();
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);
  const granularity = getGranularityForPreset(timePreset);

  return useQuery({
    queryKey: ['load', 'compare', comparisonCountries, timePreset, timeOffset],
    queryFn: () =>
      fetchLoadComparison({
        countries: comparisonCountries,
        start: start.toISOString(),
        end: end.toISOString(),
        granularity,
      }),
    enabled: comparisonCountries.length >= 2,
    staleTime: REFRESH_INTERVALS.dashboard,
  });
}

// Forecast hooks
export function useForecastData(forecastType: ForecastType) {
  const { selectedCountry, timePreset, showForecast } = useDashboardStore();
  const granularity = getGranularityForPreset(timePreset);

  // For forecasts, we want current time to end of forecast period
  const start = new Date().toISOString();
  const end = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(); // Next 48 hours

  return useQuery({
    queryKey: ['forecast', selectedCountry, forecastType, timePreset, granularity],
    queryFn: () => fetchForecastData({
      country: selectedCountry,
      type: forecastType,
      start,
      end,
      granularity,
    }),
    enabled: showForecast,
    staleTime: REFRESH_INTERVALS.dashboard,
  });
}

export function useLatestForecast(forecastType?: ForecastType) {
  const { selectedCountry, showForecast } = useDashboardStore();

  return useQuery({
    queryKey: ['forecast', 'latest', selectedCountry, forecastType],
    queryFn: () => fetchLatestForecast({
      country: selectedCountry,
      type: forecastType,
    }),
    enabled: showForecast,
    staleTime: REFRESH_INTERVALS.dashboard,
  });
}

export function useAvailableForecastTypes() {
  const { selectedCountry } = useDashboardStore();

  return useQuery({
    queryKey: ['forecast', 'types', selectedCountry],
    queryFn: () => fetchAvailableForecastTypes(selectedCountry),
    staleTime: REFRESH_INTERVALS.map, // Types don't change often
  });
}

export function useForecastComparison(forecastType: ForecastType) {
  const { selectedCountry, timePreset, timeOffset, showForecast } = useDashboardStore();
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);

  return useQuery({
    queryKey: ['forecast', 'comparison', selectedCountry, forecastType, timePreset, timeOffset],
    queryFn: () => fetchForecastComparison({
      country: selectedCountry,
      type: forecastType,
      start: start.toISOString(),
      end: end.toISOString(),
    }),
    enabled: showForecast,
    staleTime: REFRESH_INTERVALS.dashboard,
  });
}

/**
 * Hook for fetching multi-horizon forecasts (D+1 and D+2) for overlay view
 */
export function useMultiHorizonForecast(forecastType: ForecastType) {
  const { selectedCountry, timePreset, timeOffset, showForecast, selectedMLHorizons } = useDashboardStore();

  // For forecasts, we want current time to end of forecast period
  const start = new Date().toISOString();
  const end = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(); // Next 48 hours

  return useQuery({
    queryKey: ['forecast', 'multi-horizon', selectedCountry, forecastType, timePreset, timeOffset, selectedMLHorizons],
    queryFn: () => fetchMultiHorizonForecast({
      country: selectedCountry,
      type: forecastType,
      start,
      end,
    }),
    enabled: showForecast && selectedMLHorizons.length > 1,
    staleTime: REFRESH_INTERVALS.dashboard,
  });
}

// ML Forecast date range helper (mirrors TSO pattern)
// Uses window start to include historical forecasts, extends end to always include future forecasts
export function getMLForecastDateRange(
  windowStart: Date,
  windowEnd: Date,
  futureHours: number = 48
): { start: string; end: string } {
  const extendedEnd = new Date(Math.max(windowEnd.getTime(), Date.now() + futureHours * 60 * 60 * 1000));
  return { start: windowStart.toISOString(), end: extendedEnd.toISOString() };
}

// ============================================================================
// Data freshness hook
// ============================================================================

/**
 * Fetch data freshness information (latest timestamps for each data type)
 */
export function useDataFreshness() {
  const { selectedCountry } = useDashboardStore();

  return useQuery({
    queryKey: ['data-freshness', selectedCountry],
    queryFn: () => fetchDataFreshness(selectedCountry),
    staleTime: 60000, // 1 minute - data freshness doesn't change very often
    refetchInterval: 60000, // Refetch every minute
  });
}

// ============================================================================
// Forecast Comparison Hooks (Analytics)
// ============================================================================

/**
 * Fetch forecast comparison summary for all types
 */
export function useForecastComparisonSummary() {
  const { selectedCountry, timePreset, timeOffset } = useDashboardStore();
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);

  return useQuery({
    queryKey: ['forecast-comparison', 'summary', selectedCountry, timePreset, timeOffset],
    queryFn: () => fetchForecastComparisonSummary({
      countryCode: selectedCountry,
      start: start.toISOString(),
      end: end.toISOString(),
    }),
    staleTime: REFRESH_INTERVALS.map,
  });
}

// ============================================================================
// Cross-Country Comparison Hooks
// ============================================================================

/**
 * Fetch cross-country forecast accuracy metrics
 * Uses comparison-specific state (independent from global dashboard time)
 */
export function useCrossCountryMetrics() {
  const { comparisonForecastType, comparisonTimeRange } = useDashboardStore();

  const end = new Date();
  const daysMap: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };
  const days = daysMap[comparisonTimeRange] || 30;
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);

  return useQuery({
    queryKey: ['cross-country', 'metrics', comparisonForecastType, comparisonTimeRange],
    queryFn: () => fetchCrossCountryMetrics({
      forecastType: comparisonForecastType === 'all' ? undefined : comparisonForecastType,
      start: start.toISOString(),
      end: end.toISOString(),
    }),
    staleTime: REFRESH_INTERVALS.map, // 10 minutes
  });
}
