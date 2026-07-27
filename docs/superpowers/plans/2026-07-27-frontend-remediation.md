# Energy Dashboard Frontend Remediation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every number the dashboard displays either measured or explicitly absent — fixing the forecast model-pin regression that blanks charts for AT/BE/FR/DE/ES/PT, removing fabricated generation and accuracy figures, correcting misleading labels, and reviving the unreachable comparison view on a metric that survives zero-crossing actuals.

**Architecture:** Three layers change. (1) The **client** stops forcing an explicit `model=` on every forecast request, so the server's existing candidate-fallback ladder becomes reachable, and it reports which model actually served. (2) **Presentation components** stop deriving numbers the database does not contain — invented nuclear/gas and extrapolated D+3..D+7 error are replaced by measured values or honest gaps. (3) The **server** gains a cache key that can actually hit, and a comparison metric (WAPE) that is well-defined when actuals cross zero.

**Tech Stack:** React 18 + TypeScript, Vite, Zustand (persist), TanStack Query v5, Recharts + hand-rolled SVG charts, Tailwind; Express 4 + better-sqlite3 (synchronous, readonly); Vitest both sides.

## Global Constraints

- **Never display a number the database does not contain.** If a value cannot be measured, render an explicit gap or omit the element. This supersedes any visual-completeness preference.
- **Never silently substitute one model for another.** When a fallback serves, the UI must name the model that actually served.
- Existing behaviour documented as deliberate stays: light theme is the only exposed theme (`themeStore.ts:28` — "dark is a coarse retune"); `useNetPositionData` extending `end` to now+3d is intentional (`useNetPositionData.ts:10-14`).
- All new/changed server SQL must be verified against the local replica at `C:/Code/able/data/energy_dashboard.db` (readonly) before being called against `192.168.86.36:3001`.
- Do not load-test the prod box. It is single-threaded and synchronous; a slow query blocks every other request.
- Run `npx tsc -b client` and `npm test -w client` / `npm test -w server` before each commit.
- Commit after every task. Conventional Commits (`fix:`, `feat:`, `refactor:`, `docs:`, `test:`).

## Data facts established by audit (do not re-derive)

| Fact | Evidence |
|---|---|
| `catboost` and `xgboost` cover **disjoint** country sets | load missing catboost: AT, BE, FR. price missing catboost: BE, DE, ES, FR, PT |
| Nuclear/fossil generation is **not in the DB** | no column matching `nuclear\|fossil\|coal\|lignite\|gas\|oil` in any table; `gas_prices` is a commodity price series |
| Forecast horizons stop at **63h** | `forecasts.horizon_hours` ranges 4..63 — D+3/D+5/D+7 are unmeasurable |
| Measured D+1/D+2 ML metrics already exposed | `GET /api/forecast-comparison/:cc/summary` returns `load.ml.d1/.d2` + `load.tso.dayAhead/.weekAhead` with `dataPoints` |
| Server cache never hits on ranged endpoints | key is `req.originalUrl`; client sends `new Date().toISOString()` at ms precision |
| MAPE SQL divides by **signed** actual | `crossCountryMetricsService.ts:96` — negative prices cancel error |

---

# Phase 1 — P0: stop showing wrong data

### Task 1: Let the server's model fallback actually run

The client resolves `selected` to the type's production model even when the user never chose one, then sends it as an explicit `model=`. The server honours explicit requests strictly (by design), so AT/BE/FR get an empty load chart and BE/DE/ES/FR/PT an empty price chart.

**Files:**
- Modify: `client/src/hooks/useForecastModels.ts:40-58`
- Modify: `client/src/hooks/useLoadChartData.ts:82-87`
- Test: `client/src/hooks/useForecastModels.test.ts` (create)

**Interfaces:**
- Consumes: `ForecastModelRegistry`, `ForecastModel` from `@/types`
- Produces: `ActiveModelSelection` gains `requestModelId: string | undefined` — the value callers pass as `model`. `undefined` means "let the server choose". `selected` keeps its current meaning (what to *label* before the response arrives).

- [ ] **Step 1: Write the failing test**

Create `client/src/hooks/useForecastModels.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveSelection } from './useForecastModels';
import type { ForecastModelRegistry } from '@/types';

const REGISTRY: ForecastModelRegistry = {
  load: {
    production: 'catboost',
    models: [
      { id: 'catboost', label: 'able-ml · catboost', source: 'ml', modelName: 'catboost' },
      { id: 'xgboost', label: 'able-ml · xgboost', source: 'ml', modelName: 'xgboost' },
    ],
  },
};

describe('resolveSelection', () => {
  it('does not pin a model when the user has not chosen one', () => {
    const r = resolveSelection(REGISTRY, 'load', undefined);
    expect(r.requestModelId).toBeUndefined();
    expect(r.selected?.id).toBe('catboost');
    expect(r.hidden).toBe(false);
  });

  it('pins the model when the user chose one explicitly', () => {
    const r = resolveSelection(REGISTRY, 'load', 'xgboost');
    expect(r.requestModelId).toBe('xgboost');
    expect(r.selected?.id).toBe('xgboost');
  });

  it('treats null as forecast hidden', () => {
    const r = resolveSelection(REGISTRY, 'load', null);
    expect(r.hidden).toBe(true);
    expect(r.selected).toBeNull();
    expect(r.requestModelId).toBeUndefined();
  });

  it('falls back to production when the stored id is no longer registered', () => {
    const r = resolveSelection(REGISTRY, 'load', 'removed-model');
    expect(r.selected?.id).toBe('catboost');
    expect(r.requestModelId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w client -- useForecastModels`
Expected: FAIL — `resolveSelection` is not exported from `./useForecastModels`

- [ ] **Step 3: Extract and fix the resolution logic**

In `client/src/hooks/useForecastModels.ts`, add `requestModelId` to the interface and replace the body of `useModelSelection` with a call to a new pure function:

```ts
export interface ActiveModelSelection {
  forecastType: string;
  models: ForecastModel[];
  /** Model to label the picker with. Provisional until the response names one. */
  selected: ForecastModel | null;
  /**
   * Model id to send as `model=`. `undefined` means the user expressed no
   * preference — the server then walks its candidate ladder, which is the only
   * way countries without the production model get a forecast at all.
   */
  requestModelId: string | undefined;
  hidden: boolean;
  isLoading: boolean;
}

export function resolveSelection(
  registry: ForecastModelRegistry | undefined,
  forecastType: string,
  selectedId: string | null | undefined,
): Omit<ActiveModelSelection, 'isLoading'> {
  const cfg = registry?.[forecastType];
  const models = cfg?.models ?? [];
  const hidden = selectedId === null;

  if (hidden || !cfg) {
    return { forecastType, models, selected: null, requestModelId: undefined, hidden };
  }

  const explicit = selectedId ? models.find((m) => m.id === selectedId) : undefined;
  const selected =
    explicit ?? models.find((m) => m.id === cfg.production) ?? models[0] ?? null;

  // Only an id the user actually picked is pinned. A production default is a
  // preference, not an instruction, and pinning it blanks every country that
  // has no data for that model.
  return { forecastType, models, selected, requestModelId: explicit?.id, hidden };
}

export function useModelSelection(forecastType: string): ActiveModelSelection {
  const { data: registry, isLoading } = useForecastModels();
  const selectedId = useDashboardStore((s) => s.selectedModelByType[forecastType]);
  return { ...resolveSelection(registry, forecastType, selectedId), isLoading };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w client -- useForecastModels`
Expected: PASS — 4 tests

- [ ] **Step 5: Use `requestModelId` at the call site**

In `client/src/hooks/useLoadChartData.ts`, replace lines 82-87:

```ts
  // The picker is the single source of truth for which model this chart shows.
  const { selected, requestModelId } = useModelSelection('load');

  // Pin only what the user pinned; otherwise let the server pick a model that
  // has data for this country.
  const modelId = selected?.source === 'ml' ? requestModelId : undefined;
```

Leave the `queryKey` and `model: modelId` lines as they are — `modelId` now carries the corrected value.

- [ ] **Step 6: Verify against the two broken countries**

Run:
```bash
curl -s "http://192.168.86.36:3001/api/forecasts?country=FR&type=load&start=2026-07-20T00:00:00Z&end=2026-07-29T00:00:00Z&granularity=hourly" | head -c 160
```
Expected: `"success":true` with a non-empty `data` array (served by xgboost).

Then in the browser at `http://localhost:5173`, open France → Load, confirm a forecast line now renders past `now`. Repeat for Belgium.

- [ ] **Step 7: Commit**

```bash
git add client/src/hooks/useForecastModels.ts client/src/hooks/useForecastModels.test.ts client/src/hooks/useLoadChartData.ts
git commit -m "fix(forecast): pin a model only when the user picked one

The client sent model=<production> on every request, and the server honours
explicit requests strictly, so its candidate-fallback ladder never ran.
catboost and xgboost cover disjoint country sets, which blanked load for
AT/BE/FR and price for BE/DE/ES/FR/PT."
```

---

### Task 2: Name the model that actually served

With Task 1 the server may serve a non-production model. The picker must say so rather than displaying the production label over someone else's data.

**Files:**
- Modify: `client/src/services/api.ts:169-181`
- Modify: `client/src/hooks/useLoadChartData.ts`
- Modify: `client/src/components/dashboard/ModelPicker.tsx`
- Test: `client/src/lib/servedModel.test.ts` (create)
- Create: `client/src/lib/servedModel.ts`

**Interfaces:**
- Consumes: `ActiveModelSelection` from Task 1
- Produces: `fetchForecastData` returns `{ points: ForecastDataPoint[]; servedModelId: string | null }`; `servedLabel(models, servedModelId, selected)` returns the string the picker shows.

- [ ] **Step 1: Write the failing test**

Create `client/src/lib/servedModel.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { servedLabel } from './servedModel';
import type { ForecastModel } from '@/types';

const MODELS: ForecastModel[] = [
  { id: 'catboost', label: 'able-ml · catboost', source: 'ml', modelName: 'catboost' },
  { id: 'xgboost', label: 'able-ml · xgboost', source: 'ml', modelName: 'xgboost' },
];

describe('servedLabel', () => {
  it('shows the served model when it differs from the provisional one', () => {
    expect(servedLabel(MODELS, 'xgboost', MODELS[0])).toBe('able-ml · xgboost');
  });

  it('shows the provisional label before a response arrives', () => {
    expect(servedLabel(MODELS, null, MODELS[0])).toBe('able-ml · catboost');
  });

  it('falls back to the raw id when the served model is unregistered', () => {
    expect(servedLabel(MODELS, 'mystery', MODELS[0])).toBe('mystery');
  });

  it('returns empty string when nothing is selected', () => {
    expect(servedLabel(MODELS, null, null)).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w client -- servedModel`
Expected: FAIL — cannot find module `./servedModel`

- [ ] **Step 3: Implement**

Create `client/src/lib/servedModel.ts`:

```ts
import type { ForecastModel } from '@/types';

/**
 * The label the picker shows. Prefers the model the server actually served over
 * the provisional selection, so a fallback is visible rather than passed off as
 * the production model.
 */
export function servedLabel(
  models: ForecastModel[],
  servedModelId: string | null,
  selected: ForecastModel | null,
): string {
  if (servedModelId) {
    return models.find((m) => m.modelName === servedModelId || m.id === servedModelId)?.label
      ?? servedModelId;
  }
  return selected?.label ?? '';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w client -- servedModel`
Expected: PASS — 4 tests

- [ ] **Step 5: Return the served model from the API layer**

In `client/src/services/api.ts`, replace `fetchForecastData` (lines 169-181):

```ts
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
  return { points: data.data, servedModelId: data.meta?.model ?? null };
}
```

- [ ] **Step 6: Thread it through the hook**

In `client/src/hooks/useLoadChartData.ts`, the forecast query's `queryFn` now resolves to `ForecastFetchResult`. Update the consumer so `forecastData` stays a point array and the served id is exposed:

```ts
  const forecastQuery = /* existing useQuery, unchanged options */;
  const forecastData = forecastQuery.data?.points ?? [];
  const servedModelId = forecastQuery.data?.servedModelId ?? null;
```

Add `servedModelId` to the hook's return object.

- [ ] **Step 7: Show it in the picker**

In `client/src/components/dashboard/ModelPicker.tsx`, accept an optional `servedModelId` prop and render `servedLabel(models, servedModelId, selected)` as the button text instead of `selected.label`. Where the button is rendered in `CountryDashboardView.tsx`, pass `servedModelId` through from `useLoadChartData()`.

- [ ] **Step 8: Verify**

Run: `npx tsc -b client` → exit 0.
In the browser, open France → Load. The picker must read **able-ml · xgboost**, not catboost.

- [ ] **Step 9: Commit**

```bash
git add client/src/lib/servedModel.ts client/src/lib/servedModel.test.ts client/src/services/api.ts client/src/hooks/useLoadChartData.ts client/src/components/dashboard/ModelPicker.tsx client/src/views/CountryDashboardView.tsx
git commit -m "feat(picker): label the model that actually served, not the one requested"
```

---

### Task 3: Stop rendering false zeros on the Generation tab

`GenerationTab` gates only on `useRenewableChartData().isLoading`. While `useRenewableMix()` is in flight — which happens on **every** range change — it renders Solar/Wind/Hydro/Biomass as `0.00` and a donut reading "0% RENEWABLE", contradicting the header stat on the same screen.

**Files:**
- Modify: `client/src/components/dashboard/GenerationTab.tsx:30-58, 94-104`

**Interfaces:**
- Consumes: `useRenewableMix()` returns a TanStack `UseQueryResult`, so `isLoading` and `isError` are already available — no hook change is needed, only destructuring them at the call site
- Produces: `GenerationTab` renders the "Right now"/"By source" pair only when `mix` is defined

- [ ] **Step 1: Confirm the bug reproduces**

Open `http://localhost:5173` → any country → Generation. Click `7d`, then `30d`. Observe the donut flip to "0% RENEWABLE" and all four renewable rows to `0.00` while nuclear/gas keep non-zero values.

- [ ] **Step 2: Gate the cards on the mix query**

In `client/src/components/dashboard/GenerationTab.tsx`, change the destructure and wrap the bottom grid:

```tsx
  const { renewableData, isLoading } = useRenewableChartData();
  const { data: mix, isLoading: mixLoading, isError: mixError } = useRenewableMix();
  const { data: overview } = useDashboardOverview();
```

Replace the `<div className="grid gap-3.5 md:grid-cols-[280px_1fr]">` block's contents with:

```tsx
      <div className="grid gap-3.5 md:grid-cols-[280px_1fr]">
        <AbleCard title="Right now" subtitle="share of load · measured sources only">
          {mixLoading ? (
            <div className="flex h-[180px] items-center justify-center text-[12px] text-ink-muted">
              Loading…
            </div>
          ) : mixError || !mix ? (
            <div className="flex h-[180px] items-center justify-center text-center text-[12px] text-ink-muted">
              Generation mix unavailable.
            </div>
          ) : (
            <div className="flex justify-center py-2">
              <AbleDonut values={donutValues} colors={SOURCE_COLORS} />
            </div>
          )}
        </AbleCard>

        <AbleCard title="By source" subtitle="GW · window average">
          {mixLoading ? (
            <div className="flex h-[180px] items-center justify-center text-[12px] text-ink-muted">
              Loading…
            </div>
          ) : mixError || !mix ? (
            <div className="flex h-[180px] items-center justify-center text-center text-[12px] text-ink-muted">
              Generation mix unavailable.
            </div>
          ) : (
            <SourceTable mix={mix} overview={overview} />
          )}
        </AbleCard>
      </div>
```

Note the subtitle changes: `"share of load · nuclear & gas estimated"` → `"share of load · measured sources only"` and `"GW · current"` → `"GW · window average"`. Both are corrected by Task 4 and Task 8; setting them here keeps every intermediate commit honest.

- [ ] **Step 3: Verify**

Run: `npx tsc -b client` → exit 0.
Repeat Step 1. Expect "Loading…" during the fetch and never a zeroed breakdown.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/dashboard/GenerationTab.tsx
git commit -m "fix(generation): show a loading state instead of zeroed sources

The mix query was ungated, so every range change rendered 0% renewable and
0.00 for each source next to a header stat reading 36%."
```

---

### Task 4: Remove invented nuclear and gas

`nuclear = load * 0.2` for every country and `gas = load * (1 - renPct/100 - 0.2)` are prototype assumptions. France rendered "Nuclear 8.29 GW / 19.7%" against a real share several times that; a zero-nuclear country gets invented nuclear too. The DB has no nuclear or fossil data (see data facts), so these cannot be corrected — only removed.

**Files:**
- Modify: `client/src/components/dashboard/SourceTable.tsx`
- Modify: `client/src/components/dashboard/GenerationTab.tsx:40-58`
- Test: `client/src/components/dashboard/sourceRows.test.ts` (create)
- Create: `client/src/components/dashboard/sourceRows.ts`

**Interfaces:**
- Produces: `buildSourceRows(mix, loadMw)` → `{ rows: SourceRow[]; unattributedMw: number | null }` where `SourceRow = { key, label, mw, pctOfLoad, color }`. Percentages are **share of load**, not share of a synthetic total.

- [ ] **Step 1: Write the failing test**

Create `client/src/components/dashboard/sourceRows.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSourceRows } from './sourceRows';
import type { RenewableMix } from '@/types';

const MIX: RenewableMix = {
  solar: 6000, wind_onshore: 4000, wind_offshore: 800,
  hydro: 4000, biomass: 200, geothermal: 0, other: 0, total: 15000,
};

describe('buildSourceRows', () => {
  it('emits only measured sources', () => {
    const { rows } = buildSourceRows(MIX, 40000);
    expect(rows.map((r) => r.key)).toEqual(['solar', 'wind', 'hydro', 'biomass']);
  });

  it('sums onshore and offshore wind', () => {
    const { rows } = buildSourceRows(MIX, 40000);
    expect(rows.find((r) => r.key === 'wind')!.mw).toBe(4800);
  });

  it('expresses percentages as share of load', () => {
    const { rows } = buildSourceRows(MIX, 40000);
    expect(rows.find((r) => r.key === 'solar')!.pctOfLoad).toBeCloseTo(15, 5);
  });

  it('reports the unattributed remainder rather than naming it', () => {
    const { unattributedMw } = buildSourceRows(MIX, 40000);
    expect(unattributedMw).toBe(25000);
  });

  it('clamps a negative remainder to zero', () => {
    const { unattributedMw } = buildSourceRows(MIX, 10000);
    expect(unattributedMw).toBe(0);
  });

  it('returns a null remainder when load is unknown', () => {
    const { unattributedMw } = buildSourceRows(MIX, null);
    expect(unattributedMw).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w client -- sourceRows`
Expected: FAIL — cannot find module `./sourceRows`

- [ ] **Step 3: Implement**

Create `client/src/components/dashboard/sourceRows.ts`:

```ts
import type { RenewableMix } from '@/types';

export interface SourceRow {
  key: 'solar' | 'wind' | 'hydro' | 'biomass';
  label: string;
  mw: number;
  /** Share of load. Null load yields 0 so the bar simply does not draw. */
  pctOfLoad: number;
  color: string;
}

const COLORS = {
  solar: '#F0B92B',
  wind: '#4D89C9',
  hydro: '#2FA39C',
  biomass: '#73A35F',
} as const;

/**
 * Measured renewable sources plus the part of load they do not account for.
 *
 * Nuclear and fossil generation are NOT ingested — no table in
 * energy_dashboard.db carries them. The previous version derived nuclear as a
 * flat 20% of load for every country and gas as the remainder, which produced
 * numbers off by several multiples (France) and invented nuclear for countries
 * that have none. The remainder is now reported unnamed.
 */
export function buildSourceRows(
  mix: RenewableMix | undefined,
  loadMw: number | null,
): { rows: SourceRow[]; unattributedMw: number | null } {
  const wind = (mix?.wind_onshore ?? 0) + (mix?.wind_offshore ?? 0);
  const raw: Array<[SourceRow['key'], string, number]> = [
    ['solar', 'Solar', mix?.solar ?? 0],
    ['wind', 'Wind', wind],
    ['hydro', 'Hydro', mix?.hydro ?? 0],
    ['biomass', 'Biomass', mix?.biomass ?? 0],
  ];

  const rows: SourceRow[] = raw.map(([key, label, mw]) => ({
    key,
    label,
    mw,
    pctOfLoad: loadMw && loadMw > 0 ? (mw / loadMw) * 100 : 0,
    color: COLORS[key],
  }));

  const measured = rows.reduce((a, r) => a + r.mw, 0);
  const unattributedMw = loadMw == null ? null : Math.max(0, loadMw - measured);

  return { rows, unattributedMw };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w client -- sourceRows`
Expected: PASS — 6 tests

- [ ] **Step 5: Rewrite SourceTable against it**

Replace the whole body of `client/src/components/dashboard/SourceTable.tsx`:

```tsx
// Measured renewable sources, as a share of load. Nuclear and fossil are not
// ingested (no table carries them), so the balance of load is reported as an
// unattributed remainder rather than split into invented categories.

import { buildSourceRows } from './sourceRows';
import type { RenewableMix, DashboardOverview } from '@/types';

interface Props {
  mix?: RenewableMix;
  overview?: DashboardOverview;
}

export function SourceTable({ mix, overview }: Props) {
  const load = overview?.currentLoad ?? null;
  const { rows, unattributedMw } = buildSourceRows(mix, load);

  return (
    <div className="flex flex-col">
      {rows.map((s) => (
        <div
          key={s.key}
          className="grid items-center gap-2.5 border-t border-input py-2.5 first:border-t-0"
          style={{ gridTemplateColumns: '10px 1fr 60px 60px 140px' }}
        >
          <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
          <span className="text-[12.5px]">{s.label}</span>
          <span className="font-mono-num text-right text-[12px]">{(s.mw / 1000).toFixed(2)}</span>
          <span className="font-mono-num text-right text-[11px] text-ink-dim">
            {s.pctOfLoad.toFixed(1)}%
          </span>
          <span className="relative block h-1 rounded-sm bg-secondary">
            <span
              className="absolute inset-y-0 left-0 rounded-sm"
              style={{ width: `${Math.min(100, s.pctOfLoad)}%`, background: s.color }}
            />
          </span>
        </div>
      ))}

      {unattributedMw != null && (
        <div
          className="grid items-center gap-2.5 border-t border-input py-2.5"
          style={{ gridTemplateColumns: '10px 1fr 60px 60px 140px' }}
        >
          <span className="h-2 w-2 rounded-sm border border-border" />
          <span className="text-[12.5px] text-ink-dim">Not attributed</span>
          <span className="font-mono-num text-right text-[12px] text-ink-dim">
            {(unattributedMw / 1000).toFixed(2)}
          </span>
          <span className="font-mono-num text-right text-[11px] text-ink-dim">
            {load && load > 0 ? ((unattributedMw / load) * 100).toFixed(1) : '0.0'}%
          </span>
          <span />
        </div>
      )}

      <p className="mt-2 border-t border-input pt-2 text-[10.5px] text-ink-muted">
        Nuclear and fossil generation are not ingested — the remainder is left unnamed.
      </p>
    </div>
  );
}
```

- [ ] **Step 6: Drop the invented slices from the donut**

In `client/src/components/dashboard/GenerationTab.tsx`, delete the `nuclear` and `gas` entries from `donutValues` and remove them from `SOURCE_COLORS`. Derive the donut from `buildSourceRows` rather than re-summing the sources inline — the remainder must be computed in exactly one place or the donut and the table can disagree:

```tsx
import { buildSourceRows } from './sourceRows';

  const { rows, unattributedMw } = useMemo(
    () => buildSourceRows(mix, overview?.currentLoad ?? null),
    [mix, overview?.currentLoad],
  );

  const donutValues = [
    ...rows.map((r) => ({ key: r.key, value: r.mw, isGreen: true })),
    // The rest of load. Not "gas" — nothing in the DB says what it is.
    { key: 'unattributed', value: unattributedMw ?? 0, isGreen: false },
  ];
```

Set `SOURCE_COLORS` to:

```tsx
const SOURCE_COLORS = {
  solar: '#D9A114',
  wind: '#4D89C9',
  hydro: '#2FA39C',
  biomass: '#73A35F',
  unattributed: '#D8D4CC',
};
```

- [ ] **Step 7: Verify**

Run: `npx tsc -b client && npm test -w client`
In the browser, France → Generation: no "Nuclear" or "Gas + other" row; a "Not attributed" row with the footnote.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/dashboard/sourceRows.ts client/src/components/dashboard/sourceRows.test.ts client/src/components/dashboard/SourceTable.tsx client/src/components/dashboard/GenerationTab.tsx
git commit -m "fix(generation): drop invented nuclear and gas figures

nuclear was a flat 20% of load for every country and gas the remainder.
No table in energy_dashboard.db carries nuclear or fossil generation, so the
balance of load is now reported as an unattributed remainder."
```

---

### Task 5: Replace extrapolated horizon bars with measured ones

`HORIZON_FACTORS = [1, 1.15, 1.3, 1.55, 1.9]` multiplies a measured D+1 MAPE to invent D+2/D+3/D+5/D+7. `forecasts.horizon_hours` stops at 63h, so D+3/D+5/D+7 can never be measured. `GET /api/forecast-comparison/:cc/summary` already returns measured `ml.d1`, `ml.d2`, `tso.dayAhead`, `tso.weekAhead` with `dataPoints`.

**Files:**
- Modify: `client/src/components/dashboard/ForecastTab.tsx:19-25, 109-115, 172-186`
- Test: `client/src/components/dashboard/horizonBars.test.ts` (create)
- Create: `client/src/components/dashboard/horizonBars.ts`

**Interfaces:**
- Consumes: `ForecastComparisonSummary` from `@/types` (shape confirmed live: `{ load: { tso: { dayAhead, weekAhead }, ml: { d1, d2 } } }`, each `{ mae, mape, rmse, bias, dataPoints }`)
- Produces: `buildHorizonBars(summary, forecastType)` → `Datum[]` matching `AbleAccuracyBars`' existing `{ label, v, extrapolated? }`

- [ ] **Step 1: Write the failing test**

Create `client/src/components/dashboard/horizonBars.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildHorizonBars } from './horizonBars';

const SUMMARY = {
  load: {
    tso: {
      dayAhead: { mae: 433.91, mape: 5.41, rmse: 522.92, bias: 364.93, dataPoints: 169 },
      weekAhead: { mae: 858.15, mape: 11.67, rmse: 921.09, bias: 858.15, dataPoints: 7 },
    },
    ml: {
      d1: { mae: 463.07, mape: 5.92, rmse: 606.45, bias: -306.25, dataPoints: 169 },
      d2: { mae: 529.89, mape: 6.8, rmse: 701.32, bias: -373.93, dataPoints: 169 },
    },
  },
} as never;

describe('buildHorizonBars', () => {
  it('emits only measured horizons', () => {
    const bars = buildHorizonBars(SUMMARY, 'load');
    expect(bars.map((b) => b.label)).toEqual(['ML D+1', 'ML D+2', 'TSO D+1', 'TSO D+7']);
  });

  it('uses measured mape values verbatim', () => {
    const bars = buildHorizonBars(SUMMARY, 'load');
    expect(bars.find((b) => b.label === 'ML D+2')!.v).toBe(6.8);
  });

  it('never marks a bar extrapolated', () => {
    expect(buildHorizonBars(SUMMARY, 'load').every((b) => !b.extrapolated)).toBe(true);
  });

  it('omits horizons with no samples', () => {
    const sparse = { load: { tso: {}, ml: { d1: { mape: 4.2, dataPoints: 50 } } } } as never;
    expect(buildHorizonBars(sparse, 'load').map((b) => b.label)).toEqual(['ML D+1']);
  });

  it('returns nothing when the summary is absent', () => {
    expect(buildHorizonBars(undefined, 'load')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w client -- horizonBars`
Expected: FAIL — cannot find module `./horizonBars`

- [ ] **Step 3: Implement**

Create `client/src/components/dashboard/horizonBars.ts`:

```ts
import type { ForecastComparisonSummary } from '@/types';

export interface HorizonBar {
  label: string;
  v: number;
  extrapolated?: boolean;
}

interface MetricLike { mape?: number | null; dataPoints?: number | null }

function bar(label: string, m: MetricLike | undefined): HorizonBar | null {
  if (!m || m.mape == null || !m.dataPoints) return null;
  return { label, v: m.mape };
}

/**
 * Measured MAPE by horizon.
 *
 * The previous version multiplied a measured D+1 figure by fixed factors to
 * produce D+2/D+3/D+5/D+7. `forecasts.horizon_hours` tops out at 63h, so
 * anything past D+2 has no underlying forecast and cannot be measured at all.
 * Only horizons with stored samples appear.
 */
export function buildHorizonBars(
  summary: ForecastComparisonSummary | undefined,
  forecastType: string,
): HorizonBar[] {
  const t = (summary as Record<string, never> | undefined)?.[forecastType] as
    | { tso?: { dayAhead?: MetricLike; weekAhead?: MetricLike }; ml?: { d1?: MetricLike; d2?: MetricLike } }
    | undefined;
  if (!t) return [];

  return [
    bar('ML D+1', t.ml?.d1),
    bar('ML D+2', t.ml?.d2),
    bar('TSO D+1', t.tso?.dayAhead),
    bar('TSO D+7', t.tso?.weekAhead),
  ].filter((b): b is HorizonBar => b !== null);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w client -- horizonBars`
Expected: PASS — 5 tests

- [ ] **Step 5: Wire it into ForecastTab**

In `client/src/components/dashboard/ForecastTab.tsx`: delete the `HORIZON_LABELS` / `HORIZON_FACTORS` constants and their comment block (lines 19-25). Add a summary query alongside the existing ones:

```ts
  const summaryQuery = useQuery({
    queryKey: ['forecast-tab', 'summary', selectedCountry, timePreset, timeOffset],
    queryFn: () =>
      fetchForecastComparisonSummary({
        countryCode: selectedCountry,
        start: start.toISOString(),
        end: end.toISOString(),
      }),
    staleTime: REFRESH_INTERVALS.dashboard,
  });
```

Replace the `horizonBars` computation (lines 109-115) with:

```ts
  const horizonBars = buildHorizonBars(summaryQuery.data, 'load');
```

Change the card subtitle to `"MAPE % · measured over the selected window"` and drop the conditional that mentioned extrapolation. Import `buildHorizonBars` from `./horizonBars` and `fetchForecastComparisonSummary` from `@/services/api` (it already exists — verify the exported name and adapt if it differs).

- [ ] **Step 6: Verify**

Run: `npx tsc -b client && npm test -w client`
In the browser, Belgium → Forecast accuracy: four bars labelled ML D+1 / ML D+2 / TSO D+1 / TSO D+7, none hollow. Cross-check `ML D+1 ≈ 5.92%` against:
```bash
curl -s "http://192.168.86.36:3001/api/forecast-comparison/BE/summary?forecastType=load&start=2026-07-20T00:00:00Z&end=2026-07-27T00:00:00Z" | head -c 400
```

- [ ] **Step 7: Commit**

```bash
git add client/src/components/dashboard/horizonBars.ts client/src/components/dashboard/horizonBars.test.ts client/src/components/dashboard/ForecastTab.tsx
git commit -m "fix(accuracy): measure horizon error instead of extrapolating it

D+2..D+7 were a measured D+1 multiplied by fixed factors. horizon_hours stops
at 63h so D+3/D+5/D+7 are unmeasurable; the summary endpoint already returns
measured ML D+1/D+2 and TSO D+1/D+7."
```

---

### Task 6: Flag low-sample accuracy metrics

MAE/MAPE/RMSE were shown to 3-4 significant figures from as few as **17 samples**, with the sample count styled as a peer metric.

**Files:**
- Modify: `client/src/components/dashboard/ForecastTab.tsx` (stat strip)

- [ ] **Step 1: Add a threshold constant and warning**

In `ForecastTab.tsx`, above the component:

```ts
/** Below this many paired points, MAPE/MAE/RMSE are too noisy to report plainly. */
const MIN_RELIABLE_SAMPLES = 48;
```

In the stat strip, when `loadMetrics?.count != null && loadMetrics.count < MIN_RELIABLE_SAMPLES`, render beneath the four cards:

```tsx
{loadMetrics?.count != null && loadMetrics.count < MIN_RELIABLE_SAMPLES && (
  <p className="mt-2 text-[11px] text-ink-muted">
    Only {loadMetrics.count} paired points in this window — these figures are
    indicative, not a stable estimate. Widen the range for a firmer read.
  </p>
)}
```

- [ ] **Step 2: Verify**

Run: `npx tsc -b client` → exit 0.
Select a country on `24h`; confirm the caveat appears when the sample count is small and disappears on `30d`.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/dashboard/ForecastTab.tsx
git commit -m "feat(accuracy): caveat metrics computed from too few samples"
```

---

# Phase 2 — P1: labels and readability

### Task 7: One source of truth for map metric labels and units

`MAP_METRICS` (`constants.ts:62`) drives the legend and hover card; a separate `METRICS` array (`MapMetricSelector.tsx:10`) drives the buttons. They disagree on 3 of 4 metrics — most seriously, the selector says **MW** for load while the legend renders **GW**.

**Files:**
- Modify: `client/src/lib/constants.ts:62-67`
- Modify: `client/src/components/map/MapMetricSelector.tsx:10-16`
- Modify: `client/src/components/map/EuropeMap.tsx:232-239`
- Test: `client/src/lib/mapMetrics.test.ts` (create)

**Interfaces:**
- Produces: `MAP_METRICS` entries become `{ value, label, unit, legendLabel? }`. `unit` is the unit **actually rendered**. Consumers stop overriding it.

- [ ] **Step 1: Write the failing test**

Create `client/src/lib/mapMetrics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MAP_METRICS } from './constants';

describe('MAP_METRICS', () => {
  it('states the unit that is actually rendered for load', () => {
    expect(MAP_METRICS.find((m) => m.value === 'load')!.unit).toBe('GW');
  });

  it('uses one currency notation for price', () => {
    expect(MAP_METRICS.find((m) => m.value === 'price')!.unit).toBe('€/MWh');
  });

  it('covers every selectable metric exactly once', () => {
    const values = MAP_METRICS.map((m) => m.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual(expect.arrayContaining(['price', 'renewable_pct', 'load', 'net_position']));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w client -- mapMetrics`
Expected: FAIL — load unit is `'MW'`, price unit is `'EUR/MWh'`

- [ ] **Step 3: Correct the constant**

In `client/src/lib/constants.ts` replace `MAP_METRICS`:

```ts
// The single source of truth for map metric copy. `unit` is the unit the map
// actually renders — EuropeMap divides load by 1000, so it is GW, not MW.
// `legendLabel` is what the legend says where it needs a different claim from
// the button: net position is a window average, not an instantaneous value.
// Every entry carries one so consumers can read it off the union unconditionally.
export const MAP_METRICS = [
  { value: 'price', label: 'Day-ahead price', unit: '€/MWh', legendLabel: 'Day-ahead price' },
  { value: 'renewable_pct', label: 'Renewable share', unit: '%', legendLabel: 'Renewable share' },
  { value: 'load', label: 'Electricity load', unit: 'GW', legendLabel: 'Electricity load' },
  { value: 'net_position', label: 'Net position', unit: 'MW', legendLabel: 'Avg net position' },
] as const;
```

Every entry declares `legendLabel`. Omitting it on three of four would make
`metricInfo?.legendLabel` a type error against the `as const` union.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w client -- mapMetrics`
Expected: PASS — 3 tests

- [ ] **Step 5: Delete the duplicate list**

In `client/src/components/map/MapMetricSelector.tsx`, delete the local `METRICS` array and import the shared one:

```ts
import { MAP_METRICS } from '@/lib/constants';
```

Replace both `METRICS.map(...)` occurrences with `MAP_METRICS.map(...)`.

- [ ] **Step 6: Stop overriding the unit in the legend**

In `client/src/components/map/EuropeMap.tsx`, replace lines 232-239:

```tsx
          <span className="text-xs font-medium text-foreground">
            {metricInfo?.legendLabel ?? metricInfo?.label}
          </span>
          <span className="font-mono-num text-[10.5px] text-ink-muted">
            {metricInfo?.unit}
          </span>
```

Delete the now-dead `mapMetric === 'net_position' ? 'Avg net position' : ...` conditional and the `mapMetric === 'load' ? 'GW' : ...` override. Simplify `hoverUnit` to `metricInfo?.unit ?? ''` and delete its `fallback` parameter, updating its one call site.

- [ ] **Step 7: Verify**

Run: `npx tsc -b client && npm test -w client`
On the map, cycle all four metrics: button and legend must read the same label and unit each time.

- [ ] **Step 8: Commit**

```bash
git add client/src/lib/constants.ts client/src/lib/mapMetrics.test.ts client/src/components/map/MapMetricSelector.tsx client/src/components/map/EuropeMap.tsx
git commit -m "fix(map): single source of truth for metric labels and units

The selector and legend used separate lists that disagreed on 3 of 4 metrics;
the selector claimed MW for load while the map rendered GW."
```

---

### Task 8: Label range-scoped statistics honestly

"Day-ahead price" reads €47.1 on `24h`, €90.5 on `7d`, €93.8 on `30d` for the same country at the same moment — it is a window mean. Its "−18.19% 24h" delta meanwhile stays fixed across all three, so the number and its delta describe different things. "Right now" / "GW · current" on the Generation tab are likewise window averages.

**Files:**
- Modify: `client/src/components/dashboard/AbleStatRow.tsx`
- Modify: `client/src/components/dashboard/GenerationTab.tsx` (card titles)

- [ ] **Step 1: Establish which stats are instantaneous**

Confirm by switching ranges in the browser and recording which of the four stat cards change: `Day-ahead price` (changes → window mean), `Current load` (stable → instantaneous), `Renewable share` (changes → window mean), `Peak demand` (changes → window extremum, correctly range-scoped).

- [ ] **Step 2: Add a window qualifier to the averaged cards**

The underlying field is already named `overview.avgPrice` — the label was the only thing claiming otherwise. In `client/src/components/dashboard/AbleStatRow.tsx`, add the preset to the component and a qualifier to `StatItem`:

```tsx
import { useDashboardStore } from '@/store/dashboardStore';

/** Short window label per preset, for stats that are a window aggregate. */
const WINDOW_LABEL: Record<string, string> = {
  '24h': '24h', '7d': '7d', '30d': '30d', '90d': '90d', '1y': '1y',
  today: 'today', thisWeek: 'this week',
  next24h: 'next 24h', next48h: 'next 48h', next7d: 'next 7d', next1d: 'tomorrow',
};

type StatItem = {
  label: string;
  value: string;
  unit: string;
  /** Set when the value aggregates the selected window rather than being instantaneous. */
  qualifier?: string;
  delta?: string;
  good?: boolean;
  spark: number[];
};
```

Inside the component, before `items`:

```tsx
  const timePreset = useDashboardStore((s) => s.timePreset);
  const win = WINDOW_LABEL[timePreset] ?? timePreset;
```

Then set the qualifiers — `avgPrice`, `renewablePercentage` and `peakDemand` are all window aggregates; `currentLoad` is not:

```tsx
    { label: 'Day-ahead price', qualifier: `${win} avg`, /* ...rest unchanged */ },
    { label: 'Current load',    /* no qualifier — instantaneous */ },
    { label: 'Renewable share', qualifier: `${win} avg` },
    { label: 'Peak demand',     qualifier: win },
```

Render it beside the label:

```tsx
          <div className="mb-2 flex items-baseline gap-1.5 font-mono-num text-[10px] uppercase tracking-[0.1em] text-ink-muted">
            <span>{it.label}</span>
            {it.qualifier && <span className="normal-case tracking-normal opacity-70">{it.qualifier}</span>}
          </div>
```

- [ ] **Step 3: Make the delta agree with its number**

The delta is a fixed 24h comparison while the headline is a window mean, so `€93.8 … −18.19% 24h` reads as though the 93.8 moved by 18%. Keep the 24h basis — it is the useful comparison — and label it so it cannot be misread. Replace the suffix at line 133:

```tsx
                <span className="ml-1 text-ink-muted">vs 24h ago</span>
```

- [ ] **Step 4: Fix the Generation card titles**

In `GenerationTab.tsx` (already partly done in Task 3) confirm the titles are `"Right now"` → **`"Window average"`** with subtitle `"share of load · measured sources only"`, and `"By source"` subtitle `"GW · window average"`.

- [ ] **Step 5: Verify**

Switch 24h/7d/30d and confirm every changing number carries a window qualifier and no card claims "current" or "right now" for an average.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/dashboard/AbleStatRow.tsx client/src/components/dashboard/GenerationTab.tsx
git commit -m "fix(stats): qualify window averages instead of calling them current"
```

---

### Task 9: Give the 24h chart X-axis time labels

The `7d` and `30d` views get date ticks; `24h` renders none, so the time of a peak is unreadable.

**Files:**
- Modify: `client/src/lib/chartTicks.ts`
- Modify: `client/src/components/charts/AbleLineChart.tsx`
- Test: `client/src/lib/chartTicks.test.ts` (create)

**Interfaces:**
- Produces: `timeTicks(timestamps: string[], preset: string)` → `{ index: number; label: string }[]`

- [ ] **Step 1: Write the failing test**

Create `client/src/lib/chartTicks.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { timeTicks } from './chartTicks';

const hourly = (n: number, from = '2026-07-26T00:00:00Z') =>
  Array.from({ length: n }, (_, i) =>
    new Date(new Date(from).getTime() + i * 3600_000).toISOString());

describe('timeTicks', () => {
  it('labels a 24h window by hour', () => {
    const t = timeTicks(hourly(24), '24h');
    expect(t.length).toBeGreaterThanOrEqual(4);
    expect(t[0].label).toMatch(/^\d{2}:\d{2}$/);
  });

  it('labels a multi-day window by date', () => {
    const t = timeTicks(hourly(24 * 7), '7d');
    expect(t[0].label).not.toMatch(/^\d{2}:\d{2}$/);
  });

  it('returns no ticks for an empty series', () => {
    expect(timeTicks([], '24h')).toEqual([]);
  });

  it('keeps every tick index inside the series', () => {
    const ts = hourly(24);
    expect(timeTicks(ts, '24h').every((t) => t.index >= 0 && t.index < ts.length)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w client -- chartTicks`
Expected: FAIL — `timeTicks` is not exported

- [ ] **Step 3: Implement**

Append to `client/src/lib/chartTicks.ts`:

```ts
/** Presets whose window is short enough that the hour, not the date, is the useful label. */
const HOURLY_PRESETS = new Set(['24h', 'today', 'next24h', 'next1d']);

/**
 * Evenly spaced X-axis ticks for a timestamp series. Sub-day windows are
 * labelled by hour — a 24h chart with only date ticks (or none, as before)
 * cannot tell you when the peak occurred.
 */
export function timeTicks(
  timestamps: string[],
  preset: string,
  target = 5,
): { index: number; label: string }[] {
  if (timestamps.length === 0) return [];

  const hourly = HOURLY_PRESETS.has(preset);
  const count = Math.min(target, timestamps.length);
  const step = Math.max(1, Math.floor((timestamps.length - 1) / Math.max(1, count - 1)));

  const out: { index: number; label: string }[] = [];
  for (let i = 0; i < timestamps.length; i += step) {
    const d = new Date(timestamps[i]);
    if (Number.isNaN(d.getTime())) continue;
    out.push({
      index: i,
      label: hourly
        ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
        : d.toLocaleDateString([], { day: 'numeric', month: 'short' }),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w client -- chartTicks`
Expected: PASS — 4 tests

- [ ] **Step 5: Use it in the line chart**

In `client/src/components/charts/AbleLineChart.tsx`, accept a `preset` prop and replace the existing X-tick derivation with `timeTicks(series.map(p => p.timestamp), preset)`. Pass `preset={timePreset}` from `LoadTab`, `PriceTab` and `NetPositionTab`.

- [ ] **Step 6: Verify**

Run: `npx tsc -b client && npm test -w client`
On `24h`, the load chart shows hour labels (e.g. `06:00`, `12:00`); on `7d` it still shows dates.

- [ ] **Step 7: Commit**

```bash
git add client/src/lib/chartTicks.ts client/src/lib/chartTicks.test.ts client/src/components/charts/AbleLineChart.tsx client/src/components/dashboard/LoadTab.tsx client/src/components/dashboard/PriceTab.tsx client/src/components/dashboard/NetPositionTab.tsx
git commit -m "fix(charts): label the 24h x-axis by hour

The 24h preset rendered no time ticks at all, so the time of a peak was
unreadable."
```

---

### Task 10: Distinguish "no data" from "zero" on the map

`NO_DATA = '#EDEBE3'` and `NEUTRAL_ZERO = '#F4F1EC'` are near-identical beige. On the net-position diverging scale a balanced country and a missing one are indistinguishable. No-data countries are additionally drawn at `opacity: 0.55`, the same value applied to data countries when another is hovered.

**Files:**
- Modify: `client/src/components/map/EuropeMap.tsx:35, 41, 165-186, 275-281`

- [ ] **Step 1: Give no-data a non-competing treatment**

Replace the constant and add a hatch pattern. In `EuropeMap.tsx`:

```ts
// No-data must not sit on the same beige axis as the diverging scale's zero,
// or a balanced country and a missing one read identically.
const NO_DATA = '#E4E0D6';
```

Inside `<ComposableMap>`, before `<Geographies>`, add:

```tsx
<defs>
  <pattern id="no-data-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <rect width="6" height="6" fill={NO_DATA} />
    <line x1="0" y1="0" x2="0" y2="6" stroke="#CFCABE" strokeWidth="1.5" />
  </pattern>
</defs>
```

Change the `fill` prop to `fill={has ? dataColor(mapMetric, d!.value, min, max) : 'url(#no-data-hatch)'}` and drop the `opacity: has ? ... : 0.55` special-case for no-data so hover dimming is the only thing opacity expresses.

- [ ] **Step 2: Update the legend swatch to match**

In the legend's no-data row, replace the flat `style={{ background: NO_DATA }}` swatch with a small inline SVG using the same hatch so the key matches the map.

- [ ] **Step 3: Guard against null-valued rows**

`dataMap` is built from all rows including any with `value == null`, which would make `has` true and feed `null` into `dataColor` → `NaN` fill. Filter at construction (lines 132-139):

```ts
    const usable = mapData.filter((d) => d.value != null && Number.isFinite(d.value));
    const values = usable.map((d) => d.value);
    const dataMap = new Map(usable.map((d) => [d.country_code, d]));
    if (values.length === 0) return { min: 0, max: 100, dataMap };
    return { min: Math.min(...values), max: Math.max(...values), dataMap };
```

- [ ] **Step 4: Verify**

Select **Net position**. Countries near zero render pale solid; countries with no data render hatched and are unmistakably different. Confirm no console warnings about invalid `fill`.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/map/EuropeMap.tsx
git commit -m "fix(map): make no-data visually distinct from a zero net position"
```

---

### Task 11: Make the map usable on mobile

At 390px the floating metric selector overflows off-screen (`Net position` is clipped) and the map renders tiny because the projection scale is hardcoded to 440.

**Files:**
- Modify: `client/src/components/map/MapMetricSelector.tsx` (floating wrapper)
- Modify: `client/src/components/map/EuropeMap.tsx:150-156`

- [ ] **Step 1: Let the selector scroll instead of overflow**

Change the `floating` wrapper class to keep it on-screen and horizontally scrollable:

```ts
  const wrapperCls = floating
    ? 'absolute top-3 left-1/2 -translate-x-1/2 z-[5] flex max-w-[calc(100vw-1.5rem)] gap-0.5 overflow-x-auto p-[3px] bg-card rounded-[10px] border border-border shadow-[0_4px_16px_rgba(0,0,0,0.05)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
    : 'inline-flex gap-0.5 p-[3px] bg-card rounded-[10px] border border-border';
```

Add `whitespace-nowrap shrink-0` to each button's class list so labels stop wrapping to three lines.

- [ ] **Step 2: Scale the projection to the viewport**

In `EuropeMap.tsx`, replace the hardcoded scale with a measured one. Add above the return:

```ts
  const [vw, setVw] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Narrow viewports need a smaller scale to fit Europe, but the previous fixed
  // 440 left the map a thumbnail in a sea of whitespace on phones.
  const projectionScale = fullScreen ? (vw < 640 ? 300 : vw < 1024 ? 380 : 440) : 260;
```

Use `scale: projectionScale` in `projectionConfig` and `height={fullScreen ? (vw < 640 ? 520 : 650) : 420}`.

- [ ] **Step 3: Verify**

Resize the browser to 390×844. All four metric buttons must be reachable (scrolling horizontally if needed), none clipped, and the map must fill the available width.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/map/MapMetricSelector.tsx client/src/components/map/EuropeMap.tsx
git commit -m "fix(map): keep the metric selector on-screen and scale the map on mobile"
```

---

### Task 12: Explain the trailing data gap and make the forecast band visible

Two defects in the same chart. Actuals stop 7-10h short of the `now` marker with no explanation (the header's "sync N hours ago" is far away and easy to miss). And on the net-position chart the p10–p90 band is so low-contrast against the card background that the forecast reads as empty space.

**Files:**
- Modify: `client/src/components/charts/AbleLineChart.tsx`
- Test: `client/src/lib/trailingGap.test.ts` (create)
- Create: `client/src/lib/trailingGap.ts`

**Interfaces:**
- Produces: `trailingGapLabel(lastActualIso, now)` → `string | null`

- [ ] **Step 1: Write the failing test**

Create `client/src/lib/trailingGap.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { trailingGapLabel } from './trailingGap';

const NOW = new Date('2026-07-27T13:00:00Z');

describe('trailingGapLabel', () => {
  it('stays silent when actuals are current', () => {
    expect(trailingGapLabel('2026-07-27T12:30:00Z', NOW)).toBeNull();
  });

  it('names the lag once it exceeds the threshold', () => {
    expect(trailingGapLabel('2026-07-27T06:00:00Z', NOW)).toBe('last actual 7h ago');
  });

  it('rounds down to whole hours', () => {
    expect(trailingGapLabel('2026-07-27T05:45:00Z', NOW)).toBe('last actual 7h ago');
  });

  it('returns null for a missing or unparseable timestamp', () => {
    expect(trailingGapLabel(undefined, NOW)).toBeNull();
    expect(trailingGapLabel('not-a-date', NOW)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w client -- trailingGap`
Expected: FAIL — cannot find module `./trailingGap`

- [ ] **Step 3: Implement**

Create `client/src/lib/trailingGap.ts`:

```ts
/** Below this many hours the gap is normal publication lag and not worth noting. */
const THRESHOLD_HOURS = 2;

/**
 * Label for the gap between the last actual point and now.
 *
 * ENTSO-E actuals arrive hours late, which drew a line stopping well short of
 * the `now` marker with nothing on the chart explaining why.
 */
export function trailingGapLabel(lastActualIso: string | undefined, now: Date): string | null {
  if (!lastActualIso) return null;
  const t = Date.parse(lastActualIso);
  if (Number.isNaN(t)) return null;

  const hours = Math.floor((now.getTime() - t) / 3_600_000);
  if (hours < THRESHOLD_HOURS) return null;
  return `last actual ${hours}h ago`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w client -- trailingGap`
Expected: PASS — 5 assertions across 4 tests

- [ ] **Step 5: Render the label**

In `client/src/components/charts/AbleLineChart.tsx`, compute the last actual timestamp from `series` and render the label beneath the `now` marker when non-null:

```tsx
{gapLabel && (
  <text
    x={nowX}
    y={12}
    textAnchor="end"
    className="font-mono-num"
    fontSize={10}
    fill="hsl(var(--muted-foreground))"
  >
    {gapLabel}
  </text>
)}
```

- [ ] **Step 6: Raise the forecast band's contrast**

In the same file, the p10–p90 band fill is too light to read. Raise its opacity and give it a defined edge:

```tsx
<path d={bandPath} fill="hsl(var(--primary))" fillOpacity={0.16} />
<path d={bandUpperPath} fill="none" stroke="hsl(var(--primary))" strokeOpacity={0.35} strokeWidth={1} strokeDasharray="3 3" />
<path d={bandLowerPath} fill="none" stroke="hsl(var(--primary))" strokeOpacity={0.35} strokeWidth={1} strokeDasharray="3 3" />
```

- [ ] **Step 7: Verify**

Run: `npx tsc -b client && npm test -w client`
On France → Load the trailing gap is labelled. On France → Net position the p10–p90 band is clearly visible with dashed edges.

- [ ] **Step 8: Commit**

```bash
git add client/src/lib/trailingGap.ts client/src/lib/trailingGap.test.ts client/src/components/charts/AbleLineChart.tsx
git commit -m "feat(charts): label the trailing data gap and make the forecast band visible"
```

---

# Phase 3 — infrastructure

### Task 13: Make the server response cache capable of hitting

The cache key is `${req.method}:${req.originalUrl}` and the client sends `new Date().toISOString()` at millisecond precision, so **every** ranged request is a unique key and the cache never hits.

**Files:**
- Modify: `server/src/middleware/cache.ts:72-96`
- Test: `server/src/middleware/cache.test.ts` (create)

**Interfaces:**
- Produces: `buildCacheKey(method, url, bucketMs)` → string with `start`/`end` query params floored to `bucketMs`

- [ ] **Step 1: Write the failing test**

Create `server/src/middleware/cache.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildCacheKey } from './cache.js';

const BUCKET = 60_000;

describe('buildCacheKey', () => {
  it('collapses timestamps inside the same bucket', () => {
    const a = buildCacheKey('GET', '/api/load?country=FR&start=2026-07-27T13:14:36.923Z', BUCKET);
    const b = buildCacheKey('GET', '/api/load?country=FR&start=2026-07-27T13:14:59.001Z', BUCKET);
    expect(a).toBe(b);
  });

  it('separates timestamps in different buckets', () => {
    const a = buildCacheKey('GET', '/api/load?country=FR&start=2026-07-27T13:14:00.000Z', BUCKET);
    const b = buildCacheKey('GET', '/api/load?country=FR&start=2026-07-27T13:16:00.000Z', BUCKET);
    expect(a).not.toBe(b);
  });

  it('keeps non-timestamp params significant', () => {
    const a = buildCacheKey('GET', '/api/load?country=FR', BUCKET);
    const b = buildCacheKey('GET', '/api/load?country=DE', BUCKET);
    expect(a).not.toBe(b);
  });

  it('passes through urls with no timestamps unchanged in meaning', () => {
    expect(buildCacheKey('GET', '/api/countries', BUCKET)).toBe(buildCacheKey('GET', '/api/countries', BUCKET));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- cache`
Expected: FAIL — `buildCacheKey` is not exported

- [ ] **Step 3: Implement**

In `server/src/middleware/cache.ts`:

```ts
/** Timestamp query params rounded down before keying, so the cache can hit. */
const TIME_PARAMS = ['start', 'end'];

/**
 * Cache key with timestamp params floored to a bucket.
 *
 * The client derives start/end from `new Date()` at millisecond precision, so
 * keying on the raw URL made every ranged request a unique key and the cache
 * never hit once.
 */
export function buildCacheKey(method: string, originalUrl: string, bucketMs: number): string {
  const qIndex = originalUrl.indexOf('?');
  if (qIndex === -1) return `${method}:${originalUrl}`;

  const path = originalUrl.slice(0, qIndex);
  const params = new URLSearchParams(originalUrl.slice(qIndex + 1));

  for (const p of TIME_PARAMS) {
    const raw = params.get(p);
    if (!raw) continue;
    const t = Date.parse(raw);
    if (Number.isNaN(t)) continue;
    params.set(p, new Date(Math.floor(t / bucketMs) * bucketMs).toISOString());
  }

  params.sort();
  return `${method}:${path}?${params.toString()}`;
}
```

Then use it in the middleware, bucketing at one minute or the TTL, whichever is smaller:

```ts
export function cacheMiddleware(ttlMs: number = TTL.MEDIUM) {
  const bucketMs = Math.min(60_000, ttlMs);
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = buildCacheKey(req.method, req.originalUrl, bucketMs);
    // ...rest unchanged, using `key`
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- cache`
Expected: PASS — 4 tests

- [ ] **Step 5: Verify the hit rate changed**

Start the local server (`npm run dev:server` with `server/.env` pointing at the replica) and issue two requests a few seconds apart with different millisecond stamps inside the same minute; the second must return materially faster.

- [ ] **Step 6: Commit**

```bash
git add server/src/middleware/cache.ts server/src/middleware/cache.test.ts
git commit -m "fix(cache): bucket timestamp params so the response cache can hit

Keying on the raw URL made every ranged request unique, because the client
sends millisecond-precision ISO timestamps."
```

---

### Task 14: Stop retries from amplifying a stalled backend

`retry: 2` with a 30s axios timeout means a slow endpoint hangs the UI for up to 90s and triples load on a server that is already blocked (better-sqlite3 is synchronous — one slow query stalls every request; `/api/health` was measured at 14-17s during a stall).

**Files:**
- Modify: `client/src/App.tsx:13-21`
- Modify: `client/src/services/api.ts:41-44`

- [ ] **Step 1: Tighten the client policy**

In `App.tsx`:

```ts
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 2,
      // The API is single-threaded and synchronous; a slow query blocks every
      // other request. Retrying a timeout triples the load that caused it.
      retry: (failureCount, error) => {
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 1;
      },
      retryDelay: (attempt) => Math.min(4000, 1000 * 2 ** attempt),
      refetchOnWindowFocus: false,
    },
  },
});
```

In `api.ts`, drop the axios timeout to something a user will wait through:

```ts
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
});
```

- [ ] **Step 2: Verify**

Run: `npx tsc -b client` → exit 0. Load the app and confirm normal requests still succeed.

- [ ] **Step 3: Commit**

```bash
git add client/src/App.tsx client/src/services/api.ts
git commit -m "fix(query): stop retries amplifying load on a stalled API"
```

---

### Task 15: Validate API response shape

`fetchForecastModels` returns `data.data` with no validation. A non-JSON response (a proxy error page, which occurred during this audit) yields `undefined` and React Query logs *"Query data cannot be undefined"* while the picker breaks silently.

**Files:**
- Modify: `client/src/services/api.ts`
- Test: `client/src/services/unwrap.test.ts` (create)
- Create: `client/src/services/unwrap.ts`

**Interfaces:**
- Produces: `unwrap<T>(body, endpoint)` → `T`; throws a descriptive `Error` when the envelope is malformed

- [ ] **Step 1: Write the failing test**

Create `client/src/services/unwrap.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { unwrap } from './unwrap';

describe('unwrap', () => {
  it('returns the payload from a well-formed envelope', () => {
    expect(unwrap({ success: true, data: [1, 2] }, '/x')).toEqual([1, 2]);
  });

  it('throws when the body is an HTML error page', () => {
    expect(() => unwrap('<!doctype html><title>404</title>' as never, '/x'))
      .toThrow(/\/x/);
  });

  it('throws when data is missing', () => {
    expect(() => unwrap({ success: true } as never, '/models')).toThrow(/\/models/);
  });

  it('allows a legitimately null payload through as null', () => {
    expect(unwrap({ success: true, data: null }, '/x')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w client -- unwrap`
Expected: FAIL — cannot find module `./unwrap`

- [ ] **Step 3: Implement**

Create `client/src/services/unwrap.ts`:

```ts
import type { ApiResponse } from '@/types';

/**
 * Pull the payload out of the `{ success, data }` envelope.
 *
 * Returning `data.data` unchecked meant a proxy error page (HTML, HTTP 200)
 * became `undefined`, which React Query rejects with an opaque message while
 * the feature silently breaks.
 */
export function unwrap<T>(body: ApiResponse<T> | unknown, endpoint: string): T {
  if (typeof body !== 'object' || body === null || !('data' in body)) {
    throw new Error(
      `Malformed response from ${endpoint}: expected a { success, data } envelope, got ${typeof body}`,
    );
  }
  return (body as ApiResponse<T>).data;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w client -- unwrap`
Expected: PASS — 4 tests

- [ ] **Step 5: Apply it to the registry fetch and its neighbours**

In `client/src/services/api.ts`, route `fetchForecastModels`, `fetchCountries` and `fetchDashboardOverview` through it:

```ts
export async function fetchForecastModels(): Promise<ForecastModelRegistry> {
  const { data } = await api.get<ApiResponse<ForecastModelRegistry>>('/forecasts/models');
  return unwrap(data, '/forecasts/models');
}
```

- [ ] **Step 6: Verify**

Run: `npx tsc -b client && npm test -w client`

- [ ] **Step 7: Commit**

```bash
git add client/src/services/unwrap.ts client/src/services/unwrap.test.ts client/src/services/api.ts
git commit -m "fix(api): fail loudly on a malformed response envelope"
```

---

### Task 16: Version the persisted store

`persist` has no `version` or `migrate`, so a shape change silently corrupts returning users' state. The audit hit this directly: a persisted `currentView` sent a fresh session to a stale country view. The store also mirrors `layers.*` onto four legacy booleans, hand-synced in four places.

**Files:**
- Modify: `client/src/store/dashboardStore.ts:528-559`
- Test: `client/src/store/migrate.test.ts` (create)

**Interfaces:**
- Produces: `migratePersisted(state, fromVersion)` → persisted-state shape at the current version

- [ ] **Step 1: Write the failing test**

Create `client/src/store/migrate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { migratePersisted, PERSIST_VERSION } from './migrate';

describe('migratePersisted', () => {
  it('drops a persisted view that no longer exists', () => {
    const out = migratePersisted({ currentView: 'analytics', selectedCountry: 'BE' }, 0);
    expect(out.currentView).toBe('map');
  });

  it('keeps a valid view', () => {
    expect(migratePersisted({ currentView: 'country' }, 0).currentView).toBe('country');
  });

  it('derives legacy booleans from layers', () => {
    const out = migratePersisted({ layers: { showActuals: true, tso: { enabled: true, showAccuracy: false, horizon: 'day_ahead' }, ml: { enabled: false, showAccuracy: false } } }, 0);
    expect(out.showTSOForecast).toBe(true);
    expect(out.showForecast).toBe(false);
  });

  it('is a no-op at the current version', () => {
    const s = { currentView: 'map' as const };
    expect(migratePersisted(s, PERSIST_VERSION)).toEqual(s);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w client -- migrate`
Expected: FAIL — cannot find module `./migrate`

- [ ] **Step 3: Implement**

Create `client/src/store/migrate.ts`:

```ts
export const PERSIST_VERSION = 1;

const VALID_VIEWS = new Set(['map', 'country', 'comparison']);

/**
 * Bring persisted state forward. Without this a shape change left returning
 * users on state the code no longer understands — a stale `currentView` sent
 * fresh sessions straight into a country view they never chose.
 */
export function migratePersisted(state: Record<string, unknown>, fromVersion: number): Record<string, unknown> {
  if (fromVersion >= PERSIST_VERSION) return state;

  const next = { ...state };

  if (typeof next.currentView !== 'string' || !VALID_VIEWS.has(next.currentView)) {
    next.currentView = 'map';
  }

  const layers = next.layers as
    | { tso?: { enabled?: boolean; showAccuracy?: boolean }; ml?: { enabled?: boolean; showAccuracy?: boolean } }
    | undefined;
  if (layers) {
    next.showTSOForecast = !!layers.tso?.enabled;
    next.showForecast = !!layers.ml?.enabled;
    next.showTSOComparisonMode = !!layers.tso?.showAccuracy;
    next.showComparisonMode = !!layers.ml?.showAccuracy;
  }

  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w client -- migrate`
Expected: PASS — 4 tests

- [ ] **Step 5: Wire it into the store**

In `client/src/store/dashboardStore.ts`, in the `persist` options object:

```ts
      name: 'energy-dashboard-storage',
      version: PERSIST_VERSION,
      migrate: (persisted, from) => migratePersisted(persisted as Record<string, unknown>, from),
      partialize: /* unchanged */,
```

- [ ] **Step 6: Verify**

In DevTools set `localStorage['energy-dashboard-storage']` to `{"state":{"currentView":"analytics"},"version":0}`, reload, and confirm the app lands on the map.

- [ ] **Step 7: Commit**

```bash
git add client/src/store/migrate.ts client/src/store/migrate.test.ts client/src/store/dashboardStore.ts
git commit -m "fix(store): version persisted state and migrate stale shapes"
```

---

# Phase 4 — comparison view

### Task 17: Replace MAPE with WAPE

Two independent defects in `crossCountryMetricsService.ts:94-99`. It divides by the **signed** actual, so negative day-ahead prices cancel error rather than adding to it; and the `!= 0` guard does not exclude near-zero actuals, so one €0.01 price or one night-time solar reading dominates the mean. Measured results: BE solar **148458.2%**, AT price 3670.8%, every country's price MAPE between 249% and 3740%.

WAPE = `100 × Σ|actual − forecast| / Σ|actual|` is scale-free, well-defined whenever the summed magnitude is non-zero, and handles negatives correctly.

**Files:**
- Modify: `server/src/services/crossCountryMetricsService.ts:88-126`
- Modify: `server/src/routes/crossCountryComparison.ts` (metric name passthrough)
- Modify: `client/src/lib/comparisonConstants.ts`
- Modify: `client/src/store/dashboardStore.ts` (`comparisonMetric` union)
- Test: `server/src/services/crossCountryMetricsService.test.ts` (create)

**Interfaces:**
- Produces: `CrossCountryMetricsEntry` gains `wape: number | null` and keeps `mae`/`rmse`/`bias`; `mape` is removed. The client's `comparisonMetric` union becomes `'wape' | 'mae' | 'rmse'`.

- [ ] **Step 1: Write the failing test**

Create `server/src/services/crossCountryMetricsService.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { wape } from './crossCountryMetricsService.js';

describe('wape', () => {
  it('is zero for a perfect forecast', () => {
    expect(wape([{ actual: 50, forecast: 50 }, { actual: 20, forecast: 20 }])).toBe(0);
  });

  it('does not explode on a near-zero actual', () => {
    const v = wape([{ actual: 0.01, forecast: 5 }, { actual: 100, forecast: 100 }]);
    expect(v).toBeLessThan(20);
  });

  it('does not let negative actuals cancel error', () => {
    const v = wape([{ actual: -50, forecast: 0 }, { actual: 50, forecast: 0 }]);
    expect(v).toBe(100);
  });

  it('returns null when the summed magnitude is zero', () => {
    expect(wape([{ actual: 0, forecast: 3 }])).toBeNull();
  });

  it('returns null for an empty series', () => {
    expect(wape([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- crossCountryMetricsService`
Expected: FAIL — `wape` is not exported

- [ ] **Step 3: Implement the helper and change the SQL**

In `server/src/services/crossCountryMetricsService.ts`:

```ts
/**
 * Weighted absolute percentage error: 100 * sum|e| / sum|actual|.
 *
 * Replaces MAPE, which divided by the SIGNED actual (so negative day-ahead
 * prices cancelled error) and guarded only `!= 0` (so a single near-zero
 * actual dominated the mean — BE solar measured 148458%).
 */
export function wape(pairs: Array<{ actual: number; forecast: number }>): number | null {
  let num = 0;
  let den = 0;
  for (const { actual, forecast } of pairs) {
    if (!Number.isFinite(actual) || !Number.isFinite(forecast)) continue;
    num += Math.abs(actual - forecast);
    den += Math.abs(actual);
  }
  if (den === 0) return null;
  return Math.round((100 * num / den) * 100) / 100;
}
```

Replace the `mape` expression in the SQL (lines 94-99) with a WAPE computed in the same single pass:

```sql
      CASE WHEN SUM(ABS(${actualColumn})) > 0
        THEN ROUND(100.0 * SUM(ABS(${actualColumn} - f.forecast_value)) / SUM(ABS(${actualColumn})), 2)
        ELSE NULL
      END as wape,
```

Update the row type (`mape: number | null` → `wape: number | null`) and the mapping at line 125 (`mape: row.mape ?? 0` → `wape: row.wape`). Keep `null` rather than coercing to `0` — a metric with no denominator is absent, not perfect.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- crossCountryMetricsService`
Expected: PASS — 5 tests

- [ ] **Step 5: Rename on the client**

In `client/src/lib/comparisonConstants.ts` and `dashboardStore.ts`, change the metric union to `'wape' | 'mae' | 'rmse'` and default `comparisonMetric` to `'wape'`. Update the `ComparisonFilterBar` button label to `WAPE`. Add a `migratePersisted` clause (Task 16) mapping a stored `'mape'` to `'wape'`.

- [ ] **Step 6: Verify against real data**

Run:
```bash
curl -s "http://192.168.86.36:3001/api/cross-country/metrics?metric=wape&forecastType=all&timeRange=30d" | head -c 400
```
Expected: price and solar values in a plausible band (tens of percent), not thousands.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/crossCountryMetricsService.ts server/src/services/crossCountryMetricsService.test.ts server/src/routes/crossCountryComparison.ts client/src/lib/comparisonConstants.ts client/src/store/dashboardStore.ts client/src/components/comparison/ComparisonFilterBar.tsx client/src/store/migrate.ts
git commit -m "fix(comparison): replace degenerate MAPE with WAPE

MAPE divided by the signed actual, so negative prices cancelled error, and
guarded only != 0, so near-zero actuals dominated — BE solar read 148458%."
```

---

### Task 18: Make the comparison view reachable

`goToComparison` is never called from any component, so `ComparisonView` and its four children are unreachable except by hand-editing localStorage.

**Files:**
- Modify: `client/src/components/layout/AbleHeader.tsx:14-25`

- [ ] **Step 1: Add the nav entry**

In `AbleHeader.tsx`, pull `goToComparison` from the store and extend `navItems`:

```ts
  const { currentView, goToMap, goToComparison } = useDashboardStore();

  const navItems: { key: 'map' | 'compare' | 'docs' | 'api'; label: string; onClick: () => void }[] = [
    { key: 'map', label: 'Map', onClick: goToMap },
    { key: 'compare', label: 'Compare', onClick: goToComparison },
    { key: 'docs', label: 'Docs', onClick: () => window.open(`${REPO_URL}#readme`, '_blank') },
    { key: 'api', label: 'API', onClick: () => window.open('/api/health', '_blank') },
  ];

  const isActive = (k: string) =>
    k === 'map'
      ? currentView === 'map' || currentView === 'country'
      : k === 'compare'
        ? currentView === 'comparison'
        : false;
```

- [ ] **Step 2: Verify**

Run: `npx tsc -b client` → exit 0. Click **Compare** in the header; the cross-country view opens and the tab shows as active. The heatmap's values must be WAPE from Task 17.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/layout/AbleHeader.tsx
git commit -m "feat(nav): make the cross-country comparison reachable"
```

---

### Task 19: Delete dead code

Confirmed unreferenced by the audit: all 7 files in `components/analytics/` (`ForecastAnalyticsPanel` and its children, reachable only through a barrel nothing imports), plus `CountryRankings`, `QuickStatsPanel`, `AbleMultiModelBars`. `ThemeToggle` is dead but **deliberately** so (`themeStore.ts:28` — dark is unfinished and not exposed); leave it and add a comment.

**Files:**
- Delete: `client/src/components/analytics/` (all 7 files)
- Delete: `client/src/components/map/CountryRankings.tsx`
- Delete: `client/src/components/map/QuickStatsPanel.tsx`
- Delete: `client/src/components/charts/AbleMultiModelBars.tsx`
- Modify: `client/src/components/ui/theme-toggle.tsx` (comment only)

- [ ] **Step 1: Re-verify each file is unreferenced**

Run:
```bash
cd client/src && for c in ForecastAnalyticsPanel AccuracyTrendChart ComparisonTable MetricCard ProviderHorizonSelector AnalyticsTimeSelector ForecastTypeSelector CountryRankings QuickStatsPanel AbleMultiModelBars; do
  echo -n "$c: "; grep -rl "\b$c\b" --include="*.tsx" --include="*.ts" . | grep -v "components/analytics/" | grep -v "/$c\.tsx" | wc -l
done
```
Expected: `0` for every entry. **If any is non-zero, stop and investigate — do not delete it.**

- [ ] **Step 2: Delete**

```bash
git rm -r client/src/components/analytics
git rm client/src/components/map/CountryRankings.tsx client/src/components/map/QuickStatsPanel.tsx client/src/components/charts/AbleMultiModelBars.tsx
```

- [ ] **Step 3: Record why ThemeToggle stays**

Add at the top of `client/src/components/ui/theme-toggle.tsx`:

```tsx
// Intentionally not mounted. Light is the designed mode and dark is a coarse
// retune (see store/themeStore.ts), so the toggle is kept ready rather than
// shipped half-finished. Delete this component only alongside the dark tokens.
```

- [ ] **Step 4: Verify**

Run: `npx tsc -b client && npm test -w client && npm run build -w client`
Expected: all succeed; no unresolved imports.

- [ ] **Step 5: Commit**

```bash
git add -A client/src/components
git commit -m "refactor: remove unreferenced analytics panel and map widgets

The analytics folder was reachable only through a barrel nothing imported."
```

---

# Phase 5 — documentation

### Task 20: Bring CLAUDE.md in line with the codebase

`CLAUDE.md` documents `LoadChart.tsx`, `PriceChart.tsx`, `RenewableMixChart.tsx`, `TimeNavigator.tsx`, `MiniTimeline.tsx` and `TimeContextBar.tsx` — none of which exist — and a DB path (`../data_gathering/energy_dashboard.db`) that no longer matches `server/src/config/database.ts` (`ENERGY_DB_PATH`, default `/data/energy_dashboard.db`).

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Correct the structure and paths**

Replace the Project Structure tree with the real one (`views/`, `components/{charts,comparison,dashboard,layout,map,ui}`, `hooks/`, `lib/`, `store/`). Replace the Database Connection section with the `ENERGY_DB_PATH` mechanism and note `client/.env.local`'s `API_PROXY_TARGET` for pointing acceptance at another backend.

- [ ] **Step 2: Document the model registry rule**

Add a section recording the invariant Task 1 established:

```markdown
### Forecast model selection

`server/src/config/forecastModels.ts` is the registry. A model must be listed
there to be served at all.

**The client sends `model=` only when the user explicitly picked one.** Leaving
it off lets the server walk its candidate ladder. This matters because catboost
and xgboost cover disjoint country sets — pinning the production model blanks
load for AT/BE/FR and price for BE/DE/ES/FR/PT. The picker labels whichever
model `meta.model` reports actually served.
```

- [ ] **Step 3: Record what the database does not contain**

```markdown
### Data the database does not have

- **Nuclear and fossil generation.** Only `energy_renewable` is ingested. Do not
  derive them — a previous version showed nuclear as a flat 20% of load for
  every country. Adding them needs ENTSO-E *Actual Generation per Production
  Type* (document A75) in the data_gathering module.
- **Forecast horizons beyond 63h.** `forecasts.horizon_hours` spans 4..63, so
  D+1 and D+2 are measurable and D+3 onward are not.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: correct CLAUDE.md to the current structure and data limits"
```

---

## Out of scope — carried forward

These were found during the audit but are not fixed by this plan.

1. **Acceptance backend cold-query latency.** Cold 30d `/renewables/mix` measured **88-150s+** against `192.168.86.36:3001`; the identical query on the same-size local replica runs in **29ms** using `idx_renewable_country_time`. Because better-sqlite3 is synchronous, one such query blocks every other request — `/api/health`, which touches no DB, measured 14-17s during a stall. Task 13 and Task 14 reduce the amplification but not the cause. **Next step:** compare `sqlite_master` indexes and `EXPLAIN QUERY PLAN` on the prod DB against the replica, and check disk/contention on that host. This is the single biggest drag on acceptance.

2. **ENTSO-E A75 ingest** (`data_gathering` module) — the prerequisite that would let Task 4's unattributed remainder become a real nuclear/fossil breakdown.

3. **Chart and map accessibility.** Every chart and the map render as a single `img` node with no accessible values; map countries have no keyboard path, no `aria-label`; range buttons lack `aria-pressed`. A focused a11y pass deserves its own plan.

4. **`net_position` "24h" showing 4 days.** `useNetPositionData` extends `end` to now+3d by design so the D+2 forecast stays on-chart. Correct behaviour, misleading range label — decide whether the segment control should read differently on that tab.

---

## Verification checklist

Run after the final task:

```bash
npx tsc -b client && npm test -w client && npm test -w server && npm run build -w client
```

Then confirm in the browser at `http://localhost:5173`:

- [ ] France → Load shows a forecast line; picker reads **able-ml · xgboost**
- [ ] Belgium → Load and → Price both show forecast lines
- [ ] `+24h` renders a forecast rather than "try a longer range like 30d"
- [ ] Generation tab never flashes "0% RENEWABLE" when switching 24h/7d/30d
- [ ] No "Nuclear" or "Gas + other" row anywhere
- [ ] Forecast accuracy shows four measured bars, none hollow
- [ ] Map button and legend agree on label and unit for all four metrics
- [ ] Net position map: no-data countries are hatched, distinct from zero
- [ ] 24h chart has hour labels on the x-axis
- [ ] 390px viewport: all four metric buttons reachable, map fills the width
- [ ] Header **Compare** opens the cross-country view; no value exceeds ~100%
