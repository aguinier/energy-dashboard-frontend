import axios from 'axios';
import { API_BASE_URL } from '@/lib/constants';
import type {
  Country,
  LoadDataPoint,
  PriceDataPoint,
  RenewableDataPoint,
  RenewableMix,
  DashboardOverview,
  MapDataPoint,
  CombinedTimeseriesPoint,
  PriceHeatmapPoint,
  TimeRange,
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
  TSOGenerationForecastDataPoint,
  TSOForecastAccuracyDataPoint,
  TSOForecastAccuracyMetrics,
  DataFreshness,
  ForecastComparisonResponse,
  ForecastComparisonSummary,
  BestForecastResponse,
  MLForecastAccuracyDataPoint,
  AccuracyMetrics,
  AnalyticsForecastType,
  RollingAccuracyResponse,
  CrossCountryMetrics,
  CrossCountryMetricsEntry,
} from '@/types';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
});

// Countries
export async function fetchCountries(): Promise<Country[]> {
  const { data } = await api.get<ApiResponse<Country[]>>('/countries');
  return data.data;
}

export async function fetchCountriesWithData(): Promise<string[]> {
  const { data } = await api.get<ApiResponse<string[]>>('/countries/with-data');
  return data.data;
}

// Load Data
export async function fetchLoadData(params: {
  country: string;
  start?: string;
  end?: string;
  granularity?: Granularity;
}): Promise<LoadDataPoint[]> {
  const { data } = await api.get<ApiResponse<LoadDataPoint[]>>('/load', { params });
  return data.data;
}

export async function fetchLatestLoad(country?: string): Promise<LoadDataPoint | LoadDataPoint[]> {
  const { data } = await api.get<ApiResponse<LoadDataPoint | LoadDataPoint[]>>('/load/latest', {
    params: country ? { country } : undefined,
  });
  return data.data;
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
  return data.data;
}

// Price Data
export async function fetchPriceData(params: {
  country: string;
  start?: string;
  end?: string;
  granularity?: Granularity;
}): Promise<PriceDataPoint[]> {
  const { data } = await api.get<ApiResponse<PriceDataPoint[]>>('/prices', { params });
  return data.data;
}

export async function fetchLatestPrices(country?: string): Promise<PriceDataPoint | PriceDataPoint[]> {
  const { data } = await api.get<ApiResponse<PriceDataPoint | PriceDataPoint[]>>('/prices/latest', {
    params: country ? { country } : undefined,
  });
  return data.data;
}

export async function fetchPriceStats(params: {
  country: string;
  start?: string;
  end?: string;
}): Promise<{ avg: number; min: number; max: number; current: number }> {
  const { data } = await api.get<ApiResponse<{ avg: number; min: number; max: number; current: number }>>('/prices/stats', { params });
  return data.data;
}

export async function fetchPriceHeatmap(params: {
  country: string;
  days?: number;
}): Promise<PriceHeatmapPoint[]> {
  const { data } = await api.get<ApiResponse<PriceHeatmapPoint[]>>('/prices/heatmap', { params });
  return data.data;
}

// Renewable Data
export async function fetchRenewableData(params: {
  country: string;
  start?: string;
  end?: string;
  granularity?: Granularity;
}): Promise<RenewableDataPoint[]> {
  const { data } = await api.get<ApiResponse<RenewableDataPoint[]>>('/renewables', { params });
  return data.data;
}

export async function fetchRenewableMix(params: {
  country: string;
  start?: string;
  end?: string;
}): Promise<RenewableMix> {
  const { data } = await api.get<ApiResponse<RenewableMix>>('/renewables/mix', { params });
  return data.data;
}

// Dashboard Data
export async function fetchDashboardOverview(params: {
  country: string;
  timeRange?: TimeRange;
}): Promise<DashboardOverview> {
  const { data } = await api.get<ApiResponse<DashboardOverview>>('/dashboard/overview', { params });
  return data.data;
}

export async function fetchMapData(params: {
  metric?: MetricType;
  timeRange?: TimeRange;
}): Promise<MapDataPoint[]> {
  const { data } = await api.get<ApiResponse<MapDataPoint[]>>('/dashboard/map', { params });
  return data.data;
}

export async function fetchCombinedTimeseries(params: {
  country: string;
  start?: string;
  end?: string;
}): Promise<CombinedTimeseriesPoint[]> {
  const { data } = await api.get<ApiResponse<CombinedTimeseriesPoint[]>>('/dashboard/timeseries', { params });
  return data.data;
}

// Forecast Data
export async function fetchForecastData(params: {
  country: string;
  type: ForecastType;
  start?: string;
  end?: string;
  granularity?: Granularity;
  horizon?: MLHorizon;
}): Promise<ForecastDataPoint[]> {
  const { data } = await api.get<ApiResponse<ForecastDataPoint[]>>('/forecasts', { params });
  return data.data;
}

// Multi-horizon forecast data (D+1 and D+2 for overlay view)
export async function fetchMultiHorizonForecast(params: {
  country: string;
  type: ForecastType;
  start?: string;
  end?: string;
}): Promise<MultiHorizonForecastDataPoint[]> {
  const { data } = await api.get<ApiResponse<MultiHorizonForecastDataPoint[]>>('/forecasts/multi-horizon', { params });
  return data.data;
}

export async function fetchLatestForecast(params: {
  country: string;
  type?: ForecastType;
}): Promise<ForecastDataPoint[]> {
  const { data } = await api.get<ApiResponse<ForecastDataPoint[]>>('/forecasts/latest', { params });
  return data.data;
}

export async function fetchAvailableForecastTypes(country: string): Promise<string[]> {
  const { data } = await api.get<ApiResponse<string[]>>('/forecasts/types', { params: { country } });
  return data.data;
}

export async function fetchForecastComparison(params: {
  country: string;
  type: ForecastType;
  start?: string;
  end?: string;
}): Promise<ForecastComparisonData> {
  const { data } = await api.get<ApiResponse<ForecastComparisonData>>('/forecasts/compare', { params });
  return data.data;
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
  const { data } = await api.get<ApiResponse<TSOLoadForecastDataPoint[]>>(
    `/tso-forecast/load/${countryCode}`,
    { params: queryParams }
  );
  return data.data;
}

export async function fetchTSOGenerationForecast(params: {
  countryCode: string;
  start?: string;
  end?: string;
  granularity?: Granularity;
}): Promise<TSOGenerationForecastDataPoint[]> {
  const { countryCode, ...queryParams } = params;
  const { data } = await api.get<ApiResponse<TSOGenerationForecastDataPoint[]>>(
    `/tso-forecast/generation/${countryCode}`,
    { params: queryParams }
  );
  return data.data;
}

export async function fetchTSOLoadForecastAccuracy(params: {
  countryCode: string;
  start?: string;
  end?: string;
  forecastType?: TSOForecastType;
  granularity?: Granularity;
}): Promise<{ data: TSOForecastAccuracyDataPoint[]; metrics: TSOForecastAccuracyMetrics }> {
  const { countryCode, ...queryParams } = params;
  const { data } = await api.get<{
    success: boolean;
    data: TSOForecastAccuracyDataPoint[];
    metrics: TSOForecastAccuracyMetrics;
  }>(`/tso-forecast/accuracy/load/${countryCode}`, { params: queryParams });
  return { data: data.data, metrics: data.metrics };
}

export async function fetchTSOGenerationForecastAccuracy(params: {
  countryCode: string;
  type: 'solar' | 'wind_onshore' | 'wind_offshore';
  start?: string;
  end?: string;
  granularity?: Granularity;
}): Promise<{ data: TSOForecastAccuracyDataPoint[]; metrics: TSOForecastAccuracyMetrics }> {
  const { countryCode, ...queryParams } = params;
  const { data } = await api.get<{
    success: boolean;
    data: TSOForecastAccuracyDataPoint[];
    metrics: TSOForecastAccuracyMetrics;
  }>(`/tso-forecast/accuracy/generation/${countryCode}`, { params: queryParams });
  return { data: data.data, metrics: data.metrics };
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
  const { data } = await api.get<ApiResponse<{
    load: TSOForecastAccuracyMetrics;
    solar: TSOForecastAccuracyMetrics;
    wind_onshore: TSOForecastAccuracyMetrics;
    wind_offshore: TSOForecastAccuracyMetrics;
  }>>(`/tso-forecast/metrics/${countryCode}`, { params: queryParams });
  return data.data;
}

// Data Freshness
export async function fetchDataFreshness(countryCode: string): Promise<DataFreshness> {
  const { data } = await api.get<ApiResponse<DataFreshness>>(
    `/data-freshness/${countryCode}`
  );
  return data.data;
}

// Combined initial data endpoint - reduces round trips for country view
export async function fetchInitialCountryData(params: {
  country: string;
  timeRange?: TimeRange;
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
  return data.data;
}

// ============================================================================
// Forecast Comparison API (TSO vs ML Analytics)
// ============================================================================

/**
 * Fetch unified forecast comparison metrics (TSO vs ML)
 */
export async function fetchUnifiedForecastComparison(params: {
  countryCode: string;
  forecastType?: AnalyticsForecastType;
  start?: string;
  end?: string;
}): Promise<ForecastComparisonResponse> {
  const { countryCode, ...queryParams } = params;
  const { data } = await api.get<ApiResponse<ForecastComparisonResponse>>(
    `/forecast-comparison/${countryCode}`,
    { params: queryParams }
  );
  return data.data;
}

/**
 * Fetch forecast comparison summary for all types
 */
export async function fetchForecastComparisonSummary(params: {
  countryCode: string;
  start?: string;
  end?: string;
}): Promise<ForecastComparisonSummary> {
  const { countryCode, ...queryParams } = params;
  const { data } = await api.get<ApiResponse<ForecastComparisonSummary>>(
    `/forecast-comparison/${countryCode}/summary`,
    { params: queryParams }
  );
  return data.data;
}

/**
 * Fetch best performing forecast for a type
 */
export async function fetchBestForecast(params: {
  countryCode: string;
  forecastType?: AnalyticsForecastType;
  start?: string;
  end?: string;
}): Promise<BestForecastResponse | null> {
  const { countryCode, ...queryParams } = params;
  const { data } = await api.get<ApiResponse<BestForecastResponse | null>>(
    `/forecast-comparison/${countryCode}/best`,
    { params: queryParams }
  );
  return data.data;
}

/**
 * Fetch ML forecast accuracy data points
 */
export async function fetchMLForecastAccuracy(params: {
  countryCode: string;
  forecastType?: AnalyticsForecastType;
  start?: string;
  end?: string;
  horizon?: 1 | 2;
}): Promise<{ data: MLForecastAccuracyDataPoint[]; metrics: AccuracyMetrics }> {
  const { countryCode, ...queryParams } = params;
  const { data } = await api.get<{
    success: boolean;
    data: MLForecastAccuracyDataPoint[];
    metrics: AccuracyMetrics;
  }>(`/forecast-comparison/${countryCode}/ml-accuracy`, { params: queryParams });
  return { data: data.data, metrics: data.metrics };
}

/**
 * Fetch rolling accuracy metrics for trend chart
 */
export async function fetchRollingAccuracy(params: {
  countryCode: string;
  forecastType?: AnalyticsForecastType;
  start?: string;
  end?: string;
  windowDays?: number;
}): Promise<RollingAccuracyResponse> {
  const { countryCode, ...queryParams } = params;
  const { data } = await api.get<{ success: boolean } & RollingAccuracyResponse>(
    `/forecast-comparison/${countryCode}/rolling`,
    { params: queryParams }
  );
  return {
    data: data.data,
    windowDays: data.windowDays,
    meta: data.meta,
  };
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
  return pivotMetrics(data.data);
}

export default api;
