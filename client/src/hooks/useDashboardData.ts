import { useQuery } from '@tanstack/react-query';
import {
  fetchDashboardOverview,
  fetchMapData,
  fetchLoadData,
  fetchPriceData,
  fetchRenewableData,
  fetchGenerationMix,
  fetchGenerationSeries,
  fetchLatestForecast,
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
 * `offsetHours` for the two day-aligned presets (`today`, `next1d`), expressed
 * as the whole Brussels calendar days it stands for.
 *
 * `shiftTimeWindow` steps those two by exactly 24h per click
 * (PRESET_SHIFT_HOURS, lib/constants.ts), so this division is exact in
 * practice; `Math.round` only keeps it total. Shifting the *reference instant*
 * by the same hours would not work — see `dayOffset` in lib/timezone.ts for
 * the DST cases where 24h back lands on the same market day, or skips one.
 */
function wholeDays(offsetHours: number): number {
  return Math.round(offsetHours / 24);
}

/**
 * Calculate date range based on new TimePreset system
 * @param preset - The time preset (e.g., '7d', 'today', 'next7d')
 * @param offsetHours - Hours to offset from now (for navigation arrows).
 *   Always <= 0: `shiftTimeWindow` clamps forward navigation at the live
 *   position, so a window never runs ahead of the preset's own definition.
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

     // Around now presets - Brussels timezone-based
     case 'today': {
       const todayRange = getTodayBrussels(now, wholeDays(offsetHours));
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
       const nextDayRange = getNextDayBrussels(now, wholeDays(offsetHours));
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

    default: {
      // Adding a `TimePreset` without a case above is a compile error here,
      // not a silent trailing-7d window under that preset's own label — the
      // failure this dashboard exists to prevent. `TimePreset` is not a
      // `Record` key here, so nothing else would have named the omission
      // (client/src/types/index.ts:115).
      const unhandled: never = preset;
      void unhandled;

      // The runtime fallback stays. `preset` is typed, but it originates in a
      // persisted blob, and `migratePersisted` only runs when the stored
      // PERSIST_VERSION differs — a same-version blob with a hand-edited or
      // future-build `timePreset` reaches here as an unvalidated string. A 7d
      // window is wrong, but `getWindowLabel` degrades to the raw string
      // beside it (windowLabel.ts:36), so it does not render as a confident
      // known-preset claim, and it beats a crash on every chart.
      start = new Date(adjustedNow.getTime() - 7 * 24 * 60 * 60 * 1000);
      end = adjustedNow;
      anchor = 'past';
    }
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
      return 'daily';
    default: {
      // Same guard as `getDateRangeForPreset`: a new preset must state its own
      // granularity rather than inherit 'hourly' by falling through. Hourly
      // over a long window is a request the API answers slowly, not a wrong
      // number, so the runtime fallback is safe to keep.
      const unhandled: never = preset;
      void unhandled;
      return 'hourly';
    }
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

// Full A75 generation mix (nuclear + fossil + renewables) for GenerationTab's
// donut and SourceTable - see sourceRows.ts.
export function useGenerationMix() {
  const { selectedCountry, timePreset, timeOffset } = useDashboardStore();
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);

  return useQuery({
    queryKey: ['generation', 'mix', selectedCountry, timePreset, timeOffset],
    queryFn: () => fetchGenerationMix({ country: selectedCountry, start: start.toISOString(), end: end.toISOString() }),
    staleTime: REFRESH_INTERVALS.dashboard,
  });
}

// The same A75 mix over time, for GenerationTab's stacked trend chart - see
// dashboard/generationSeries.ts. Same table and same nine-family grouping as
// useGenerationMix above, so the trend and the donut cannot disagree (ABL-44).
export function useGenerationSeries() {
  const { selectedCountry, timePreset, timeOffset } = useDashboardStore();
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);
  const granularity = getGranularityForPreset(timePreset);

  return useQuery({
    queryKey: ['generation', 'series', selectedCountry, timePreset, timeOffset, granularity],
    queryFn: () =>
      fetchGenerationSeries({
        country: selectedCountry,
        start: start.toISOString(),
        end: end.toISOString(),
        granularity,
      }),
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
