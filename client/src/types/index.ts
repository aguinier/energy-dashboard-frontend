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

// Full A75 generation mix, sourced server-side from `energy_generation` (the
// complete ENTSO-E document) rather than the 8-column renewable-only
// narrowing above. Every field is independently nullable: a production type
// this country does not report reaches the client as `null`, never a
// fabricated `0` - see GenerationTab/sourceRows.ts, which render the two
// differently. `hydro_pumped` and the fossil types can be genuinely negative
// (net pumping, consumption-only readings).
export interface GenerationMix {
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
  // Renewable ÷ total positive generation, a ratio of window sums computed
  // server-side (generationService.getRenewableShare) - the same figure the
  // header's "Renewable share" stat card and the map's renewable_pct
  // choropleth read. The donut consumes this directly instead of re-deriving
  // a percentage from the fields above, so it cannot print a different
  // number than the header for the same country/window. Null when this
  // country has no energy_generation rows yet, or total positive generation
  // is zero/negative.
  renewable_percentage: number | null;
}

/**
 * One time bucket of the generation mix, with the 21 A75 `*_mw` columns
 * collapsed server-side into the nine families the Generation tab draws - the
 * same nine `buildSourceRows` groups the donut and by-source table into, so
 * the trend chart and the pie beside it cannot describe different mixes.
 *
 * Every group is independently nullable, and the null is load-bearing: it
 * means "this country reported none of this group's production types in this
 * bucket", never a measured zero. `hydro_pumped` (and `fossil`, for a
 * consumption-only type) can legitimately be negative - see
 * `dashboard/generationSeries.ts` for how that is drawn.
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
 * registered forecast models. Null means this country did not report that
 * type in this bucket, never a fabricated zero.
 */
export interface WindGenerationSeriesPoint {
  timestamp: string;
  wind_onshore: number | null;
  wind_offshore: number | null;
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

// App view navigation
export type AppView = 'map' | 'country' | 'comparison';

// New time navigation types
export type TimeAnchor = 'past' | 'now' | 'future';

// `90d` and `1y` were removed here (ABL-4): no control could set them, so no
// user could reach them and nothing exercised their branches. Adding a preset
// means updating six places; five of them are a compile error if you don't,
// by two different mechanisms:
//
//   - keyed `Record<TimePreset, …>`, so the missing key is named directly:
//     `PRESET_SHIFT_HOURS` (lib/constants.ts), `WINDOW_LABEL`
//     (components/dashboard/windowLabel.ts), `ANCHOR_FOR_PRESET`
//     (store/migrate.ts — `VALID_TIME_PRESETS` derives from its keys).
//   - a `const unhandled: never = preset` in the `default` branch, so the new
//     value is reported as not assignable to `never`: `getDateRangeForPreset`
//     and `getGranularityForPreset` (hooks/useDashboardData.ts).
//
// The sixth — giving the preset a control — cannot be a compile error: a
// preset with no button is unreachable, not ill-typed, which is how `today`,
// `thisWeek`, `next1d` and `next48h` sat here unreachable until ABL-12 wired
// the categorised picker. It is a *test* failure instead —
// components/dashboard/timePresets.test.ts asserts the picker covers every
// key of `WINDOW_LABEL`, which the compiler guarantees is this whole union.
//
// The `never` guards are load-bearing, not stylistic. Both functions end in a
// `default` that yields a trailing 7-day hourly window, so a preset with no
// case there used to compile clean and render numbers computed over the last
// 7 days beneath that preset's own label — `WINDOW_LABEL`, being exhaustive,
// would have named it correctly. A confidently mislabelled window is the
// failure this dashboard exists to prevent.
export type TimePreset =
  // Historical (backward-looking from now)
  | '24h' | '7d' | '30d'
  // Around now (centered on current time)
  | 'today' | 'thisWeek'
  // Forecast (forward-looking from now)
  | 'next1d' | 'next24h' | 'next48h' | 'next7d';

export type Granularity = 'hourly' | 'daily' | 'weekly' | 'monthly';
export type MetricType = 'load' | 'price' | 'renewable_pct' | 'net_position';

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

/** ENTSO-E day-ahead generation forecast — solar and wind bundled per row, day-ahead only (no week-ahead registered for generation). */
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
  error_pct: number | null; // null when actual_value <= 0 — unmeasurable as a percentage
}

export interface TSOForecastAccuracyMetrics {
  mae: number | null;
  mape: number | null;
  rmse: number | null;
  dataPoints: number;
  /** Count of points with a positive actual — may be lower than dataPoints; mape covers only these. */
  mapeSamples: number;
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

// Data freshness — per stream, is what we are drawing actually current?
//
// ABL-60. These used to be five bare timestamps, which left the verdict to the
// caller, and the caller never made one: the header pulsed a green "live" dot
// beside GB's five-year-old load and said nothing at all through the
// 2026-08-06 ENTSO-E outage. The status now comes from the server, next to the
// ingest schedule and the measurements that size it (`services/freshness.ts`).

export type FreshnessStatus =
  /** New enough that no scheduled ingest pass can have been missed. */
  | 'live'
  /** Provably behind: at least one scheduled pass stored nothing for it. */
  | 'stale'
  /** Formerly held, but upstream has published nothing across many passes. */
  | 'ended'
  /** No rows at all. Not a health verdict — we have never held this stream. */
  | 'none';

export interface FreshnessStream {
  /** Newest *usable* stored timestamp, verbatim from the database. */
  latest: string | null;
  /**
   * `now - latest`, in hours, signed, computed server-side. **Negative is
   * normal for a day-ahead stream** — tomorrow's auction result is dated into
   * the future by design.
   *
   * Prefer this over re-parsing `latest` in the browser. The same column holds
   * both `2026-08-07T05:45:00` and `2026-08-07 05:45:00` (CLAUDE.md,
   * "Timestamp storage: two separators in one column") and `new Date` reads the
   * space form as **local** time, so the header's age was understated by the
   * viewer's UTC offset — two hours, in Brussels, on the ~90% of `energy_load`
   * rows that use a space.
   */
  ageHours: number | null;
  status: FreshnessStatus;
}

export interface DataFreshness {
  load: FreshnessStream;
  price: FreshnessStream;
  generation: FreshnessStream;
  tsoLoadForecast: FreshnessStream;
  tsoGenerationForecast: FreshnessStream;
}

// ============================================================================
// Ops status (ABL-237 host/process KPIs, ABL-238 acceptance/prod comparison)
// ============================================================================
// Mirrors server/src/services/opsStatusService.ts, peerOpsStatus.ts and
// combinedOpsStatusService.ts. The internal /ops-status page (OpsStatusView)
// is the only reader.

export interface HealthProvenance {
  commit: string | null;
  runtime: 'container' | 'dev';
  db_path: string;
}

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

export interface CpuLoad {
  load1: number;
  load5: number;
  load15: number;
}

export interface ProcessMetrics {
  uptimeSeconds: number;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
  };
}

/**
 * One interface's counters and derived rates (ABL-290). The `BytesPerSec` pair
 * is `null` until the server has two samples to difference, and again whenever
 * a counter resets under it — never a fabricated rate.
 */
export interface NetworkInterfaceThroughput {
  name: string;
  rxBytes: number;
  txBytes: number;
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
  sampleWindowMs: number | null;
}

/** Fleet-wide worst-case rollup over every country's `DataFreshness` — see `freshnessRollup.ts`. */
export interface FreshnessRollup {
  status: FreshnessStatus;
  countriesChecked: number;
  streamsChecked: number;
  counts: Record<FreshnessStatus, number>;
  staleCountries: string[];
}

export interface OpsStatus {
  timestamp: string;
  provenance: HealthProvenance;
  host: {
    platform: string;
    disk: DiskUsage | null;
    cpuLoad: CpuLoad | null;
    /**
     * `null` on a platform with no counters to read; **absent** when the peer
     * runs a build older than ABL-290. The two are rendered differently and
     * neither is zero — see `lib/networkRows.ts`.
     */
    network?: NetworkInterfaceThroughput[] | null;
  };
  process: ProcessMetrics;
  freshness: FreshnessRollup;
}

/** One environment's status, or why it could not be reached — never a thrown error. */
export type OpsSideStatus =
  | { reachable: true; latencyMs: number; status: OpsStatus }
  | { reachable: false; latencyMs: number | null; error: string };

/** ABL-220's twice-daily DB-sync write-lock window — see `syncBlackoutWindow.ts`. */
export interface SyncBlackoutStatus {
  active: boolean;
  label: string | null;
}

/**
 * The server's warn/error verdict for one KPI (ABL-292).
 *
 * This union used to be the client's own `lib/opsStatusThresholds.ts`, which
 * also owned `DISK_WARN_RATIO`/`DISK_ERROR_RATIO`. The thresholds now live in
 * `server/src/lib/opsStatusThresholds.ts` — a scheduled alert job (ABL-287)
 * cannot import browser code, and two copies of a threshold is how a page
 * reads "fine" while a pager reads "critical". Only the type is mirrored here,
 * the same way every other type in this block mirrors a server response;
 * nothing on the client decides where a threshold sits any more.
 */
export type ThresholdState = 'ok' | 'warn' | 'error' | 'unknown';

/** Per-KPI verdicts for one lane, plus the worst-wins roll-up the badge renders. */
export interface OpsSideDerived {
  environment: ThresholdState;
  disk: ThresholdState;
  freshness: ThresholdState;
}

export interface CombinedOpsStatus {
  timestamp: string;
  local: OpsSideStatus;
  peer: OpsSideStatus;
  peerConfigured: boolean;
  syncBlackout: SyncBlackoutStatus;
  /** Server-derived state for both lanes (ABL-292) — see `ThresholdState`. */
  derived: {
    local: OpsSideDerived;
    peer: OpsSideDerived;
    /**
     * Whether the lanes are on the same build (ABL-287). A cross-lane
     * comparison, so it sits beside the per-side verdicts rather than inside
     * either. `unknown` whenever there is nothing to compare — a side
     * unreachable, or a side reporting no commit (a dev server) — which is why
     * the banner keys on `'warn'` rather than on inequality.
     */
    commitDrift: ThresholdState;
  };
}

// ============================================================================
// Data Layers
// ============================================================================
// The unified `LayersState`/`ForecastLayer`/`AvailableLayers` trio that used
// to live here was removed as dead code (Task 22 review: no reader, no
// caller of any of its store actions, after LoadTab moved to the model
// picker as the single source of truth for the overlay). `TSOHorizon` is
// kept — it's still used by useLoadChartData.ts and the analytics config.

export type TSOHorizon = 'day_ahead' | 'week_ahead';

// ============================================================================
// Forecast Comparison Types
// ============================================================================

/**
 * Accuracy metrics for a single forecast source/horizon
 */
export interface AccuracyMetrics {
  mae: number;      // Mean Absolute Error (MW or EUR/MWh)
  mape: number | null; // Mean Absolute Percentage Error (%) — null when no point had a measurable (positive) actual
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
 * Why an ML accuracy window produced the metrics it did. Mirrors the server's
 * `MLAccuracyCoverage` (`server/src/services/mlForecastService.ts:59`).
 *
 * `no_model_coverage` is a NORMAL answer, not an error: catboost and xgboost
 * cover disjoint country sets, so for any one country roughly half the
 * registered models legitimately have nothing. It exists so that case is
 * distinguishable from a measurement — a model that does not serve a country
 * must never render as a flawless 0% error.
 */
export type MLAccuracyCoverage = 'served' | 'no_model_coverage' | 'no_paired_actuals';

/** Per-model ML accuracy metrics. Every null means "not measurable", never zero. */
export interface MLForecastAccuracyMetrics {
  mae: number | null;
  mape: number | null;   // null when no point in the window had a positive actual
  rmse: number | null;
  bias: number | null;
  dataPoints: number;
  /** Count of points MAPE was computed over; <= dataPoints. */
  mapeSamples: number;
}

/**
 * `/forecast-comparison/:cc/ml-accuracy`, minus the hourly point array the
 * callers of this type do not read.
 */
export interface MLForecastAccuracyResult {
  metrics: MLForecastAccuracyMetrics;
  coverage: MLAccuracyCoverage;
  /** Which model was pinned. `null` means unpinned — NOT "the production model". */
  model: string | null;
}

// ============================================================================
// Cross-Country Comparison Types
// ============================================================================

/**
 * Skill vs the D-7 seasonal-naive baseline, on the same pair intersection the
 * WAPE beside it was measured on — never a larger sample. `skillPct` is
 * `null` (not 0) when `n` is 0 or the baseline itself has no measurable WAPE;
 * callers must render an explicit insufficient-data state in that case, not a
 * dash or a coerced 0 (ABL-186).
 */
export interface SkillVsSeasonalNaive {
  n: number;
  skillPct: number | null;
  baselineWape: number | null;
}

export interface CrossCountryMetricsEntry {
  mae: number;
  wape: number | null;
  rmse: number;
  bias: number;
  dataPoints: number;
  /**
   * Optional so the many hand-built `CrossCountryMetricsEntry` literals in
   * existing tests (leaderboardRows.test.ts, portfolioHome.test.ts,
   * portfolioSummary.test.ts) keep compiling without this field. Treat a
   * missing value the same as `{ n: 0, skillPct: null, baselineWape: null }`.
   */
  skillVsSeasonalNaive?: SkillVsSeasonalNaive;
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
  /** null when the backend has no forecast_quantiles table yet. */
  p10: number | null;
  p90: number | null;
  /** Vintage that won for THIS timestamp — the freshest run covering it. */
  generated_at: string;
  /** `forecasts.horizon_hours` has no NOT NULL constraint; null means unknown. */
  horizon_hours: number | null;
}

/**
 * One forecast run's footprint within `forecast`. Several vintages can be
 * present at once — a daily D+2 job leaves yesterday's run and today's run
 * covering different target days simultaneously — so this is a list, not a
 * single generated_at/model_version pair.
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

/**
 * Why `forecast` holds what it does.
 *
 * `degenerate_zero` is the one that needs explaining: the model DID produce
 * rows for this window and every one of them is numerically zero, so the
 * server withheld them (`server/src/services/degenerateForecast.ts`). Drawn,
 * they are a flat line at 0 MW under a hairline band — which reads as an
 * unusually *confident* forecast rather than a missing one.
 */
export type NetPositionForecastCoverage = 'served' | 'no_forecast' | 'degenerate_zero';

/**
 * The same three-way answer for the *actuals* half of the payload.
 *
 * `degenerate_zero` here is a separate defect from the forecast one above, not
 * the same bug seen twice: GR has published `net_position` rows of exactly
 * `0.0` since 2025-10-01 (192 of 192), while its own `crossborder_flows` show a
 * median net export of 1,142 MW over the very same hours. Drawn, that is a flat
 * line at 0 MW labelled "ENTSO-E day-ahead" — a measurement, and wrong by more
 * than a gigawatt.
 */
export type NetPositionActualCoverage = 'served' | 'no_actuals' | 'degenerate_zero';

export interface NetPositionResponse {
  actual: NetPositionActualPoint[];
  forecast: NetPositionForecastPoint[];
  meta: {
    /** Zone actually queried — DE and LU both report DE_LU. */
    bidding_zone: string;
    model_name: string | null;
    /** Distinct forecast runs present in `forecast`, newest first. */
    vintages: NetPositionForecastVintage[];
    has_band: boolean;
    /**
     * Newest *usable* published hour for this zone, ignoring the query window.
     * A day whose values are all numerically zero does not count as published.
     */
    last_seen: string | null;
    /** An empty `forecast` is never self-explaining — this says which empty. */
    forecast_coverage: NetPositionForecastCoverage;
    /**
     * The withheld series, present only when `forecast_coverage` is
     * `degenerate_zero`. `null` otherwise, including `served` — so a reader
     * can never mistake an absent measurement for a measured zero.
     */
    degenerate_forecast: { points: number; max_abs_mw: number } | null;
    /** An empty `actual` is never self-explaining either — same three states. */
    actual_coverage: NetPositionActualCoverage;
    /**
     * The withheld actuals, present only when `actual_coverage` is
     * `degenerate_zero`. `null` otherwise.
     */
    degenerate_actual: { points: number; max_abs_mw: number } | null;
  };
}

/**
 * Why a Core net position series is empty (ABL-234). Four claims, and the UI
 * has to tell them apart — `out_of_core` is "no such number exists for this
 * zone", which the map must not draw with the same meaning as a data gap.
 * Mirrors `server/src/services/coreNetPositionService.ts`.
 */
export type CoreNetPositionCoverage =
  | 'served'
  | 'no_data'
  | 'out_of_core'
  | 'not_captured';

/**
 * The Core CCR net position: exchanges inside the 12-zone Core flow-based
 * region only, published by JAO. A DIFFERENT quantity from
 * `NetPositionResponse`'s all-coupled-borders figure, not a correction of it —
 * they can disagree in sign. There is no forecast half: nothing in this
 * dashboard forecasts the Core figure.
 */
export interface CoreNetPositionResponse {
  actual: Array<{ timestamp: string; net_position_mw: number }>;
  meta: {
    country_code: string;
    /** DE and LU both report DE_LU, exactly as the all-coupled figure does. */
    bidding_zone: string;
    in_core: boolean;
    coverage: CoreNetPositionCoverage;
    /** Newest stored hour for this zone, ignoring the query window. */
    last_seen: string | null;
  };
}

// ---------------------------------------------------------------------------
// Forecast model registry — served by GET /api/forecasts/models.
// The picker renders from this, so a model can only reach the UI by being
// registered server-side.
// ---------------------------------------------------------------------------

export type ForecastSource = 'ml' | 'tso';

export interface ForecastModel {
  id: string;
  label: string;
  source: ForecastSource;
  modelName?: string;
  tsoHorizon?: 'day_ahead' | 'week_ahead';
}

export interface ForecastTypeConfig {
  production: string;
  models: ForecastModel[];
}

export type ForecastModelRegistry = Record<string, ForecastTypeConfig>;
