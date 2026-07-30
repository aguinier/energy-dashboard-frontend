import axios from 'axios';
import { API_BASE_URL } from '@/lib/constants';
import type {
  Country,
  LoadDataPoint,
  PriceDataPoint,
  RenewableDataPoint,
  RenewableMix,
  GenerationMix,
  DashboardOverview,
  MapDataPoint,
  CombinedTimeseriesPoint,
  PriceHeatmapPoint,
  Granularity,
  MetricType,
  ForecastType,
  ForecastDataPoint,
  ForecastComparisonData,
  MultiHorizonForecastDataPoint,
  MLHorizon,
  ApiResponse,
  TSOForecastType,
  TSOLoadForecastDataPoint,
  TSOForecastAccuracyDataPoint,
  TSOForecastAccuracyMetrics,
  DataFreshness,
  ForecastComparisonSummary,
  CrossCountryMetrics,
  CrossCountryMetricsEntry,
  NetPositionResponse,
  ForecastModelRegistry,
} from '@/types';
import { unwrap } from './unwrap';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
});

/**
 * Override for the handful of calls that are known to be slow server-side
 * regardless of the client-side cache: long-range (30d/90d/1y) windows over
 * `energy_load`/`energy_price`/`energy_renewable`, and `/renewables/mix`
 * (which additionally runs an unindexed date()/strftime() join in
 * `getRenewablePercentage`). The global 15s default is a UX bound picked so
 * a stalled request fails fast instead of hanging the retry policy — it is
 * not a claim that every query completes that quickly. These specific calls
 * used to succeed under the old 30s global timeout; pinning them back to
 * 30000ms here keeps that true without diluting the 15s bound (and the
 * retry cap it protects) for every other, normally-fast request.
 */
const LONG_RANGE_TIMEOUT_MS = 30000;

// Countries
export async function fetchCountries(): Promise<Country[]> {
  const { data } = await api.get<ApiResponse<Country[]>>('/countries');
  return unwrap(data, '/countries');
}

export async function fetchCountriesWithData(): Promise<string[]> {
  const { data } = await api.get<ApiResponse<string[]>>('/countries/with-data');
  return unwrap(data, '/countries/with-data');
}

// Load Data
export async function fetchLoadData(params: {
  country: string;
  start?: string;
  end?: string;
  granularity?: Granularity;
}): Promise<LoadDataPoint[]> {
  // Drives LoadTab's primary chart and AbleStatRow's stat strip — both fetch
  // unconditionally, so a 30d/90d/1y window here is a known-slow cold query.
  const { data } = await api.get<ApiResponse<LoadDataPoint[]>>('/load', {
    params,
    timeout: LONG_RANGE_TIMEOUT_MS,
  });
  return unwrap(data, '/load');
}

export async function fetchLoadComparison(params: {
  countries: string[];
  start?: string;
  end?: string;
  granularity?: Granularity;
}): Promise<Record<string, number>[]> {
  const { data } = await api.get<ApiResponse<Record<string, number>[]>>('/load/compare', {
    params: { ...params, countries: params.countries.join(',') },
  });
  return unwrap(data, '/load/compare');
}

// Price Data
export async function fetchPriceData(params: {
  country: string;
  start?: string;
  end?: string;
  granularity?: Granularity;
}): Promise<PriceDataPoint[]> {
  // Drives PriceTab's primary chart and AbleStatRow's stat strip — both fetch
  // unconditionally, so a 30d/90d/1y window here is a known-slow cold query.
  const { data } = await api.get<ApiResponse<PriceDataPoint[]>>('/prices', {
    params,
    timeout: LONG_RANGE_TIMEOUT_MS,
  });
  return unwrap(data, '/prices');
}

export async function fetchPriceHeatmap(params: {
  country: string;
  days?: number;
}): Promise<PriceHeatmapPoint[]> {
  const { data } = await api.get<ApiResponse<PriceHeatmapPoint[]>>('/prices/heatmap', { params });
  return unwrap(data, '/prices/heatmap');
}

// Renewable Data
export async function fetchRenewableData(params: {
  country: string;
  start?: string;
  end?: string;
  granularity?: Granularity;
}): Promise<RenewableDataPoint[]> {
  // Drives GenerationTab's stacked chart and AbleStatRow's stat strip — both
  // fetch unconditionally, so a 30d/90d/1y window here is a known-slow cold query.
  const { data } = await api.get<ApiResponse<RenewableDataPoint[]>>('/renewables', {
    params,
    timeout: LONG_RANGE_TIMEOUT_MS,
  });
  return unwrap(data, '/renewables');
}

export async function fetchRenewableMix(params: {
  country: string;
  start?: string;
  end?: string;
}): Promise<RenewableMix> {
  // GenerationTab now reads fetchGenerationMix (energy_generation, the full
  // A75 document) instead - this energy_renewable-only endpoint has no
  // current UI caller, kept for API compatibility. Its `renewable_percentage`
  // field is generationService.getRenewableShare's figure (same definition
  // the header stat, the map, and the Generation tab donut use), not a
  // separate energy_renewable/energy_load join anymore - see routes/renewables.ts.
  const { data } = await api.get<ApiResponse<RenewableMix>>('/renewables/mix', {
    params,
    timeout: LONG_RANGE_TIMEOUT_MS,
  });
  return unwrap(data, '/renewables/mix');
}

// Full A75 generation mix (nuclear + every fossil type + renewables), read
// from energy_generation. GenerationTab's donut and SourceTable use this
// instead of fetchRenewableMix so both draw from the same measured document
// and cannot disagree about what remains unexplained.
export async function fetchGenerationMix(params: {
  country: string;
  start?: string;
  end?: string;
}): Promise<GenerationMix | null> {
  const { data } = await api.get<ApiResponse<GenerationMix | null>>('/generation/mix', {
    params,
    timeout: LONG_RANGE_TIMEOUT_MS,
  });
  return unwrap(data, '/generation/mix');
}

// Dashboard Data
export async function fetchDashboardOverview(params: {
  country: string;
  start?: string;
  end?: string;
}): Promise<DashboardOverview> {
  // AbleStatRow's top stat strip, fetched unconditionally on every country
  // tab. `start`/`end` come from the same `getDateRangeForPreset` every other
  // hook already uses, so this can no longer disagree with the window the
  // header stat's qualifier claims (windowLabel.ts). The server route
  // comment (`dashboard.ts`) calls this "an expensive query" even at 7d — it
  // runs five separate scans over the window.
  const { data } = await api.get<ApiResponse<DashboardOverview>>('/dashboard/overview', {
    params,
    timeout: LONG_RANGE_TIMEOUT_MS,
  });
  return unwrap(data, '/dashboard/overview');
}

export async function fetchMapData(params: {
  metric?: MetricType;
  start?: string;
  end?: string;
}): Promise<MapDataPoint[]> {
  const { data } = await api.get<ApiResponse<MapDataPoint[]>>('/dashboard/map', { params });
  return unwrap(data, '/dashboard/map');
}

export async function fetchCombinedTimeseries(params: {
  country: string;
  start?: string;
  end?: string;
}): Promise<CombinedTimeseriesPoint[]> {
  const { data } = await api.get<ApiResponse<CombinedTimeseriesPoint[]>>('/dashboard/timeseries', { params });
  return unwrap(data, '/dashboard/timeseries');
}

// Forecast Data
export interface ForecastFetchResult {
  points: ForecastDataPoint[];
  /** `meta.model` — which model the server actually read. */
  servedModelId: string | null;
}

export async function fetchForecastData(params: {
  country: string;
  type: ForecastType;
  start?: string;
  end?: string;
  granularity?: Granularity;
  horizon?: MLHorizon;
  /** Registry model id. Omit to let the server choose one with data. */
  model?: string;
}): Promise<ForecastFetchResult> {
  const { data } = await api.get<ApiResponse<ForecastDataPoint[]> & { meta?: { model?: string | null } }>(
    '/forecasts',
    { params },
  );
  return { points: unwrap(data, '/forecasts'), servedModelId: data.meta?.model ?? null };
}

// Multi-horizon forecast data (D+1 and D+2 for overlay view)
export async function fetchMultiHorizonForecast(params: {
  country: string;
  type: ForecastType;
  start?: string;
  end?: string;
}): Promise<MultiHorizonForecastDataPoint[]> {
  const { data } = await api.get<ApiResponse<MultiHorizonForecastDataPoint[]>>('/forecasts/multi-horizon', { params });
  return unwrap(data, '/forecasts/multi-horizon');
}

export async function fetchLatestForecast(params: {
  country: string;
  type?: ForecastType;
}): Promise<ForecastDataPoint[]> {
  const { data } = await api.get<ApiResponse<ForecastDataPoint[]>>('/forecasts/latest', { params });
  return unwrap(data, '/forecasts/latest');
}

export async function fetchAvailableForecastTypes(country: string): Promise<string[]> {
  const { data } = await api.get<ApiResponse<string[]>>('/forecasts/types', { params: { country } });
  return unwrap(data, '/forecasts/types');
}

export async function fetchForecastComparison(params: {
  country: string;
  type: ForecastType;
  start?: string;
  end?: string;
}): Promise<ForecastComparisonData> {
  const { data } = await api.get<ApiResponse<ForecastComparisonData>>('/forecasts/compare', { params });
  return unwrap(data, '/forecasts/compare');
}

// TSO Forecast Data (ENTSO-E official forecasts)
export async function fetchTSOLoadForecast(params: {
  countryCode: string;
  start?: string;
  end?: string;
  forecastType?: TSOForecastType;
  granularity?: Granularity;
}): Promise<TSOLoadForecastDataPoint[]> {
  const { countryCode, ...queryParams } = params;
  const endpoint = `/tso-forecast/load/${countryCode}`;
  const { data } = await api.get<ApiResponse<TSOLoadForecastDataPoint[]>>(
    endpoint,
    { params: queryParams }
  );
  return unwrap(data, endpoint);
}

export async function fetchTSOLoadForecastAccuracy(params: {
  countryCode: string;
  start?: string;
  end?: string;
  forecastType?: TSOForecastType;
  granularity?: Granularity;
}): Promise<{ data: TSOForecastAccuracyDataPoint[]; metrics: TSOForecastAccuracyMetrics }> {
  const { countryCode, ...queryParams } = params;
  const endpoint = `/tso-forecast/accuracy/load/${countryCode}`;
  const { data } = await api.get<{
    success: boolean;
    data: TSOForecastAccuracyDataPoint[];
    metrics: TSOForecastAccuracyMetrics;
  }>(endpoint, { params: queryParams });
  return { data: unwrap(data, endpoint), metrics: data.metrics };
}

export async function fetchTSOForecastMetrics(params: {
  countryCode: string;
  start?: string;
  end?: string;
}): Promise<{
  load: TSOForecastAccuracyMetrics;
  solar: TSOForecastAccuracyMetrics;
  wind_onshore: TSOForecastAccuracyMetrics;
  wind_offshore: TSOForecastAccuracyMetrics;
}> {
  const { countryCode, ...queryParams } = params;
  const endpoint = `/tso-forecast/metrics/${countryCode}`;
  const { data } = await api.get<ApiResponse<{
    load: TSOForecastAccuracyMetrics;
    solar: TSOForecastAccuracyMetrics;
    wind_onshore: TSOForecastAccuracyMetrics;
    wind_offshore: TSOForecastAccuracyMetrics;
  }>>(endpoint, { params: queryParams });
  return unwrap(data, endpoint);
}

// Data Freshness
export async function fetchDataFreshness(countryCode: string): Promise<DataFreshness> {
  const endpoint = `/data-freshness/${countryCode}`;
  const { data } = await api.get<ApiResponse<DataFreshness>>(endpoint);
  return unwrap(data, endpoint);
}

// Combined initial data endpoint - reduces round trips for country view
export async function fetchInitialCountryData(params: {
  country: string;
  start?: string;
  end?: string;
  granularity?: Granularity;
}): Promise<{
  overview: DashboardOverview;
  loadData: LoadDataPoint[];
}> {
  const { data } = await api.get<ApiResponse<{
    overview: DashboardOverview;
    loadData: LoadDataPoint[];
  }>>('/dashboard/initial', { params });
  return unwrap(data, '/dashboard/initial');
}

// ============================================================================
// Forecast Comparison API (TSO vs ML Analytics)
// ============================================================================

/**
 * Fetch forecast comparison summary for all types
 */
export async function fetchForecastComparisonSummary(params: {
  countryCode: string;
  start?: string;
  end?: string;
}): Promise<ForecastComparisonSummary> {
  const { countryCode, ...queryParams } = params;
  const endpoint = `/forecast-comparison/${countryCode}/summary`;
  const { data } = await api.get<ApiResponse<ForecastComparisonSummary>>(
    endpoint,
    { params: queryParams }
  );
  return unwrap(data, endpoint);
}

// ============================================================================
// Cross-Country Comparison API
// ============================================================================

/**
 * Pivot API response from { forecastType: { country: metrics } }
 * to { country: { forecastType: metrics } } which the UI components expect.
 */
function pivotMetrics(
  raw: Record<string, Record<string, CrossCountryMetricsEntry>>,
): CrossCountryMetrics {
  const result: CrossCountryMetrics = {};
  for (const [type, countries] of Object.entries(raw)) {
    for (const [country, metrics] of Object.entries(countries)) {
      if (!result[country]) result[country] = {};
      result[country][type] = metrics;
    }
  }
  return result;
}

/**
 * Fetch cross-country forecast accuracy metrics for all countries
 */
export async function fetchCrossCountryMetrics(params?: {
  forecastType?: string;
  start?: string;
  end?: string;
}): Promise<CrossCountryMetrics> {
  const { data } = await api.get<ApiResponse<Record<string, Record<string, CrossCountryMetricsEntry>>>>(
    '/cross-country/metrics',
    { params }
  );
  return pivotMetrics(unwrap(data, '/cross-country/metrics'));
}

/**
 * Day-ahead net position plus the newest forecast vintage, in one call.
 * The band arrives nested per forecast row, so there is nothing to join here.
 */
export async function fetchNetPosition(params: {
  country: string;
  start: string;
  end: string;
}): Promise<NetPositionResponse> {
  const { country, ...query } = params;
  const endpoint = `/net-position/${country}`;
  const { data } = await api.get<ApiResponse<NetPositionResponse>>(
    endpoint,
    { params: query },
  );
  return unwrap(data, endpoint);
}

/** The server-side model registry: which models may serve which forecast type. */
export async function fetchForecastModels(): Promise<ForecastModelRegistry> {
  const { data } = await api.get<ApiResponse<ForecastModelRegistry>>('/forecasts/models');
  return unwrap(data, '/forecasts/models');
}

export default api;
