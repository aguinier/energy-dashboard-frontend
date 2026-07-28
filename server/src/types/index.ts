// Country types
export interface Country {
  country_code: string;
  country_name: string;
  region?: string;
  timezone?: string;
}

// Energy load types
export interface EnergyLoad {
  timestamp_utc: string;
  country_code: string;
  load_mw: number;
  data_quality?: string;
}

export interface LoadDataPoint {
  timestamp: string;
  load: number;
  quality?: string;
}

export interface AggregatedLoad {
  date: string;
  avg_load: number;
  max_load: number;
  min_load: number;
}

// Energy price types
export interface EnergyPrice {
  timestamp_utc: string;
  country_code: string;
  price_eur_mwh: number;
  data_quality?: string;
}

export interface PriceDataPoint {
  timestamp: string;
  price: number;
}

export interface PriceStats {
  avg: number;
  min: number;
  max: number;
  current: number;
}

// Renewable energy types
export interface RenewableData {
  timestamp_utc: string;
  country_code: string;
  solar_mw?: number;
  wind_onshore_mw?: number;
  wind_offshore_mw?: number;
  hydro_mw?: number;
  biomass_mw?: number;
  geothermal_mw?: number;
  other_renewable_mw?: number;
  total_renewable_mw?: number;
}

export interface RenewableMix {
  solar: number;
  wind_onshore: number;
  wind_offshore: number;
  hydro: number;
  biomass: number;
  geothermal: number;
  other: number;
  total: number;
  renewable_percentage?: number;
}

export interface RenewableTimeSeriesPoint {
  timestamp: string;
  solar: number;
  wind_onshore: number;
  wind_offshore: number;
  hydro: number;
  biomass: number;
  geothermal: number;
  other: number;
}

// Dashboard types
export interface DashboardOverview {
  currentLoad: number | null;
  avgPrice: number | null;
  renewablePercentage: number | null;
  peakDemand: number | null;
  priceChange24h?: number;
  loadChange24h?: number;
  dataTimestamp?: string;
}

export interface MapDataPoint {
  country_code: string;
  country_name: string;
  value: number;
  timestamp?: string;
}

// Forecast types (ML forecasts)
export type ForecastType =
  | 'load'
  | 'price'
  | 'renewable'
  | 'solar'
  | 'wind_onshore'
  | 'wind_offshore'
  | 'hydro_total'
  | 'biomass';

export interface ForecastDataPoint {
  timestamp: string;
  value: number;
  type: string;
  generated_at: string;
  horizon_hours: number;
  model_name?: string;
  model_version?: string;
}

// TSO Forecast types (ENTSO-E official forecasts)
export type TSOForecastType = 'day_ahead' | 'week_ahead' | 'all';

export interface TSOLoadForecastDataPoint {
  timestamp: string;
  forecast_value_mw: number;
  forecast_type: string;
  publication_timestamp_utc: string | null;
}

export interface TSOGenerationForecastDataPoint {
  timestamp: string;
  solar_mw: number | null;
  wind_onshore_mw: number | null;
  wind_offshore_mw: number | null;
  total_forecast_mw: number | null;
}

// Query parameter types
export type Granularity = 'hourly' | 'daily' | 'weekly' | 'monthly';
export type TimeRange = '24h' | '7d' | '30d' | '90d' | '1y' | 'custom';
export type MetricType = 'load' | 'price' | 'renewable_pct' | 'net_position';

export interface TimeRangeParams {
  start?: string;
  end?: string;
  timeRange?: TimeRange;
}

export interface QueryParams extends TimeRangeParams {
  country?: string;
  countries?: string[];
  granularity?: Granularity;
  metric?: MetricType;
}

// API response wrapper
export interface ApiResponse<T> {
  success: boolean;
  data: T;
  meta?: {
    count?: number;
    timeRange?: { start: string; end: string };
    granularity?: Granularity;
  };
}

export interface ApiError {
  success: false;
  error: string;
  code?: string;
}

// ---------------------------------------------------------------------------
// Net position (day-ahead, per bidding zone). Positive = net exporter.
// ---------------------------------------------------------------------------

export interface NetPositionActualPoint {
  timestamp: string;
  net_position_mw: number;
}

export interface NetPositionForecastPoint {
  timestamp: string;
  p50: number;
  /** null when the deployment has no forecast_quantiles table yet. */
  p10: number | null;
  p90: number | null;
  /** Vintage that won for THIS timestamp - the freshest run covering it. */
  generated_at: string;
  /** `forecasts.horizon_hours` has no NOT NULL constraint; null means unknown. */
  horizon_hours: number | null;
}

/**
 * One forecast run's footprint within the returned points. Several vintages
 * can be present at once - see `getNetPositionForecast` - so `meta` reports
 * each one honestly rather than picking a single generated_at/model_version
 * to speak for the whole series.
 */
export interface NetPositionForecastVintage {
  generated_at: string;
  model_version: string | null;
  /** null when every row in this vintage had a null horizon_hours. */
  horizon_hours_min: number | null;
  horizon_hours_max: number | null;
  target_count: number;
  first_target: string;
  last_target: string;
}

export interface NetPositionResponse {
  actual: NetPositionActualPoint[];
  forecast: NetPositionForecastPoint[];
  meta: {
    /** Zone actually queried - DE and LU both report DE_LU. */
    bidding_zone: string;
    model_name: string | null;
    /** Distinct forecast runs present in `forecast`, newest first. */
    vintages: NetPositionForecastVintage[];
    /** False when only the median is available. */
    has_band: boolean;
    /** Newest published hour for this zone, ignoring the query window. */
    last_seen: string | null;
  };
}

export interface NetPositionForecastIngestRow {
  country_code: string;
  target_timestamp_utc: string;
  horizon_hours: number;
  forecast_value: number;
  quantiles?: Record<string, number>;
}

export interface NetPositionForecastIngestPayload {
  model: { name: string; version: string };
  generated_at: string;
  rows: NetPositionForecastIngestRow[];
}
