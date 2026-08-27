> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# TypeScript Types

## TypeScript Types

### Time Navigation Types

```typescript
type TimeAnchor = 'past' | 'now' | 'future';

type TimePreset =
  | '24h' | '7d' | '30d'
  | 'today' | 'thisWeek'
  | 'next1d' | 'next24h' | 'next48h' | 'next7d';

// Per stream, since ABL-60 — not five bare timestamps. `ageHours` is signed and
// server-computed; negative is normal for a day-ahead stream. See "Data
// freshness" above for the rules behind `status`.
type FreshnessStatus = 'live' | 'stale' | 'ended' | 'none';

interface FreshnessStream {
  latest: string | null;
  ageHours: number | null;
  status: FreshnessStatus;
}

interface DataFreshness {
  load: FreshnessStream;
  price: FreshnessStream;
  generation: FreshnessStream;
  tsoLoadForecast: FreshnessStream;
  tsoGenerationForecast: FreshnessStream;
}
```

### Forecast Model Registry Types

```typescript
type ForecastSource = 'ml' | 'tso';

interface ForecastModel {
  id: string;                 // wire id, e.g. 'catboost', 'tso-d7'
  label: string;               // 'able-ml · catboost'
  source: ForecastSource;
  modelName?: string;          // forecasts.model_name, for ml models
  tsoHorizon?: 'day_ahead' | 'week_ahead';  // for tso models
}

interface ForecastTypeConfig {
  production: string;          // default model id for this forecast type
  models: ForecastModel[];
}

type ForecastModelRegistry = Record<string, ForecastTypeConfig>;
```

### TSO Forecast Types

The client and server declarations are **not** mirror images here — check which
side you are on.

```typescript
// client/src/types/index.ts:279 — note the third member; the server's
// TSOForecastType (server/src/types/index.ts:168) is identical.
type TSOForecastType = 'day_ahead' | 'week_ahead' | 'all';

// client/src/types/index.ts:281. The server's TSOLoadForecastDataPoint
// (server/src/types/index.ts:170) has NO min/max fields; the two the client
// adds are populated by the week-ahead branch of the query
// (tsoForecastService.ts:71-72, NULL on the day-ahead branches).
interface TSOLoadForecastDataPoint {
  timestamp: string;
  forecast_value_mw: number;
  forecast_min_mw: number | null;    // Week-ahead only: daily min
  forecast_max_mw: number | null;    // Week-ahead only: daily max
  forecast_type: string;             // not narrowed to the union
  publication_timestamp_utc: string | null;   // required, nullable — not optional
}

// server-only: server/src/types/index.ts:177 (and a duplicate at
// tsoForecastService.ts:27). There is no client counterpart.
interface TSOGenerationForecastDataPoint {
  timestamp: string;
  solar_mw: number | null;
  wind_onshore_mw: number | null;
  wind_offshore_mw: number | null;
  total_forecast_mw: number | null;
}

interface TSOForecastAccuracyDataPoint {
  timestamp: string;
  forecast_value: number;
  actual_value: number;
  error: number;
  error_pct: number;
}

// Accuracy metrics — null fields mean "not measurable in this window", not zero
interface TSOForecastAccuracyMetrics {
  mae: number | null;
  mape: number | null;      // covers only points with a positive actual
  rmse: number | null;
  dataPoints: number;
  mapeSamples: number;      // count of points MAPE was computed over; <= dataPoints
}
```
