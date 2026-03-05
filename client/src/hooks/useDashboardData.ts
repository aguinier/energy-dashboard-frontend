import { useQuery } from '@tanstack/react-query';
import {
  fetchDashboardOverview,
  fetchMapData,
  fetchCombinedTimeseries,
  fetchLoadData,
  fetchPriceData,
  fetchRenewableData,
  fetchRenewableMix,
  fetchPriceHeatmap,
  fetchLoadComparison,
  fetchForecastData,
  fetchLatestForecast,
  fetchAvailableForecastTypes,
  fetchForecastComparison,
  fetchMultiHorizonForecast,
  fetchTSOLoadForecast,
  fetchTSOGenerationForecast,
  fetchTSOLoadForecastAccuracy,
  fetchTSOGenerationForecastAccuracy,
  fetchTSOForecastMetrics,
  fetchDataFreshness,
  fetchUnifiedForecastComparison,
  fetchForecastComparisonSummary,
  fetchBestForecast,
  fetchMLForecastAccuracy,
  fetchRollingAccuracy,
  fetchCrossCountryMetrics,
} from '@/services/api';
import { useDashboardStore } from '@/store/dashboardStore';
import { REFRESH_INTERVALS } from '@/lib/constants';
import { getTodayBrussels, getNextDayBrussels } from '@/lib/timezone';
import type { TimeRange, TimePreset, TimeAnchor, Granularity, MetricType, ForecastType, TSOForecastType, AnalyticsForecastType, AnalyticsTimeRange } from '@/types';

// Get dates from time range
function getDateRange(timeRange: TimeRange): { start: string; end: string } {
  const end = new Date();
  let start: Date;

  switch (timeRange) {
    case '24h':
      start = new Date(Date.now() - 24 * 60 * 60 * 1000);
      break;
    case '7d':
      start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      break;
    case '30d':
      start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      break;
    case '90d':
      start = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      break;
    case '1y':
      start = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
      break;
    default:
      start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  }

  return { start: start.toISOString(), end: end.toISOString() };
}


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

/**
 * Format date range for display (e.g., "Dec 25 - Jan 4, 2025 (11 days)")
 */
export function formatDateRangeDisplay(start: Date, end: Date): string {
  const startStr = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const endStr = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const diffTime = Math.abs(end.getTime() - start.getTime());
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays < 1) {
    const diffHours = Math.ceil(diffTime / (1000 * 60 * 60));
    return `${startStr} - ${endStr} (${diffHours}h)`;
  }
  return `${startStr} - ${endStr} (${diffDays} ${diffDays === 1 ? 'day' : 'days'})`;
}

/**
 * Custom hook to get computed date range based on current time navigation state
 */
export function useComputedDateRange() {
  const { timePreset, timeOffset } = useDashboardStore();
  const { start, end, anchor } = getDateRangeForPreset(timePreset, timeOffset);
  const granularity = getGranularityForPreset(timePreset);
  const displayRange = formatDateRangeDisplay(start, end);

  return {
    start,
    end,
    startISO: start.toISOString(),
    endISO: end.toISOString(),
    anchor,
    granularity,
    displayRange,
    now: new Date(),
  };
}

export function useDashboardOverview() {
  const { selectedCountry, timeRange } = useDashboardStore();

  return useQuery({
    queryKey: ['dashboard', 'overview', selectedCountry, timeRange],
    queryFn: () => fetchDashboardOverview({ country: selectedCountry, timeRange }),
    staleTime: REFRESH_INTERVALS.dashboard,
    refetchInterval: REFRESH_INTERVALS.dashboard,
  });
}

export function useMapData(metric?: MetricType, timeRange?: TimeRange) {
  const mapMetricFromStore = useDashboardStore((state) => state.mapMetric);
  const timeRangeFromStore = useDashboardStore((state) => state.timeRange);
  const m = metric ?? mapMetricFromStore;
  const t = timeRange ?? timeRangeFromStore;

  return useQuery({
    queryKey: ['dashboard', 'map', m, t],
    queryFn: () => fetchMapData({ metric: m, timeRange: t }),
    staleTime: REFRESH_INTERVALS.map,
    refetchOnWindowFocus: false,
  });
}

export function useCombinedTimeseries() {
  const { selectedCountry, timeRange } = useDashboardStore();
  const { start, end } = getDateRange(timeRange);

  return useQuery({
    queryKey: ['dashboard', 'timeseries', selectedCountry, timeRange],
    queryFn: () => fetchCombinedTimeseries({ country: selectedCountry, start, end }),
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

export function usePriceData() {
  const { selectedCountry, timePreset, timeOffset } = useDashboardStore();
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);
  const granularity = getGranularityForPreset(timePreset);

  return useQuery({
    queryKey: ['prices', selectedCountry, timePreset, timeOffset, granularity],
    queryFn: () => fetchPriceData({ country: selectedCountry, start: start.toISOString(), end: end.toISOString(), granularity }),
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

// TSO Forecast hooks (ENTSO-E official forecasts)

// Helper function to get forecast date range (extends into the future for overlay)
function getTSOForecastDateRangeFromPreset(
  preset: TimePreset,
  offset: number = 0,
  futureDays: number = 7
): { start: string; end: string } {
  const { start, end } = getDateRangeForPreset(preset, offset);

  // For historical/now presets, extend end date into the future for forecast overlay
  const extendedEnd = new Date(Math.max(end.getTime(), Date.now() + futureDays * 24 * 60 * 60 * 1000));

  return { start: start.toISOString(), end: extendedEnd.toISOString() };
}

/**
 * Fetch TSO load forecasts for the selected country
 */
export function useTSOLoadForecast(forecastType: TSOForecastType = 'day_ahead') {
  const { selectedCountry, timePreset, timeOffset, showTSOForecast } = useDashboardStore();
  const { start, end } = getTSOForecastDateRangeFromPreset(timePreset, timeOffset, 7);
  const granularity = getGranularityForPreset(timePreset);

  return useQuery({
    queryKey: ['tso-forecast', 'load', selectedCountry, timePreset, timeOffset, forecastType, granularity],
    queryFn: () => fetchTSOLoadForecast({
      countryCode: selectedCountry,
      start,
      end,
      forecastType,
      granularity,
    }),
    enabled: showTSOForecast,
    staleTime: REFRESH_INTERVALS.dashboard,
  });
}

/**
 * Fetch TSO generation forecasts (solar + wind) for the selected country
 */
export function useTSOGenerationForecast() {
  const { selectedCountry, timePreset, timeOffset, showTSOForecast } = useDashboardStore();
  const { start, end } = getTSOForecastDateRangeFromPreset(timePreset, timeOffset, 7);
  const granularity = getGranularityForPreset(timePreset);

  return useQuery({
    queryKey: ['tso-forecast', 'generation', selectedCountry, timePreset, timeOffset, granularity],
    queryFn: () => fetchTSOGenerationForecast({
      countryCode: selectedCountry,
      start,
      end,
      granularity,
    }),
    enabled: showTSOForecast,
    staleTime: REFRESH_INTERVALS.dashboard,
  });
}

/**
 * Fetch TSO load forecast accuracy comparison (forecast vs actual)
 */
export function useTSOLoadForecastAccuracy(forecastType: TSOForecastType = 'day_ahead') {
  const { selectedCountry, timePreset, timeOffset, showTSOForecast, showTSOComparisonMode } = useDashboardStore();
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);
  const granularity = getGranularityForPreset(timePreset);

  return useQuery({
    queryKey: ['tso-forecast', 'accuracy', 'load', selectedCountry, timePreset, timeOffset, forecastType, granularity],
    queryFn: () => fetchTSOLoadForecastAccuracy({
      countryCode: selectedCountry,
      start: start.toISOString(),
      end: end.toISOString(),
      forecastType,
      granularity,
    }),
    enabled: showTSOForecast && showTSOComparisonMode,
    staleTime: REFRESH_INTERVALS.dashboard,
  });
}

/**
 * Fetch TSO generation forecast accuracy for a specific type
 */
export function useTSOGenerationForecastAccuracy(type: 'solar' | 'wind_onshore' | 'wind_offshore') {
  const { selectedCountry, timePreset, timeOffset, showTSOForecast, showTSOComparisonMode } = useDashboardStore();
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);
  const granularity = getGranularityForPreset(timePreset);

  return useQuery({
    queryKey: ['tso-forecast', 'accuracy', 'generation', selectedCountry, type, timePreset, timeOffset, granularity],
    queryFn: () => fetchTSOGenerationForecastAccuracy({
      countryCode: selectedCountry,
      type,
      start: start.toISOString(),
      end: end.toISOString(),
      granularity,
    }),
    enabled: showTSOForecast && showTSOComparisonMode,
    staleTime: REFRESH_INTERVALS.dashboard,
  });
}

/**
 * Fetch aggregate TSO forecast accuracy metrics for all types
 */
export function useTSOForecastMetrics() {
  const { selectedCountry, timePreset, timeOffset, showTSOForecast } = useDashboardStore();
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);

  return useQuery({
    queryKey: ['tso-forecast', 'metrics', selectedCountry, timePreset, timeOffset],
    queryFn: () => fetchTSOForecastMetrics({
      countryCode: selectedCountry,
      start: start.toISOString(),
      end: end.toISOString(),
    }),
    enabled: showTSOForecast,
    staleTime: REFRESH_INTERVALS.map, // Metrics don't change as often
  });
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
 * Fetch unified forecast comparison for a specific type
 * Uses analytics-specific time range (independent from global dashboard time)
 */
export function useForecastComparisonMetrics(forecastType: AnalyticsForecastType = 'load') {
  const { selectedCountry, analyticsConfig } = useDashboardStore();
  const { start, end } = getAnalyticsDateRange(analyticsConfig.timeRange);

  return useQuery({
    queryKey: ['forecast-comparison', selectedCountry, forecastType, analyticsConfig.timeRange],
    queryFn: () => fetchUnifiedForecastComparison({
      countryCode: selectedCountry,
      forecastType,
      start: start.toISOString(),
      end: end.toISOString(),
    }),
    staleTime: REFRESH_INTERVALS.map, // Comparison metrics don't change often
  });
}

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

/**
 * Fetch best performing forecast for a type
 */
export function useBestForecast(forecastType: AnalyticsForecastType = 'load') {
  const { selectedCountry, timePreset, timeOffset } = useDashboardStore();
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);

  return useQuery({
    queryKey: ['forecast-comparison', 'best', selectedCountry, forecastType, timePreset, timeOffset],
    queryFn: () => fetchBestForecast({
      countryCode: selectedCountry,
      forecastType,
      start: start.toISOString(),
      end: end.toISOString(),
    }),
    staleTime: REFRESH_INTERVALS.map,
  });
}

/**
 * Fetch ML forecast accuracy data for charting
 */
export function useMLForecastAccuracy(
  forecastType: AnalyticsForecastType = 'load',
  horizon?: 1 | 2
) {
  const { selectedCountry, timePreset, timeOffset } = useDashboardStore();
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);

  return useQuery({
    queryKey: ['forecast-comparison', 'ml-accuracy', selectedCountry, forecastType, horizon, timePreset, timeOffset],
    queryFn: () => fetchMLForecastAccuracy({
      countryCode: selectedCountry,
      forecastType,
      start: start.toISOString(),
      end: end.toISOString(),
      horizon,
    }),
    staleTime: REFRESH_INTERVALS.dashboard,
  });
}

// ============================================================================
// Analytics-Specific Hooks (independent time range)
// ============================================================================

/**
 * Calculate date range for analytics based on analyticsConfig.timeRange
 * This is independent from the global dashboard time navigation
 */
export function getAnalyticsDateRange(timeRange: AnalyticsTimeRange): { start: Date; end: Date } {
  const end = new Date();

  switch (timeRange) {
    case '7d':
      return {
        start: new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000),
        end,
      };
    case '30d':
      return {
        start: new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000),
        end,
      };
    case '90d':
      return {
        start: new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000),
        end,
      };
    case 'all':
      // Default to 1 year of data for "all" to avoid excessive queries
      return {
        start: new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000),
        end,
      };
    default:
      return {
        start: new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000),
        end,
      };
  }
}

/**
 * Format analytics date range for display
 */
export function formatAnalyticsDateRange(timeRange: AnalyticsTimeRange): string {
  const { start, end } = getAnalyticsDateRange(timeRange);
  const startStr = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const endStr = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const days = timeRange === 'all' ? '1y' : timeRange;
  return `${startStr} - ${endStr} (${days})`;
}

/**
 * Custom hook to get computed analytics date range based on analyticsConfig
 */
export function useAnalyticsDateRange() {
  const { analyticsConfig } = useDashboardStore();
  const { start, end } = getAnalyticsDateRange(analyticsConfig.timeRange);
  const displayRange = formatAnalyticsDateRange(analyticsConfig.timeRange);

  return {
    start,
    end,
    startISO: start.toISOString(),
    endISO: end.toISOString(),
    displayRange,
    timeRange: analyticsConfig.timeRange,
  };
}

/**
 * Fetch unified forecast comparison using analytics-specific time range
 */
export function useAnalyticsForecastComparison(forecastType: AnalyticsForecastType = 'load') {
  const { selectedCountry, analyticsConfig } = useDashboardStore();
  const { start, end } = getAnalyticsDateRange(analyticsConfig.timeRange);

  return useQuery({
    queryKey: ['analytics', 'forecast-comparison', selectedCountry, forecastType, analyticsConfig.timeRange],
    queryFn: () => fetchUnifiedForecastComparison({
      countryCode: selectedCountry,
      forecastType,
      start: start.toISOString(),
      end: end.toISOString(),
    }),
    staleTime: REFRESH_INTERVALS.map,
  });
}

/**
 * Fetch rolling accuracy data for the trend chart
 */
export function useRollingAccuracy(forecastType: AnalyticsForecastType = 'load') {
  const { selectedCountry, analyticsConfig } = useDashboardStore();
  const { start, end } = getAnalyticsDateRange(analyticsConfig.timeRange);

  return useQuery({
    queryKey: [
      'analytics',
      'rolling-accuracy',
      selectedCountry,
      forecastType,
      analyticsConfig.timeRange,
      analyticsConfig.rollingWindow,
    ],
    queryFn: () => fetchRollingAccuracy({
      countryCode: selectedCountry,
      forecastType,
      start: start.toISOString(),
      end: end.toISOString(),
      windowDays: analyticsConfig.rollingWindow,
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
