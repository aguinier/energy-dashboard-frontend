// The types here that are owned elsewhere: the rule that decides them lives
// in the service, next to the measurements that justify its threshold.
import type {
  NetPositionActualCoverage,
  NetPositionForecastCoverage,
} from '../services/degenerateForecast.js';
export type { NetPositionActualCoverage, NetPositionForecastCoverage };

import type { SolarCoverage, SolarCoverageVerdict } from '../services/solarCoverage.js';
export type { SolarCoverage, SolarCoverageVerdict };

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

// Renewable generation by source, read from `energy_generation` since ABL-324
// tranche 1 - not the frozen `energy_renewable`, which stored one instant
// under several timestamp spellings (26,694 duplicate instants, measured
// 2026-08-12) and carried `DEFAULT 0`.
//
// Every field is nullable *because* of that move. On the frozen table these
// were `number`, and the queries wrapped each column in `COALESCE(x, 0)`, so
// a type a country does not report reached the client as a confident `0 MW`.
// On `energy_generation` an unreported type is NULL and stays NULL. `total`
// is null only when all seven fields are - see services/renewableTotal.ts.
export interface RenewableMix {
  solar: number | null;
  wind_onshore: number | null;
  wind_offshore: number | null;
  hydro: number | null;
  biomass: number | null;
  geothermal: number | null;
  other: number | null;
  total: number | null;
  renewable_percentage?: number | null;
}

export interface RenewableTimeSeriesPoint {
  timestamp: string;
  solar: number | null;
  wind_onshore: number | null;
  wind_offshore: number | null;
  hydro: number | null;
  biomass: number | null;
  geothermal: number | null;
  other: number | null;
}

// Full A75 generation mix, sourced from `energy_generation` (the complete
// document ENTSO-E returns) rather than `energy_renewable`'s 8-column
// narrowing. Every field is nullable on purpose: a production type a country
// does not report must reach the wire as `null`, never a fabricated `0` -
// see generationService.ts. `hydro_pumped` and the fossil types can be
// legitimately negative (net pumping / consumption-only readings).
export interface GenerationMix {
  // renewables - same underlying values as RenewableMix's fields, but read
  // from energy_generation so one query serves the whole source mix.
  solar: number | null;
  wind_onshore: number | null;
  wind_offshore: number | null;
  hydro_run: number | null;
  hydro_reservoir: number | null;
  hydro_pumped: number | null;
  biomass: number | null;
  geothermal: number | null;
  marine: number | null;
  other_renewable: number | null;
  energy_storage: number | null;
  // previously discarded by _map_renewable_columns
  nuclear: number | null;
  fossil_gas: number | null;
  fossil_hard_coal: number | null;
  fossil_brown_coal: number | null;
  fossil_oil: number | null;
  fossil_oil_shale: number | null;
  fossil_peat: number | null;
  fossil_coal_derived_gas: number | null;
  waste: number | null;
  other: number | null;
  // Renewable ÷ total positive generation, a ratio of window sums over this
  // same table - see generationService.getRenewableShare. Computed
  // server-side and attached here (not left for the client to re-derive from
  // the fields above) so the Generation tab's donut and the header's
  // "Renewable share" stat card can never print different numbers for the
  // same window. Null when this country has no energy_generation rows in the
  // window, or when total positive generation is zero/negative.
  renewable_percentage: number | null;
  // Whether `solar` above can carry an unqualified "Solar" label, or is a
  // grid-metered subset of the country's real solar output (ABL-325 - NL
  // reports ~2% of its fleet into this feed). Measured against ENTSO-E's own
  // day-ahead solar forecast for the same hours; see solarCoverage.ts for the
  // test, the thresholds, and why this is never a correction factor. Always
  // present - a country that could not be checked reads `unknown`, which is
  // not the same claim as `consistent`.
  solar_coverage: SolarCoverage;
}

/**
 * One time bucket of the generation mix, with the 21 A75 `*_mw` columns
 * collapsed into the nine families the Generation tab's stacked chart draws -
 * the same nine `buildSourceRows` groups the donut and by-source table into
 * client-side. See generationService.GENERATION_GROUPS for the membership.
 *
 * Every group is independently nullable and that null is load-bearing: it
 * means "this country reported none of this group's production types in this
 * bucket", never a measured zero. `hydro_pumped` (and, for a consumption-only
 * type, `fossil`) can legitimately be negative.
 */
export interface GenerationSeriesPoint {
  timestamp: string;
  nuclear: number | null;
  solar: number | null;
  wind: number | null;
  hydro: number | null;
  hydro_pumped: number | null;
  fossil: number | null;
  biomass: number | null;
  waste: number | null;
  other: number | null;
}

/**
 * Onshore/offshore wind actuals over time, kept separate rather than summed
 * into GenerationSeriesPoint's combined `wind` family (ABL-235) - the wind
 * forecast tab plots and compares each type independently against its own
 * forecast, which a combined figure cannot support. Same NULL-vs-0 rule as
 * every other `energy_generation` reader: null means this country did not
 * report that type in this bucket, never a fabricated zero.
 */
export interface WindGenerationSeriesPoint {
  timestamp: string;
  wind_onshore: number | null;
  wind_offshore: number | null;
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
    /**
     * Newest USABLE published hour for this zone, ignoring the query window.
     * A day whose values are all numerically zero is not a day this zone
     * published - see `getLastSeen`.
     */
    last_seen: string | null;
    /**
     * Why `actual` holds what it does. `degenerate_zero` means rows WERE
     * published for this window and every one of them is numerically zero, so
     * they were withheld - GR since 2025-10-01, contradicted by its own
     * cross-border flows. An empty `actual` is never self-explaining.
     */
    actual_coverage: NetPositionActualCoverage;
    /**
     * The withheld actuals, present only when `actual_coverage` is
     * `degenerate_zero`, so the client can state the evidence rather than an
     * unexplained gap. `null` in every other state.
     */
    degenerate_actual: { points: number; max_abs_mw: number } | null;
    /**
     * Why `forecast` holds what it does. `degenerate_zero` means the model DID
     * produce rows and they are all numerically zero, so they were withheld -
     * see `degenerateForecast.ts`. An empty `forecast` is never self-explaining.
     */
    forecast_coverage: NetPositionForecastCoverage;
    /**
     * The withheld series, present only when `forecast_coverage` is
     * `degenerate_zero`, so the client can state the evidence rather than an
     * unexplained gap. `null` in every other state - including `served`, where
     * nothing was withheld.
     */
    degenerate_forecast: { points: number; max_abs_mw: number } | null;
  };
}

export interface NetPositionForecastIngestRow {
  country_code: string;
  target_timestamp_utc: string;
  horizon_hours: number;
  forecast_value: number;
  quantiles?: Record<string, number>;
}

/**
 * Which `forecasts` row this payload writes under. Optional and defaults to
 * 'net_position' (ABL-240) — the external Chronos-2 job that has posted here
 * since before this field existed never sends it, and must keep working
 * unmodified. wind_onshore/wind_offshore were added for the ABL-239 backfill
 * of ABL-195's retrained shadow-candidate artifacts.
 */
export type ForecastIngestType = 'net_position' | 'wind_onshore' | 'wind_offshore';

export interface NetPositionForecastIngestPayload {
  forecast_type?: ForecastIngestType;
  model: { name: string; version: string };
  generated_at: string;
  rows: NetPositionForecastIngestRow[];
}

// Data freshness — the server owns these verdicts; callers render them.
export type FreshnessStatus =
  | 'live'
  | 'stale'
  /** The upstream series has received no newer row across many ingest passes. */
  | 'ended'
  | 'none';

export interface FreshnessStream {
  latest: string | null;
  ageHours: number | null;
  status: FreshnessStatus;
}

// Ingest passes — when did we last go and look, and did anything arrive?
// Sourced from `data_ingestion_log`, NOT from `publication_timestamp_utc`,
// which records our own fetch time and drifts up to 39.1 days from the row it
// stamps (ABL-286's audit). See `services/ingestLog.ts` for the whole argument.

/** The streams the dashboard draws, as `INGEST_PIPELINES` maps them. */
export type IngestStreamKey =
  | 'load'
  | 'price'
  | 'generation'
  | 'tsoLoadForecast'
  | 'tsoGenerationForecast'
  | 'netPosition';

/**
 * The relationship between the last pass and the last pass that brought rows.
 * Four distinct claims — see `classifyDelivery` for why none may be collapsed
 * into another.
 */
export type IngestDelivery =
  | 'flowing'
  | 'checked_no_data'
  | 'never_delivered'
  | 'not_logged';

/** One `pipeline_type`'s two timestamps, before merging into a stream. */
export interface PipelinePass {
  pipelineType: string;
  lastChecked: string | null;
  lastStoredRows: string | null;
}

export interface StreamRefresh {
  /** Newest `end_time` over completed passes. When we last went and looked. */
  lastChecked: string | null;
  /**
   * Newest `end_time` over completed passes that wrote at least one row.
   *
   * Never substitute `lastChecked` for this — that is the defect the endpoint
   * exists to prevent. And do NOT read it as "the data got newer": the ingest
   * upserts a rolling 7-day window, so a rewrite of a row we already held
   * counts. AL load has been frozen at `2026-08-06 21:45` since its upstream
   * stall while still storing hundreds of rows a pass. See
   * `services/ingestLog.ts`.
   */
  lastStoredRows: string | null;
  delivery: IngestDelivery;
  /** Which `pipeline_type` rows were folded in, so the answer is auditable. */
  pipelines: string[];
}

export interface IngestFreshness {
  load: StreamRefresh;
  price: StreamRefresh;
  generation: StreamRefresh;
  tsoLoadForecast: StreamRefresh;
  tsoGenerationForecast: StreamRefresh;
  netPosition: StreamRefresh;
  /**
   * The earliest pass anywhere in the log. `not_logged` means "the log cannot
   * answer", and without this a reader cannot tell that from "never ran" —
   * the log itself only starts 2025-12-23. `null` if the log is empty.
   */
  logStartsAt: string | null;
}
