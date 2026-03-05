export interface Country {
  country_code: string;
  country_name: string;
  region?: string;
  timezone?: string;
}

export interface LoadDataPoint {
  timestamp?: string;
  date?: string;
  load?: number;
  avg_load?: number;
  max_load?: number;
  min_load?: number;
  quality?: string;
}

export interface PriceDataPoint {
  timestamp: string;
  price: number;
}

export interface RenewableDataPoint {
  timestamp: string;
  solar: number;
  wind_onshore: number;
  wind_offshore: number;
  hydro: number;
  biomass: number;
  geothermal: number;
  other: number;
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
  renewable_percentage?: number | null;
}

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

export interface CombinedTimeseriesPoint {
  date: string;
  load?: number;
  price?: number;
  solar?: number;
  wind_onshore?: number;
  wind_offshore?: number;
  hydro?: number;
  biomass?: number;
  geothermal?: number;
}

export interface PriceHeatmapPoint {
  day: number;
  hour: number;
  price: number;
}

// Legacy time range type (kept for backward compatibility)
export type TimeRange = '24h' | '7d' | '30d' | '90d' | '1y';

// App view navigation
export type AppView = 'map' | 'country' | 'comparison';

// New time navigation types
export type TimeAnchor = 'past' | 'now' | 'future';

export type TimePreset =
  // Historical (backward-looking from now)
  | '24h' | '7d' | '30d' | '90d' | '1y'
  // Around now (centered on current time)
  | 'today' | 'thisWeek'
  // Forecast (forward-looking from now)
  | 'next1d' | 'next24h' | 'next48h' | 'next7d';

export type Granularity = 'hourly' | 'daily' | 'weekly' | 'monthly';
export type MetricType = 'load' | 'price' | 'renewable_pct';

// Forecast types
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

export interface ForecastComparisonData {
  forecasts: ForecastDataPoint[];
  actuals: Array<{
    timestamp: string;
    value: number;
  }>;
}

// Multi-horizon forecast data point for D+1/D+2 overlay view
export interface MultiHorizonForecastDataPoint {
  timestamp: string;
  forecast_d1?: number;
  forecast_d2?: number;
}

// ML Forecast horizon type
export type MLHorizon = 1 | 2; // D+1 or D+2

export interface ForecastMetrics {
  mae: number;
  rmse: number;
  sampleSize: number;
}

// TSO Forecast types (ENTSO-E official forecasts)
export type TSOForecastType = 'day_ahead' | 'week_ahead' | 'all';

export interface TSOLoadForecastDataPoint {
  timestamp: string;
  forecast_value_mw: number;
  forecast_min_mw: number | null;
  forecast_max_mw: number | null;
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

export interface TSOForecastAccuracyDataPoint {
  timestamp: string;
  forecast_value: number;
  actual_value: number;
  error: number;
  error_pct: number;
}

export interface TSOForecastAccuracyMetrics {
  mae: number;
  mape: number;
  rmse: number;
  dataPoints: number;
}

export interface TSOForecastAccuracyResponse {
  data: TSOForecastAccuracyDataPoint[];
  metrics: TSOForecastAccuracyMetrics;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  meta?: {
    count?: number;
    timeRange?: { start: string; end: string };
    granularity?: Granularity;
  };
}

// Data freshness for latest data timestamps
export interface DataFreshness {
  load: string | null;
  price: string | null;
  generation: string | null;
  tsoLoadForecast: string | null;
  tsoGenerationForecast: string | null;
}

// ============================================================================
// Data Layers - Unified forecast visualization state
// ============================================================================

export type TSOHorizon = 'day_ahead' | 'week_ahead';

/**
 * Configuration for a single forecast layer
 */
export interface ForecastLayer {
  /** Whether this layer is visible on the chart */
  enabled: boolean;
  /** Whether to show accuracy comparison vs actuals (exclusive - only one layer can be in accuracy mode) */
  showAccuracy: boolean;
  /** Forecast horizon (TSO only) */
  horizon?: TSOHorizon;
}

/**
 * Unified state for all data layers in charts
 */
export interface LayersState {
  /** Show actual/measured data */
  showActuals: boolean;
  /** TSO (ENTSO-E) forecast layer configuration */
  tso: ForecastLayer;
  /** ML (custom trained model) forecast layer configuration */
  ml: ForecastLayer;
  // Future: Add more forecast sources here
  // external?: ForecastLayer;
}

/**
 * Available layer configuration for a specific chart type
 * Different charts support different layers
 */
export interface AvailableLayers {
  tso?: {
    available: boolean;
    horizons: TSOHorizon[];
    hasAccuracy: boolean;
  };
  ml?: {
    available: boolean;
    horizons: MLHorizon[];
    hasAccuracy: boolean;
  };
}

// ============================================================================
// Forecast Comparison Types
// ============================================================================

/**
 * Accuracy metrics for a single forecast source/horizon
 */
export interface AccuracyMetrics {
  mae: number;      // Mean Absolute Error (MW or EUR/MWh)
  mape: number;     // Mean Absolute Percentage Error (%)
  rmse: number;     // Root Mean Square Error
  bias: number;     // Mean Error (positive = over-forecast)
  dataPoints: number;
}

/**
 * TSO provider metrics (day-ahead and week-ahead horizons)
 */
export interface TSOProviderMetrics {
  dayAhead?: AccuracyMetrics;
  weekAhead?: AccuracyMetrics;
}

/**
 * ML provider metrics (D+1 and D+2 horizons)
 */
export interface MLProviderMetrics {
  d1?: AccuracyMetrics;  // D+1 (0-30 hours ahead)
  d2?: AccuracyMetrics;  // D+2 (24-54 hours ahead)
}

/**
 * Unified comparison response from API
 */
export interface ForecastComparisonResponse {
  tso: TSOProviderMetrics;
  ml: MLProviderMetrics;
  meta: {
    forecastType: string;
    countryCode: string;
    timeRange: { start: string; end: string };
    dataAvailability: {
      tso: { dayAhead: boolean; weekAhead: boolean };
      ml: { d1: boolean; d2: boolean };
    };
  };
}

/**
 * Summary comparison response (all forecast types)
 */
export interface ForecastComparisonSummary {
  [forecastType: string]: ForecastComparisonResponse;
}

/**
 * Best forecast response
 */
export interface BestForecastResponse {
  provider: 'tso' | 'ml';
  horizon: string;
  mape: number;
}

/**
 * ML forecast accuracy data point
 */
export interface MLForecastAccuracyDataPoint {
  timestamp: string;
  forecast_value: number;
  actual_value: number;
  error: number;
  error_pct: number;
  horizon_hours: number;
}

/**
 * ML forecast accuracy response
 */
export interface MLForecastAccuracyResponse {
  data: MLForecastAccuracyDataPoint[];
  metrics: AccuracyMetrics;
}

/**
 * Analytics forecast type (subset that supports analytics)
 */
export type AnalyticsForecastType = 'load' | 'price' | 'solar' | 'wind_onshore' | 'wind_offshore';

/**
 * Analytics time range presets (independent from global dashboard time)
 */
export type AnalyticsTimeRange = '7d' | '30d' | '90d' | 'all';

// ============================================================================
// Rolling Accuracy Types (for trend chart)
// ============================================================================

/**
 * Single data point in the rolling accuracy trend
 */
export interface RollingAccuracyDataPoint {
  date: string;  // YYYY-MM-DD format
  tso?: { mape: number; mae: number };
  ml_d1?: { mape: number; mae: number };
  ml_d2?: { mape: number; mae: number };
}

/**
 * Response from the rolling accuracy API
 */
export interface RollingAccuracyResponse {
  data: RollingAccuracyDataPoint[];
  windowDays: number;
  meta: {
    forecastType: string;
    countryCode: string;
    timeRange: { start: string; end: string };
  };
}

// ============================================================================
// Cross-Country Comparison Types
// ============================================================================

export interface CrossCountryMetricsEntry {
  mae: number;
  mape: number;
  rmse: number;
  bias: number;
  dataPoints: number;
}

export type CrossCountryMetrics = Record<string, Record<string, CrossCountryMetricsEntry>>;

// ============================================================================
// Forecast Provider Registry Types
// ============================================================================

export interface ForecastProviderInfo {
  id: string;
  type: 'tso' | 'ml';
  modelName?: string;
  horizon: string;
  label: string;
  shortLabel: string;
  color: string;
}

export interface AvailableProvidersResponse {
  tso: {
    available: boolean;
    horizons: string[];
  };
  ml: {
    models: Array<{
      model_name: string;
    }>;
  };
}
