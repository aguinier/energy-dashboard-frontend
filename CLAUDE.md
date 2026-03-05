# CLAUDE.md - Frontend Module

This file provides guidance to Claude Code (claude.ai/code) when working with the Energy Dashboard frontend.

## Project Overview

The frontend is a React + TypeScript web dashboard for visualizing European energy market data. It consists of:
- **client/** - React SPA (Vite, Tailwind CSS, Recharts)
- **server/** - Express.js API server (better-sqlite3)

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS
- **Charts**: Recharts
- **State Management**: Zustand (with localStorage persistence)
- **Data Fetching**: TanStack Query (React Query)
- **Backend**: Express.js, better-sqlite3
- **Database**: SQLite (shared with data_gathering module)

**Database Schema:** See [`../data_gathering/database_structure.md`](../data_gathering/database_structure.md) for complete database documentation.

## Quick Start

```bash
cd frontend
npm install
npm run dev
```

- Frontend: http://localhost:5173
- API Server: http://localhost:3001

## Project Structure

```
frontend/
├── client/
│   └── src/
│       ├── components/
│       │   ├── charts/           # Recharts visualizations
│       │   │   ├── LoadChart.tsx
│       │   │   ├── PriceChart.tsx
│       │   │   └── RenewableMixChart.tsx
│       │   ├── dashboard/        # Dashboard-specific components
│       │   │   ├── TimeNavigator.tsx    # Time preset buttons + nav
│       │   │   ├── MiniTimeline.tsx     # Visual timeline bar
│       │   │   └── TimeContextBar.tsx   # Date range + freshness
│       │   └── layout/           # Header, sidebar, etc.
│       ├── hooks/
│       │   └── useDashboardData.ts  # React Query hooks
│       ├── services/
│       │   └── api.ts            # Axios API functions
│       ├── store/
│       │   └── dashboardStore.ts # Zustand state
│       ├── types/
│       │   └── index.ts          # TypeScript interfaces
│       └── lib/
│           └── constants.ts      # App constants (TIME_PRESETS)
│
└── server/
    └── src/
        ├── routes/
        │   ├── index.ts          # Main router
        │   ├── tsoForecast.ts    # TSO forecast endpoints
        │   └── dataFreshness.ts  # Data freshness endpoint
        ├── services/
        │   └── tsoForecastService.ts  # Database queries
        ├── config/
        │   └── database.ts       # SQLite connection
        └── types/
            └── index.ts          # Server-side types
```

## Database Connection

The server connects to the shared SQLite database at `../data_gathering/energy_dashboard.db`.

```typescript
// server/src/config/database.ts
const dbPath = path.resolve(__dirname, '../../../../data_gathering/energy_dashboard.db');
```

## Key Features

### 1. TSO Forecast Overlay

ENTSO-E official forecasts (day-ahead and week-ahead) are displayed as dashed line overlays on charts.

**Data Sources (database tables):**
- `energy_load_forecast` - Load forecasts (1.9M records, 34 countries)
- `energy_generation_forecast` - Solar/wind forecasts (2.5M records, 35 countries)

**State Management (dashboardStore.ts):**
```typescript
showTSOForecast: boolean;           // Master toggle
tsoForecastType: 'day_ahead' | 'week_ahead';  // Controlled by D+1/D+7 toggle
showTSOComparisonMode: boolean;     // Historical accuracy view
```

**D+1/D+7 Toggle:**
- Only visible when `showTSOForecast=true` AND `showTSOComparisonMode=false`
- D+1 (day-ahead): Hourly forecasts as dashed line
- D+7 (week-ahead): Daily forecasts with shaded min/max band

**API Endpoints:**
- `GET /api/tso-forecast/load/:countryCode` - Load forecasts
- `GET /api/tso-forecast/generation/:countryCode` - Solar + wind forecasts
- `GET /api/tso-forecast/accuracy/load/:countryCode` - Forecast vs actual
- `GET /api/tso-forecast/accuracy/generation/:countryCode` - Generation accuracy
- `GET /api/tso-forecast/metrics/:countryCode` - MAE, MAPE, RMSE metrics

**React Query Hooks (useDashboardData.ts):**
- `useTSOLoadForecast(forecastType)`
- `useTSOGenerationForecast()`
- `useTSOLoadForecastAccuracy(forecastType)`
- `useTSOGenerationForecastAccuracy(type)`
- `useTSOForecastMetrics()`

### 2. Chart Components

**LoadChart.tsx:**
- Shows electricity demand (MW) over time
- TSO forecast overlay with D+1/D+7 toggle button
  - Day-ahead (D+1): Hourly dashed emerald line
  - Week-ahead (D+7): Shaded emerald band between min/max + dashed center line
- Comparison mode shows forecast vs actual with accuracy metrics

**RenewableMixChart.tsx:**
- Stacked area chart for renewable generation by type
- Per-type toggles (solar, wind_onshore, wind_offshore, hydro, biomass)
- TSO generation forecast overlay for solar and wind types
- Both ML forecasts (sky blue) and TSO forecasts (emerald) supported

**PriceChart.tsx:**
- Day-ahead market prices (EUR/MWh)

### 3. Time Navigation System

The dashboard features an advanced time navigation system with support for historical data, live view, and future forecasts.

**Components:**
- `TimeNavigator.tsx` - Main time controls (presets, navigation arrows, Live button)
- `MiniTimeline.tsx` - Visual timeline showing actual vs forecast data regions
- `TimeContextBar.tsx` - Date range display and data freshness indicator

**Time Presets:**
- **Historical**: `24h`, `7d`, `30d`, `90d`, `1y` (backward from now)
- **Around Now**: `today` (±12h), `thisWeek` (±3-4 days)
- **Forecast**: `next24h`, `next48h`, `next7d` (forward from now)

**State Management (dashboardStore.ts):**
```typescript
// Time navigation state
timePreset: TimePreset;             // Current time preset
timeAnchor: TimeAnchor;             // 'past' | 'now' | 'future'
timeOffset: number;                 // Hours offset for navigation
isLive: boolean;                    // Whether viewing current time

// Actions
setTimePreset: (preset) => void;    // Change time preset
shiftTimeWindow: (direction) => void; // Shift window back/forward
jumpToLive: () => void;             // Jump to current time
```

**API Endpoint for Data Freshness:**
- `GET /api/data-freshness/:countryCode` - Returns latest timestamps for each data type

**Hooks (useDashboardData.ts):**
- `useComputedDateRange()` - Returns calculated start/end dates and display string
- `useDataFreshness()` - Returns latest data timestamps for freshness indicator

### 4. State Management

Zustand store with localStorage persistence:

```typescript
// Key state properties
selectedCountry: string;            // Current country code
timePreset: TimePreset;             // '24h' | '7d' | 'today' | 'next7d' | etc.
timeAnchor: TimeAnchor;             // 'past' | 'now' | 'future'
showForecast: boolean;              // ML forecast toggle
showTSOForecast: boolean;           // TSO forecast toggle
showTSOComparisonMode: boolean;     // Accuracy comparison view
visibleRenewableTypes: string[];    // Which renewable types to show
```

## Common Development Tasks

### Adding a New API Endpoint

1. Add route in `server/src/routes/index.ts` or create new router file
2. Add service function in `server/src/services/`
3. Add types in both `server/src/types/index.ts` and `client/src/types/index.ts`
4. Add API function in `client/src/services/api.ts`
5. Create React Query hook in `client/src/hooks/useDashboardData.ts`

### Adding a New Chart Feature

1. Update store state in `client/src/store/dashboardStore.ts`
2. Add hook if fetching new data in `client/src/hooks/useDashboardData.ts`
3. Update chart component (add Recharts elements, update tooltip, legend)
4. Add UI toggle in chart wrapper or header

### Modifying TSO Forecast Display

Key files:
- `server/src/services/tsoForecastService.ts` - Database queries
- `client/src/components/charts/LoadChart.tsx` - Load forecast overlay
- `client/src/components/charts/RenewableMixChart.tsx` - Generation forecast overlay

## TypeScript Types

### Time Navigation Types

```typescript
// Time anchor - determines direction of time range
type TimeAnchor = 'past' | 'now' | 'future';

// Time presets - predefined time ranges
type TimePreset =
  | '24h' | '7d' | '30d' | '90d' | '1y'    // Historical
  | 'today' | 'thisWeek'                    // Around now
  | 'next24h' | 'next48h' | 'next7d';       // Forecast

// Data freshness response
interface DataFreshness {
  load: string | null;
  price: string | null;
  generation: string | null;
  tsoLoadForecast: string | null;
  tsoGenerationForecast: string | null;
}
```

### TSO Forecast Types

```typescript
// Forecast type selection
type TSOForecastType = 'day_ahead' | 'week_ahead';

// Load forecast data point
interface TSOLoadForecastDataPoint {
  timestamp: string;
  forecast_value_mw: number;
  forecast_min_mw: number | null;    // Week-ahead only: daily min
  forecast_max_mw: number | null;    // Week-ahead only: daily max
  forecast_type: 'day_ahead' | 'week_ahead';
  publication_timestamp_utc?: string;
}

// Generation forecast data point
interface TSOGenerationForecastDataPoint {
  timestamp: string;
  solar_mw: number | null;
  wind_onshore_mw: number | null;
  wind_offshore_mw: number | null;
  total_forecast_mw: number | null;
}

// Accuracy comparison data
interface TSOForecastAccuracyDataPoint {
  timestamp: string;
  forecast_value: number;
  actual_value: number;
  error: number;
  error_pct: number;
}

// Accuracy metrics
interface TSOForecastAccuracyMetrics {
  mae: number;      // Mean Absolute Error
  mape: number;     // Mean Absolute Percentage Error
  rmse: number;     // Root Mean Square Error
  count: number;    // Number of data points
}
```

## Debugging Tips

- Check browser DevTools Network tab for API responses
- Use React Query DevTools (enabled in dev mode)
- Check server console for database query logs
- Verify database path in `server/src/config/database.ts`

## Common Issues

**"Cannot connect to database":**
- Verify `data_gathering/energy_dashboard.db` exists
- Check relative path in database config

**TSO forecasts not showing:**
- Ensure `showTSOForecast` is toggled on in store
- Check API response has data for selected country
- Verify database tables have data: `energy_load_forecast`, `energy_generation_forecast`

**Week-ahead band not showing:**
- Ensure `showTSOComparisonMode` is false (band only shows in normal view, not comparison mode)
- Click D+1/D+7 toggle to switch to week-ahead (D+7) view
- Verify min/max data exists: run `python scripts/backfill_week_ahead_minmax.py --countries XX`
- Week-ahead data is daily granularity at T12:00:00Z timestamps

**Chart not updating:**
- React Query caches data - check `staleTime` settings
- Force refetch with `refetch()` from hook
- Clear localStorage to reset Zustand state

**Time navigation not working:**
- Check `timePreset` and `timeAnchor` in store
- Verify date range calculation in `useComputedDateRange()`
- Clear localStorage if migrating from old `timeRange` state

**Data freshness not showing:**
- Verify `/api/data-freshness/:countryCode` endpoint is responding
- Check that database has data for selected country
- Ensure `useDataFreshness()` hook is being called
