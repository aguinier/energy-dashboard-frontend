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

// Renewable generation by source. Served from `energy_generation` since
// ABL-324 tranche 1, not the frozen `energy_renewable`. Every field is
// independently nullable for the same reason GenerationMix's are: a
// production type this country does not report reaches the client as `null`,
// never a fabricated `0`. It is a real change - the frozen table carried
// `DEFAULT 0` and the old queries wrapped every column in `COALESCE(x, 0)`,
// so these used to arrive as a confident `0 MW`. Do not render a null as a
// zero; render it as a gap.
export interface RenewableDataPoint {
  timestamp: string;
  solar: number | null;
  wind_onshore: number | null;
  wind_offshore: number | null;
  hydro: number | null;
  biomass: number | null;
  geothermal: number | null;
  other: number | null;
}

// `total` is null only when all seven fields are null - the sum of whichever
// were reported otherwise, and `0` when every reported value is a measured
// zero. The whole object is null when the window holds no rows at all.
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

/**
 * Why the `solar` field below can, or cannot, carry an unqualified "Solar"
 * label (ABL-325). Structural mirror of the server's `SolarCoverage`, which
 * owns the rule and the thresholds - see `server/src/services/solarCoverage.ts`.
 *
 * `unknown` is a real verdict and is not `consistent`: it means the check
 * could not run (too few paired hours, or a country that reports essentially
 * no solar either side), so the label stands only because nothing contradicted
 * it. The UI must render it as no caveat, never as a reassurance.
 */
export type SolarCoverageVerdict = 'consistent' | 'partial_subset' | 'unknown';

export interface SolarCoverage {
  verdict: SolarCoverageVerdict;
  /** Paired hours the verdict rests on. */
  pairs: number;
  /** Summed MW of ENTSO-E's own day-ahead solar forecast over those hours. */
  forecastSumMw: number;
  /** Summed MW of the reported solar actuals over the same hours. */
  actualSumMw: number;
  /**
   * `forecastSumMw / actualSumMw`, 1dp. Null when the actual sum is zero - the
   * ratio does not exist. **Not a correction factor**: the day-ahead forecast
   * is itself only what the TSO can see, so this is a lower bound on a
   * discrepancy and must never be rendered as "solar is N times higher".
   */
  ratio: number | null;
  /** Days of history the verdict was computed over. */
  referenceDays: number;
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
  // Whether `solar` above is this country's solar output or only the
  // grid-metered part of it (ABL-325). Arrives in this payload rather than
  // from a separate request specifically so the number and its caveat cannot
  // be rendered apart. Optional on the wire so a client running against an
  // older server degrades to "no verdict" rather than crashing; treat a
  // missing value exactly like `unknown`.
  solar_coverage?: SolarCoverage;
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

/**
 * Whether the country's realized load and its TSO load forecast measure the
 * same quantity. `divergent_basis` is NOT a "no data" word — both series are
 * held in full; it is the error measures derived from the pair that are not
 * publishable. See `server/src/services/loadForecastBasis.ts` (ABL-277).
 */
export type LoadForecastBasis = 'comparable' | 'divergent_basis';

export interface TSOForecastAccuracyMetrics {
  mae: number | null;
  mape: number | null;
  /**
   * Weighted Absolute Percentage Error: `100 * sum|actual - forecast| /
   * sum|actual|`, over every paired point — so its sample is `dataPoints`,
   * not `mapeSamples`, and there is deliberately no separate `wapeSamples`.
   *
   * Prefer this over `mape` wherever an actual can pass near zero. MAPE
   * divides each point by its own actual, so on a solar series that crosses
   * near-zero at dawn and dusk it is unbounded: measured on the replica
   * 2026-08-13 over full history, `/tso-forecast/accuracy/generation/HU`
   * `?type=solar` reported a MAPE of 7,421.87% where WAPE is 13.12%
   * (ABL-388).
   *
   * `null`, never `0`, when the window's actuals sum to zero.
   *
   * Absent on responses predating ABL-388.
   */
  wape?: number | null;
  rmse: number | null;
  dataPoints: number;
  /** Count of points with a positive actual — may be lower than dataPoints; mape covers only these. */
  mapeSamples: number;
  /** Absent on responses predating ABL-277; treat as 'comparable'. */
  basis?: LoadForecastBasis;
  /** Non-null exactly when `basis` is `divergent_basis`: why there are no numbers. */
  basisNote?: string | null;
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
  /**
   * ABL-632. How full the trailing window is, beside how new its newest row is.
   *
   * `status` alone rode on `MAX(timestamp_utc)`, so a stream that kept limping —
   * one surviving row per pass — stayed `live` while everything behind it
   * rotted. Prod shed most of its rows for four days in 2026-08-30..09-02 and
   * this endpoint said `live` throughout.
   *
   * **Optional and nullable, and both cases mean "no measurement", not zero.**
   * Absent: an older server that predates the field. `null`: the stored data
   * cannot support one (no rows, or no recognisable native resolution in the
   * baseline). A real `{ observed: 0 }` is a genuine measurement of an empty
   * window and is published as such.
   *
   * A `live` stream may carry a low ratio — the number is the evidence, the
   * status is the judgement. Server-side derivation and per-stream thresholds:
   * `server/src/services/freshnessCoverage.ts`.
   */
  coverage?: FreshnessCoverage | null;
}

export interface FreshnessCoverage {
  /** First UTC day counted, inclusive (`YYYY-MM-DD`). */
  windowStart: string;
  /** Last UTC day counted, inclusive (`YYYY-MM-DD`). */
  windowEnd: string;
  /** Rows a complete UTC day holds at this stream's native resolution. */
  expectedDailyRows: number;
  observed: number;
  /** Never zero — the field is `null` rather than carrying a zero denominator. */
  expected: number;
  /** `observed / expected` to 4dp. May exceed 1; is never `NaN` or `Infinity`. */
  ratio: number;
}

export interface DataFreshness {
  load: FreshnessStream;
  price: FreshnessStream;
  generation: FreshnessStream;
  tsoLoadForecast: FreshnessStream;
  tsoGenerationForecast: FreshnessStream;
}

// ============================================================================
// Ingest passes — "Last refreshed" (ABL-295)
// ============================================================================
// Mirrors server/src/services/ingestLog.ts. Sourced from `data_ingestion_log`,
// NOT from `publication_timestamp_utc`: that column is stamped with our own
// fetch time and drifts up to 39.1 days from the row carrying it, so no stream
// in this database can honestly show an upstream production time. That is why
// the copy is "Last refreshed" and never "Published" or "Generated".

/** The streams the dashboard draws, as the server's `INGEST_PIPELINES` maps them. */
export type IngestStreamKey =
  | 'load'
  | 'price'
  | 'generation'
  | 'tsoLoadForecast'
  | 'tsoGenerationForecast'
  | 'netPosition';

/**
 * How the last pass relates to the last pass that actually brought rows.
 *
 * Four separate claims. `checked_no_data` and `never_delivered` in particular
 * are not the same thing — measured 2026-08-12, GB load has never had a pass
 * return a row in 453 attempts, while AL generation last got one on 2026-06-30
 * and is still checked four times a day.
 */
export type IngestDelivery =
  | 'flowing'
  | 'checked_no_data'
  | 'never_delivered'
  | 'not_logged';

export interface StreamRefresh {
  /** Newest completed pass. When we last went and looked. */
  lastChecked: string | null;
  /**
   * Newest completed pass that wrote at least one row.
   *
   * Never fall back to `lastChecked` when this is null. And not a claim that
   * the data got newer — the ingest upserts a rolling 7-day window, so a
   * rewrite of a row we already held counts here. The freshness pill's
   * `MAX(timestamp_utc)` verdict is what answers data age.
   */
  lastStoredRows: string | null;
  delivery: IngestDelivery;
  /** Which `pipeline_type` rows the server folded in. */
  pipelines: string[];
}

export interface IngestFreshness {
  load: StreamRefresh;
  price: StreamRefresh;
  generation: StreamRefresh;
  tsoLoadForecast: StreamRefresh;
  tsoGenerationForecast: StreamRefresh;
  netPosition: StreamRefresh;
  /** Earliest pass anywhere in the log — what bounds a `not_logged` verdict. */
  logStartsAt: string | null;
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

/**
 * Per-lane request counts — see `server/src/lib/classifyRequest.ts` for what
 * separates them. `automated` is the health/ops polling, the ingest writes and
 * recognised bot/CLI user agents: the traffic that hits both environments
 * constantly whether or not a person ever visits.
 */
export interface RequestLaneCounts {
  page: number;
  api: number;
  asset: number;
  automated: number;
}

/** ABL-289. Mirrors `server/src/services/visitorCounters.ts`. */
export interface VisitorCounters {
  /** ISO instant this process started counting. Every figure below is "since" this. */
  countingSince: string;
  /** UTC day `today` belongs to, `YYYY-MM-DD`. */
  day: string;
  today: RequestLaneCounts;
  /** The seven UTC days ending on `day`, inclusive. */
  window: RequestLaneCounts;
  windowDaysCovered: number;
  /** False when the process is younger than the window — `window` is then a partial count. */
  windowComplete: boolean;
  /** Distinct hashed ip+ua keys seen today, or `null` once the server's per-day cap is hit. */
  distinctClientsToday: number | null;
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
  /**
   * Optional on purpose. The peer side of this payload is whatever build is
   * running over there (`peerOpsStatus.ts`), and every build from before
   * ABL-289 answers without this key — so the page has to be able to say "this
   * build does not report it" rather than render a missing object as zero.
   */
  visitors?: VisitorCounters;
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

// ----------------------------------------------------------------------------
// Ops status history (ABL-288)
// ----------------------------------------------------------------------------
// Mirrors server/src/services/opsSnapshot.ts, opsHistoryService.ts and
// lib/diskHeadroom.ts. Snapshots of the combined reading, stored on a timer,
// so the page can show a trend and a disk projection rather than only "now".

/**
 * One side of one stored reading. Every metric is `| null`, and `null` means
 * that reading did not contain it — the side was unreachable, or the host
 * could not measure it. It never means zero.
 */
export interface OpsSideSnapshot {
  reachable: boolean;
  latencyMs: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  rssBytes: number | null;
  uptimeSeconds: number | null;
  freshnessStatus: FreshnessStatus | null;
  staleCountryCount: number | null;
  commit: string | null;
}

export interface OpsSnapshot {
  /** ISO-8601 UTC instant the reading was taken. */
  t: string;
  local: OpsSideSnapshot;
  peer: OpsSideSnapshot;
}

/** Why a headroom projection is absent — the page states this rather than showing a number. */
export type DiskHeadroomReason =
  | 'ok'
  | 'no_readings'
  | 'insufficient_history'
  | 'insufficient_span'
  | 'not_rising'
  | 'noisy_fit'
  | 'already_breached'
  | 'beyond_horizon';

export interface DiskHeadroomBasis {
  points: number;
  spanHours: number;
  slopePercentPerDay: number;
  r2: number;
  currentPercent: number;
  /** Hours of history a projection needs — the server's bar, never restated here (ABL-459). */
  minSpanHours: number;
}

export interface DiskHeadroom {
  thresholdPercent: number;
  /** Days until the threshold is crossed, or `null` — see `reason`. */
  days: number | null;
  reason: DiskHeadroomReason;
  basis: DiskHeadroomBasis | null;
}

export interface OpsStatusHistory {
  timestamp: string;
  /** Hours actually served — the request's `hours` clamped to retention. */
  windowHours: number;
  snapshots: OpsSnapshot[];
  headroom: { local: DiskHeadroom; peer: DiskHeadroom };
  storage: {
    captureEnabled: boolean;
    intervalMinutes: number;
    retentionDays: number;
    storedSnapshots: number;
    skippedLines: number;
    error: string | null;
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
  /**
   * Mean Absolute Error (MW or EUR/MWh). Nullable since ABL-277 — a country
   * whose actuals and TSO forecast measure different quantities pairs points
   * but has no publishable error, so `dataPoints > 0` does not imply a number.
   */
  mae: number | null;
  mape: number | null; // Mean Absolute Percentage Error (%) — null when no point had a measurable (positive) actual
  /**
   * Weighted Absolute Percentage Error — `100 * sum|actual - forecast| / sum|actual|`.
   * The ranking measure (ABL-388). Null on a divergent basis and when the
   * window's actuals sum to zero.
   *
   * Optional, not just nullable: absent (not `null`) on responses from a
   * server built before this field existed. The client can deploy ahead of
   * the server in a staged rollout, so this must be treated as missing data,
   * not assumed present — see `accuracyBadgeState`, whose guard is `== null`
   * rather than `=== null` for exactly this field.
   */
  wape?: number | null;
  rmse: number | null;     // Root Mean Square Error
  /** Mean Error (positive = over-forecast); null on a divergent basis, where the mean difference is definitional, not bias. */
  bias: number | null;
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
  /**
   * `null` when the pair cannot support the measure. Two causes now, and they
   * are different claims: the window's actuals summed to zero, or the two
   * series measure different quantities and the difference is a definitional
   * gap rather than forecast error (ABL-493 — `basis` below says which).
   * Never 0, either way: a 0 here reads as a flawless forecast.
   */
  mae: number | null;
  wape: number | null;
  rmse: number | null;
  bias: number | null;
  /** How many rows paired. Truthful even when every measure above is null. */
  dataPoints: number;
  /**
   * Optional so the many hand-built `CrossCountryMetricsEntry` literals in
   * existing tests (leaderboardRows.test.ts, portfolioHome.test.ts,
   * portfolioSummary.test.ts) keep compiling without this field. Treat a
   * missing value the same as `{ n: 0, skillPct: null, baselineWape: null }`.
   *
   * On a `divergent_basis` entry, `skillPct` is `null` while `n` and
   * `baselineWape` survive: the D-7 baseline is the realized value from the
   * same hour last week, so `baselineWape` compares realized against realized
   * and is a true statement about the country. Only the ratio against the
   * contaminated model WAPE is withheld.
   */
  skillVsSeasonalNaive?: SkillVsSeasonalNaive;
  /**
   * Present **only** when the measures above were withheld because this
   * country's two series are not on the same basis. Absent means no finding,
   * never "verified fine", and a comparable entry is byte-identical to its
   * pre-ABL-493 shape — see `server/src/services/loadForecastBasis.ts`.
   */
  basis?: 'divergent_basis';
  /**
   * The sentence to render in place of the numbers. Present with `basis`,
   * never alone. It states what the gap *is*; a bare dash where a number used
   * to be would trade a wrong number for a silent one.
   */
  basisNote?: string;
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

/**
 * Why a registered model is not in the ranking (ABL-469). Mirrors the server's
 * `CandidateExclusion`. Deliberately five words rather than one "unavailable":
 * "we hold no forecast from it here" and "it forecast plenty and the pair is
 * not measurable" are different claims, and the picker says which.
 */
export type ModelExclusion =
  | 'not_measurable'
  | 'no_pairs'
  | 'too_few_points'
  | 'sparse_coverage'
  | 'unmeasurable_wape';

/** One registered model as measured over the recommendation window. */
export interface RankedModelCandidate {
  id: string;
  label: string;
  source: ForecastSource;
  /** `null` whenever not measurable — never coerced to 0. */
  wape: number | null;
  dataPoints: number;
  hoursCovered: number;
  /** `null` when the candidate is in the ranking. */
  excluded: ModelExclusion | null;
}

/**
 * The best available forecast for one (country, forecast type) pair, measured
 * over a rolling window across both our ML models and the ENTSO-E series
 * (ABL-469). Present only when `GET /forecasts/models` was asked with both
 * `type` and `country`.
 */
export interface RecommendedModel {
  modelId: string;
  label: string;
  source: ForecastSource;
  /** The winning WAPE, or `null` when this is the no-history fallback. */
  wape: number | null;
  dataPoints: number;
  /**
   * `true` when nothing had a measurable track record and this is the type's
   * hand-picked production model — i.e. the pair resolves exactly as it did
   * before auto-selection existed. An unmeasured default must never be
   * presented as a measured one, so nothing renders a WAPE beside it.
   */
  fallback: boolean;
  windowStart: string;
  windowEnd: string;
  windowDays: number;
  candidates: RankedModelCandidate[];
}

export interface ForecastTypeConfig {
  production: string;
  models: ForecastModel[];
  /**
   * Optional, and it is the absence that carries meaning: the registry request
   * the picker makes for the session does not ask for a recommendation, and a
   * server on code older than ABL-469 sends no such key at all.
   */
  recommended?: RecommendedModel;
}

export type ForecastModelRegistry = Record<string, ForecastTypeConfig>;
