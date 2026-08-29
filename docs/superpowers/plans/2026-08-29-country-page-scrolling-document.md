# Country Page as a Scrolling Document — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the country view's flat seven-tab row with one scrolling document of numbered, captioned figures, each carrying its own forecast-accuracy claim.

**Architecture:** A `<Figure>` primitive wraps the existing `Able*` Recharts components, adding a caption and a footnote. The footnote carries an `<AccuracyBadge>` whose three states (measured / not-measurable / withheld) derive from one pure function, and — where a forecast type exists — a `<ResidualStrip>`. Server-side, `AccuracyMetrics` gains a `wape` field reduced through the single `services/wape.ts` definition. The new view is built behind a query-param flag so it can be compared against the live tab view before anything is deleted.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind, Recharts, Zustand (persisted), TanStack Query, Express, better-sqlite3, Vitest.

**Spec:** [`docs/superpowers/specs/2026-08-29-country-page-scrolling-document-design.md`](../specs/2026-08-29-country-page-scrolling-document-design.md)

## Global Constraints

- **Node 24 for both suites.** `server/node_modules/better-sqlite3` is compiled for ABI 137; the server suite halts on the ABL-309 preflight under Node 25. The nvm4w default on `PATH` is v24.18.0.
- **Never run `npm install` / `npm ci` / `npm rebuild` in this checkout.** ~20 concurrent node processes share it. Everything below uses already-installed packages.
- **`services/wape.ts` is the single WAPE definition.** Never write a second one. Adapters that *reduce through* it are fine; re-deriving the arithmetic is not.
- **NULL, never 0, when a value is not measurable.** A confidently wrong number is an incident; a missing one is a bug.
- **Divergent basis (NL) withholds every error measure and the forecast line itself.** Route through `services/loadForecastBasis.ts`; never re-derive from a threshold or a country list.
- **Timestamps:** every window predicate goes through `server/src/utils/timestamp.ts`. No `date()`/`strftime()` on a column in a filter or join.
- **Before marking done:** `npm run predone` from the repo root. Publishing to `origin/main` is the last step of done.
- **`@testing-library/jest-dom` is NOT installed** and must not be added (see the
  no-install rule above). Only `@testing-library/react` ^16.3.2 and `/dom` are
  present, so `toBeInTheDocument()`, `toBeEmptyDOMElement()` and friends do not
  exist. Assert with plain Vitest against DOM queries — `expect(queryByText(x))
  .not.toBeNull()`, `expect(container.innerHTML).toBe('')` — as every existing
  client test does.
- Commit messages: conventional prefixes (`feat:`, `fix:`, `test:`, `refactor:`).

## File Structure

**Server — create**
- `server/src/services/wapeFromAccuracyPoints.ts` — adapter turning `ForecastAccuracyDataPoint[]` into the pair shape `wape()` consumes. Exists so the reconstruction `forecast = actual − error` is written once and tested once.
- `server/src/services/wapeFromAccuracyPoints.test.ts`

**Server — modify**
- `server/src/services/forecastComparisonService.ts` — `wape` on `AccuracyMetrics` (`:26`), populated at all three assembly points (`addBiasToTSOMetrics:241`, `addBiasToGenerationMetrics:284`, `addBiasToMetrics:316`).
- `server/src/routes/forecastComparison.test.ts` — assert `wape` present on the summary payload.

**Client — create**
- `client/src/components/dashboard/accuracyBadgeState.ts` — the three-state derivation. Pure, no React.
- `client/src/components/dashboard/accuracyBadgeState.test.ts`
- `client/src/components/dashboard/AccuracyBadge.tsx`
- `client/src/components/dashboard/AccuracyBadge.test.tsx`
- `client/src/components/dashboard/Figure.tsx` — `<Figure>` + `<FigureFootnote>`
- `client/src/components/dashboard/Figure.test.tsx`
- `client/src/components/charts/AbleResidualStrip.tsx`
- `client/src/components/charts/AbleResidualStrip.test.tsx`
- `client/src/components/dashboard/residualSeries.ts` — pure pairing of actual/forecast into signed residuals, gap-preserving
- `client/src/components/dashboard/residualSeries.test.ts`
- `client/src/views/CountryDocumentView.tsx`

**Client — modify**
- `client/src/types/index.ts` — mirror `wape` on the client's accuracy metrics type
- `client/src/App.tsx` — route the flag to `CountryDocumentView`
- `client/src/components/dashboard/generationSeries.ts` — palette swap (Task 10)
- `client/src/store/migrate.ts` — tab→anchor migration (Task 9)

---

### Task 1: WAPE on the comparison summary

**Files:**
- Create: `server/src/services/wapeFromAccuracyPoints.ts`
- Create: `server/src/services/wapeFromAccuracyPoints.test.ts`
- Modify: `server/src/services/forecastComparisonService.ts`
- Test: `server/src/routes/forecastComparison.test.ts`

**Interfaces:**
- Consumes: `wape(pairs: Array<{actual: number; forecast: number}>): number | null` from `server/src/services/wape.ts:59`; `ForecastAccuracyDataPoint` (`actual_value`, `error`) from `server/src/services/tsoForecastService.ts:35`; `MLForecastAccuracyMetrics.wape` (already exists, `mlForecastService.ts:45`).
- Produces: `AccuracyMetrics.wape: number | null` on every metrics object returned by `/api/forecast-comparison/:cc/summary`.

- [ ] **Step 1: Write the failing test for the adapter**

Create `server/src/services/wapeFromAccuracyPoints.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { wapeFromAccuracyPoints } from './wapeFromAccuracyPoints.js';

describe('wapeFromAccuracyPoints', () => {
  it('reconstructs forecast as actual - error and reduces through wape()', () => {
    // error is actual - forecast, so forecast = 90 and 110 respectively.
    // WAPE = 100 * (|10| + |-10|) / (100 + 100) = 10
    expect(wapeFromAccuracyPoints([
      { actual_value: 100, error: 10 },
      { actual_value: 100, error: -10 },
    ])).toBe(10);
  });

  it('weights by magnitude, so a big actual dominates a small one', () => {
    // 100 * (5 + 5) / (1000 + 10) = 0.99
    expect(wapeFromAccuracyPoints([
      { actual_value: 1000, error: 5 },
      { actual_value: 10, error: 5 },
    ])).toBe(0.99);
  });

  it('returns null when the actuals sum to zero rather than dividing by it', () => {
    expect(wapeFromAccuracyPoints([{ actual_value: 0, error: 5 }])).toBeNull();
  });

  it('returns null on an empty window', () => {
    expect(wapeFromAccuracyPoints([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server && npx vitest run src/services/wapeFromAccuracyPoints.test.ts`
Expected: FAIL — cannot resolve `./wapeFromAccuracyPoints.js`.

- [ ] **Step 3: Write the adapter**

Create `server/src/services/wapeFromAccuracyPoints.ts`:

```typescript
import { wape } from './wape.js';

/**
 * WAPE over the accuracy-point shape the TSO services return.
 *
 * This is NOT a second WAPE definition — `services/wape.ts` stays the only
 * one, and this reduces through it. What lives here is the reconstruction:
 * `ForecastAccuracyDataPoint` carries `error = actual - forecast` rather than
 * the forecast itself, so `forecast = actual_value - error`. That inversion is
 * easy to get backwards and was worth writing down once, with a test, instead
 * of inline at each of the two call sites.
 */
export function wapeFromAccuracyPoints(
  points: Array<{ actual_value: number; error: number }>
): number | null {
  return wape(points.map((d) => ({
    actual: d.actual_value,
    forecast: d.actual_value - d.error,
  })));
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd server && npx vitest run src/services/wapeFromAccuracyPoints.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add `wape` to the `AccuracyMetrics` interface**

In `server/src/services/forecastComparisonService.ts`, add the field after `mape` (around `:28`):

```typescript
  mape: number | null; // Mean Absolute Percentage Error (%) — null when no point had a measurable (positive) actual
  /**
   * Weighted Absolute Percentage Error — `100 * sum|actual - forecast| / sum|actual|`.
   * The ranking measure (ABL-388): MAPE divides each point by its own actual,
   * so a series that goes to zero nightly is unbounded — measured BE solar at
   * 58,186% MAPE against 62.37% WAPE. Null on a divergent basis and when the
   * window's actuals sum to zero.
   */
  wape: number | null;
```

Add the import at the top of the file:

```typescript
import { wapeFromAccuracyPoints } from './wapeFromAccuracyPoints.js';
```

TypeScript will now fail to compile at the three return sites — that is the guide rail for Step 6.

- [ ] **Step 6: Populate `wape` at all three assembly points**

In `addBiasToTSOMetrics` (`:241`), the divergent-basis early return gains `wape: null`:

```typescript
  if (metrics.basis === 'divergent_basis') {
    return { mae: null, mape: null, wape: null, rmse: null, bias: null, dataPoints: metrics.dataPoints };
  }
```

and the normal return gains the computed value — `data` is already fetched for bias, so this adds no query:

```typescript
  return {
    mae: metrics.mae ?? 0,
    mape: metrics.mape,
    wape: wapeFromAccuracyPoints(data),
    rmse: metrics.rmse ?? 0,
    bias: Math.round(bias * 100) / 100,
    dataPoints: metrics.dataPoints,
  };
```

In `addBiasToGenerationMetrics` (`:284`), the same one-line addition to its return, again reusing its already-fetched `data`:

```typescript
  return {
    mae: metrics.mae ?? 0,
    mape: metrics.mape,
    wape: wapeFromAccuracyPoints(data),
    rmse: metrics.rmse ?? 0,
    bias: Math.round(bias * 100) / 100,
    dataPoints: metrics.dataPoints,
  };
```

In `addBiasToMetrics` (`:316`) it is a pass-through — `MLForecastAccuracyMetrics` has carried `wape` since ABL-388:

```typescript
  return {
    mae: metrics.mae ?? 0,
    mape: metrics.mape,
    wape: metrics.wape,
    rmse: metrics.rmse ?? 0,
    bias: metrics.bias ?? 0,
    dataPoints: metrics.dataPoints,
  };
```

- [ ] **Step 7: Typecheck**

Run: `cd server && node ../node_modules/typescript/bin/tsc --noEmit`
Expected: clean. Any remaining error is a fourth construction site of `AccuracyMetrics` this plan did not know about — add `wape` there too, following whichever of the three patterns above matches its data.

- [ ] **Step 8: Add the route-level assertion**

Append to `server/src/routes/forecastComparison.test.ts`, inside its existing top-level `describe`:

```typescript
  it('reports wape beside mape on every summary entry that has metrics', async () => {
    const res = await request(app).get(`/api/forecast-comparison/BE/summary?${WINDOW_QS}`);
    expect(res.status).toBe(200);

    const entries = Object.values(res.body.data) as Array<{
      tso: Record<string, { wape: number | null; dataPoints: number } | undefined>;
    }>;
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      for (const metrics of Object.values(entry.tso)) {
        if (!metrics) continue;
        // The field must be PRESENT on every metrics object. Its value may be
        // null (no magnitude, or withheld) — absence is the bug, null is not.
        expect(metrics).toHaveProperty('wape');
      }
    }
  });
```

- [ ] **Step 9: Run the server suite**

Run: `cd server && npx vitest run`
Expected: PASS. Re-measure the file/test count and note it — do not trust a stale baseline.

- [ ] **Step 10: Commit**

```bash
git add server/src/services/wapeFromAccuracyPoints.ts \
        server/src/services/wapeFromAccuracyPoints.test.ts \
        server/src/services/forecastComparisonService.ts \
        server/src/routes/forecastComparison.test.ts
git commit -m "feat: report WAPE beside MAPE on the forecast-comparison summary"
```

---

### Task 2: The three-state badge derivation

**Files:**
- Create: `client/src/components/dashboard/accuracyBadgeState.ts`
- Create: `client/src/components/dashboard/accuracyBadgeState.test.ts`
- Modify: `client/src/types/index.ts`

**Interfaces:**
- Consumes: the summary payload from Task 1.
- Produces: `accuracyBadgeState(metrics, minPoints?): AccuracyBadgeState` and the `AccuracyBadgeState` union, used by Tasks 3 and 6.

This is the highest-value test in the plan. Conflating "withheld" with "not measurable" is the defect the spec exists to prevent, and it is invisible in Belgium — the reference country has no divergent-basis problem.

- [ ] **Step 1: Write the failing test**

Create `client/src/components/dashboard/accuracyBadgeState.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { accuracyBadgeState } from './accuracyBadgeState';

const base = { wape: 3.42, mae: 210, dataPoints: 2976 };

describe('accuracyBadgeState', () => {
  it('reports a measured value when there is a WAPE and enough points', () => {
    expect(accuracyBadgeState(base)).toEqual({
      kind: 'measured', wape: 3.42, dataPoints: 2976,
    });
  });

  it('is absent when the forecast type is not in the payload at all', () => {
    expect(accuracyBadgeState(undefined)).toEqual({ kind: 'absent' });
  });

  it('is not measurable when no points were paired', () => {
    expect(accuracyBadgeState({ wape: null, mae: null, dataPoints: 0 }))
      .toEqual({ kind: 'not_measurable', reason: 'no_data' });
  });

  it('is WITHHELD, not not-measurable, when points paired but no error is publishable', () => {
    // ABL-277: a divergent basis (NL) pairs points and returns null measures.
    // dataPoints > 0 with a null mae is the signature. Reporting this as
    // "not measurable" would tell an analyst the data was thin, when the
    // comparison is invalid by definition.
    expect(accuracyBadgeState({ wape: null, mae: null, dataPoints: 720 }))
      .toEqual({ kind: 'withheld' });
  });

  it('is not measurable when points paired and mae exists but actuals summed to zero', () => {
    expect(accuracyBadgeState({ wape: null, mae: 0, dataPoints: 720 }))
      .toEqual({ kind: 'not_measurable', reason: 'no_magnitude' });
  });

  it('refuses to publish a number over too few points', () => {
    expect(accuracyBadgeState({ wape: 3.42, mae: 210, dataPoints: 4 }))
      .toEqual({ kind: 'not_measurable', reason: 'no_data' });
  });

  it('honours a caller-supplied minimum', () => {
    expect(accuracyBadgeState({ wape: 3.42, mae: 210, dataPoints: 4 }, 4))
      .toEqual({ kind: 'measured', wape: 3.42, dataPoints: 4 });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && npx vitest run src/components/dashboard/accuracyBadgeState.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the derivation**

Create `client/src/components/dashboard/accuracyBadgeState.ts`:

```typescript
/**
 * What an accuracy badge is entitled to claim for one forecast type.
 *
 * Four outcomes, and collapsing any two of them is a defect:
 *
 * - `measured`      — a WAPE with a denominator worth quoting.
 * - `not_measurable` — the window holds no usable comparison.
 * - `withheld`      — a comparison exists but is invalid by definition
 *                     (divergent basis, NL). NOT a degraded `not_measurable`.
 * - `absent`        — the payload has no entry for this forecast type at all,
 *                     e.g. net position, which nobody forecasts.
 */
export type AccuracyBadgeState =
  | { kind: 'measured'; wape: number; dataPoints: number }
  | { kind: 'not_measurable'; reason: 'no_data' | 'no_magnitude' }
  | { kind: 'withheld' }
  | { kind: 'absent' };

export interface AccuracyBadgeInput {
  wape: number | null;
  mae: number | null;
  dataPoints: number;
}

/**
 * `minPoints` guards against quoting a percentage off a handful of intervals.
 * 24 is one day of hourly data — below that the figure is noise wearing a
 * decimal point. `CountryRanking` already draws this distinction for the
 * portfolio view; this is the same rule per figure.
 */
export function accuracyBadgeState(
  metrics: AccuracyBadgeInput | undefined,
  minPoints = 24
): AccuracyBadgeState {
  if (!metrics) return { kind: 'absent' };

  if (metrics.dataPoints === 0) {
    return { kind: 'not_measurable', reason: 'no_data' };
  }

  // Points were paired but no error measure came back. That is withholding —
  // the server nulls every measure on a divergent basis (ABL-277) precisely so
  // this case is distinguishable from thin data. Order matters: this must be
  // checked before the wape null-check below, which would otherwise swallow it.
  if (metrics.mae === null) {
    return { kind: 'withheld' };
  }

  if (metrics.wape === null) {
    return { kind: 'not_measurable', reason: 'no_magnitude' };
  }

  if (metrics.dataPoints < minPoints) {
    return { kind: 'not_measurable', reason: 'no_data' };
  }

  return { kind: 'measured', wape: metrics.wape, dataPoints: metrics.dataPoints };
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd client && npx vitest run src/components/dashboard/accuracyBadgeState.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Mirror `wape` on the client type**

In `client/src/types/index.ts`, find the accuracy-metrics interface used by `ForecastComparisonSummary` and add the field beside `mape`:

```typescript
  wape: number | null;
```

Note the client and server type declarations are deliberately not mirror images elsewhere in this codebase — check which side you are on before editing. This field must exist on both.

- [ ] **Step 6: Typecheck**

Run: `cd client && node ../node_modules/typescript/bin/tsc -b`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/dashboard/accuracyBadgeState.ts \
        client/src/components/dashboard/accuracyBadgeState.test.ts \
        client/src/types/index.ts
git commit -m "feat: derive the three accuracy-badge states, distinguishing withheld from unmeasurable"
```

---

### Task 3: `<AccuracyBadge>`

**Files:**
- Create: `client/src/components/dashboard/AccuracyBadge.tsx`
- Create: `client/src/components/dashboard/AccuracyBadge.test.tsx`

**Interfaces:**
- Consumes: `accuracyBadgeState`, `AccuracyBadgeState` from Task 2.
- Produces: `<AccuracyBadge metrics={...} window="30 days" minPoints={24} />`, used by Tasks 4 and 6.

- [ ] **Step 1: Write the failing test**

Create `client/src/components/dashboard/AccuracyBadge.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AccuracyBadge } from './AccuracyBadge';

describe('AccuracyBadge', () => {
  it('quotes the WAPE with its denominator', () => {
    render(<AccuracyBadge metrics={{ wape: 3.42, mae: 210, dataPoints: 2976 }} window="30 days" />);
    expect(screen.queryByText(/3\.42%/)).not.toBeNull();
    expect(screen.queryByText(/2,976/)).not.toBeNull();
  });

  it('says the comparison is withheld, and does not say "not measurable"', () => {
    render(<AccuracyBadge metrics={{ wape: null, mae: null, dataPoints: 720 }} window="30 days" />);
    expect(screen.queryByText(/withheld/i)).not.toBeNull();
    expect(screen.queryByText(/not measurable/i)).toBeNull();
  });

  it('says not measurable when the window holds no usable comparison', () => {
    render(<AccuracyBadge metrics={{ wape: null, mae: null, dataPoints: 0 }} window="30 days" />);
    expect(screen.queryByText(/not measurable/i)).not.toBeNull();
  });

  it('renders nothing at all when no forecast exists for this series', () => {
    const { container } = render(<AccuracyBadge metrics={undefined} window="30 days" />);
    expect(container.innerHTML).toBe('');
  });

  it('never renders a bare percentage without a denominator', () => {
    render(<AccuracyBadge metrics={{ wape: 3.42, mae: 210, dataPoints: 4 }} window="30 days" />);
    expect(screen.queryByText(/3\.42%/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && npx vitest run src/components/dashboard/AccuracyBadge.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

Create `client/src/components/dashboard/AccuracyBadge.tsx`:

```typescript
import { accuracyBadgeState, type AccuracyBadgeInput } from './accuracyBadgeState';

interface Props {
  metrics: AccuracyBadgeInput | undefined;
  /** Human phrasing of the measurement window, e.g. "30 days". */
  window: string;
  minPoints?: number;
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/**
 * The accuracy claim attached to one figure.
 *
 * `absent` renders nothing: a figure nobody forecasts (net position) says so in
 * its prose footnote, and a badge reading "no data" there would imply a
 * forecast was expected and missing.
 */
export function AccuracyBadge({ metrics, window, minPoints }: Props) {
  const state = accuracyBadgeState(metrics, minPoints);

  if (state.kind === 'absent') return null;

  if (state.kind === 'measured') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-sm border border-accent
                       bg-accent px-2 py-0.5 text-micro font-medium text-primary">
        <CheckIcon />
        WAPE {state.wape.toFixed(2)}% over {window}
        <span className="font-normal text-ink-muted">
          ({state.dataPoints.toLocaleString()} points)
        </span>
      </span>
    );
  }

  if (state.kind === 'withheld') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-sm border border-border
                       bg-secondary px-2 py-0.5 text-micro text-ink-dim">
        Error measures withheld — forecast and actuals are published on
        different bases, so their difference is definitional, not forecast error
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-sm border border-border
                     bg-secondary px-2 py-0.5 text-micro text-ink-muted">
      Not measurable in this window
    </span>
  );
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd client && npx vitest run src/components/dashboard/AccuracyBadge.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/dashboard/AccuracyBadge.tsx \
        client/src/components/dashboard/AccuracyBadge.test.tsx
git commit -m "feat: add AccuracyBadge with distinct withheld and unmeasurable states"
```

---

### Task 4: The `<Figure>` primitive

**Files:**
- Create: `client/src/components/dashboard/Figure.tsx`
- Create: `client/src/components/dashboard/Figure.test.tsx`

**Interfaces:**
- Consumes: `<AccuracyBadge>` from Task 3.
- Produces: `<Figure number title caption footnote anchorId>{plot}</Figure>`, used by Task 6 onward.

- [ ] **Step 1: Write the failing test**

Create `client/src/components/dashboard/Figure.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Figure } from './Figure';

describe('Figure', () => {
  it('numbers the figure and renders its title, caption and plot', () => {
    render(
      <Figure number={1} anchorId="load" title="Electricity demand" caption="What it shows.">
        <div data-testid="plot" />
      </Figure>
    );
    expect(screen.queryByText('Figure 1')).not.toBeNull();
    expect(screen.queryByText('Electricity demand')).not.toBeNull();
    expect(screen.queryByText('What it shows.')).not.toBeNull();
    expect(screen.queryByTestId('plot')).not.toBeNull();
  });

  it('exposes an anchor id so a caller can be scrolled to this figure', () => {
    const { container } = render(
      <Figure number={2} anchorId="price" title="Price" caption="c"><div /></Figure>
    );
    expect(container.querySelector('#figure-price')).not.toBeNull();
  });

  it('renders as a semantic figure with its caption in a figcaption', () => {
    render(
      <Figure number={3} anchorId="mix" title="Mix" caption="c" footnote={<span>Nuclear absent</span>}>
        <div />
      </Figure>
    );
    const fig = screen.getByRole('figure');
    expect(fig).not.toBeNull();
    expect(screen.queryByText('Nuclear absent')).not.toBeNull();
  });

  it('omits the footnote row entirely when there is no footnote', () => {
    const { container } = render(
      <Figure number={4} anchorId="wind" title="Wind" caption="c"><div /></Figure>
    );
    expect(container.querySelector('figcaption')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && npx vitest run src/components/dashboard/Figure.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

Create `client/src/components/dashboard/Figure.tsx`:

```typescript
import type { ReactNode } from 'react';

interface Props {
  /** Figures are cited by number in captions and in cross-links. */
  number: number;
  /** Stable id for scroll-to-figure. Rendered as `figure-<anchorId>`. */
  anchorId: string;
  title: string;
  caption: string;
  /** Provenance, accuracy badge, stated absences. Omitted entirely if absent. */
  footnote?: ReactNode;
  children: ReactNode;
}

/**
 * One figure in the country document: number, title, caption, plot, footnote.
 *
 * The caption says what the figure shows and why it is here — it is not a
 * restatement of the title. The footnote is where a claim about the data goes,
 * including the claim that something is missing.
 */
export function Figure({ number, anchorId, title, caption, footnote, children }: Props) {
  return (
    <figure
      id={`figure-${anchorId}`}
      className="m-0 flex scroll-mt-20 flex-col gap-3.5 border-t border-border pb-7 pt-6"
    >
      <div className="flex flex-col gap-1">
        <div className="text-label uppercase text-ink-muted">Figure {number}</div>
        <h2 className="m-0 text-title font-semibold tracking-[-0.01em] text-foreground">
          {title}
        </h2>
        <p className="m-0 max-w-[74ch] text-body text-ink-dim [text-wrap:pretty]">
          {caption}
        </p>
      </div>
      {children}
      {footnote ? (
        <figcaption className="flex flex-wrap items-baseline gap-2.5 text-meta text-ink-muted">
          {footnote}
        </figcaption>
      ) : null}
    </figure>
  );
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd client && npx vitest run src/components/dashboard/Figure.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/dashboard/Figure.tsx \
        client/src/components/dashboard/Figure.test.tsx
git commit -m "feat: add the Figure primitive for the country document"
```

---

### Task 5: Residual series and `<AbleResidualStrip>`

**Files:**
- Create: `client/src/components/dashboard/residualSeries.ts`
- Create: `client/src/components/dashboard/residualSeries.test.ts`
- Create: `client/src/components/charts/AbleResidualStrip.tsx`
- Create: `client/src/components/charts/AbleResidualStrip.test.tsx`

**Interfaces:**
- Produces: `buildResidualSeries(actual, forecast): ResidualPoint[]` and `<AbleResidualStrip points={...} />`, used by Task 6.

The pairing is where gaps get silently invented, so it is pure and tested separately from the drawing.

- [ ] **Step 1: Write the failing test for the pairing**

Create `client/src/components/dashboard/residualSeries.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildResidualSeries } from './residualSeries';

describe('buildResidualSeries', () => {
  it('pairs on timestamp and signs the residual as actual - forecast', () => {
    expect(buildResidualSeries(
      [{ t: '2026-08-28T00:00', v: 100 }, { t: '2026-08-28T01:00', v: 90 }],
      [{ t: '2026-08-28T00:00', v: 90 },  { t: '2026-08-28T01:00', v: 100 }],
    )).toEqual([
      { t: '2026-08-28T00:00', residual: 10 },
      { t: '2026-08-28T01:00', residual: -10 },
    ]);
  });

  it('drops an interval where the actual is missing rather than treating it as zero', () => {
    expect(buildResidualSeries(
      [{ t: 'a', v: null }, { t: 'b', v: 90 }],
      [{ t: 'a', v: 90 },   { t: 'b', v: 80 }],
    )).toEqual([{ t: 'b', residual: 10 }]);
  });

  it('drops an interval where the forecast is missing', () => {
    expect(buildResidualSeries(
      [{ t: 'a', v: 100 }],
      [{ t: 'a', v: null }],
    )).toEqual([]);
  });

  it('drops an interval the forecast does not cover at all', () => {
    expect(buildResidualSeries(
      [{ t: 'a', v: 100 }, { t: 'b', v: 100 }],
      [{ t: 'a', v: 90 }],
    )).toEqual([{ t: 'a', residual: 10 }]);
  });

  it('returns an empty series rather than throwing when nothing overlaps', () => {
    expect(buildResidualSeries([{ t: 'a', v: 1 }], [{ t: 'z', v: 1 }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && npx vitest run src/components/dashboard/residualSeries.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the pairing**

Create `client/src/components/dashboard/residualSeries.ts`:

```typescript
export interface SeriesPoint { t: string; v: number | null }
export interface ResidualPoint { t: string; residual: number }

/**
 * Signed residual (actual − forecast) per interval, paired on timestamp.
 *
 * An interval missing either side is DROPPED, never zeroed. A zero residual
 * means "the forecast was exactly right"; an absent one means "we cannot say".
 * Collapsing the second into the first draws a confident flat line through
 * every gap in the feed — which is the specific lie this whole design is
 * organised against.
 */
export function buildResidualSeries(
  actual: SeriesPoint[],
  forecast: SeriesPoint[]
): ResidualPoint[] {
  const forecastByT = new Map<string, number>();
  for (const p of forecast) {
    if (p.v !== null && Number.isFinite(p.v)) forecastByT.set(p.t, p.v);
  }

  const out: ResidualPoint[] = [];
  for (const p of actual) {
    if (p.v === null || !Number.isFinite(p.v)) continue;
    const f = forecastByT.get(p.t);
    if (f === undefined) continue;
    out.push({ t: p.t, residual: p.v - f });
  }
  return out;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd client && npx vitest run src/components/dashboard/residualSeries.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing test for the strip**

Create `client/src/components/charts/AbleResidualStrip.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AbleResidualStrip } from './AbleResidualStrip';

describe('AbleResidualStrip', () => {
  it('draws one bar per residual point', () => {
    const { container } = render(
      <AbleResidualStrip points={[
        { t: 'a', residual: 10 }, { t: 'b', residual: -5 }, { t: 'c', residual: 2 },
      ]} />
    );
    expect(container.querySelectorAll('rect[data-residual]')).toHaveLength(3);
  });

  it('signs the bars, so over- and under-forecast are distinguishable', () => {
    const { container } = render(
      <AbleResidualStrip points={[{ t: 'a', residual: 10 }, { t: 'b', residual: -5 }]} />
    );
    const bars = Array.from(container.querySelectorAll('rect[data-residual]'));
    expect(bars.map((b) => b.getAttribute('data-sign'))).toEqual(['over', 'under']);
  });

  it('renders nothing when there is nothing to show', () => {
    const { container } = render(<AbleResidualStrip points={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('states the peak magnitude so the strip has a scale', () => {
    render(<AbleResidualStrip points={[{ t: 'a', residual: 1234 }]} />);
    expect(screen.queryByText(/1,234/)).not.toBeNull();
  });
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `cd client && npx vitest run src/components/charts/AbleResidualStrip.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 7: Write the strip**

Create `client/src/components/charts/AbleResidualStrip.tsx`:

```typescript
import type { ResidualPoint } from '@/components/dashboard/residualSeries';

interface Props {
  points: ResidualPoint[];
  height?: number;
  unit?: string;
}

/**
 * A short signed axis beneath a figure: actual − forecast per interval.
 *
 * Hand-drawn SVG rather than Recharts. It shares the parent plot's x-domain by
 * construction (one bar per point, evenly spaced) and has no axes, tooltip or
 * legend of its own — it is an annotation on the figure above it, not a chart.
 * Reaching for Recharts here would buy machinery this does not use.
 */
export function AbleResidualStrip({ points, height = 46, unit = 'MW' }: Props) {
  if (points.length === 0) return null;

  const peak = Math.max(...points.map((p) => Math.abs(p.residual)));
  const zero = height / 2;
  const half = height / 2;
  const step = 100 / points.length;

  return (
    <div className="flex items-center gap-3">
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Forecast residual per interval, peak ${Math.round(peak)} ${unit}`}
      >
        {points.map((p, i) => {
          const h = peak === 0 ? 0 : (half * Math.abs(p.residual)) / peak;
          const over = p.residual > 0;
          return (
            <rect
              key={p.t}
              data-residual={p.residual}
              data-sign={over ? 'over' : 'under'}
              x={i * step}
              y={over ? zero - h : zero}
              width={step * 0.8}
              height={Math.max(h, 0.4)}
              className={over ? 'fill-up' : 'fill-down'}
              opacity={0.8}
            />
          );
        })}
        <line x1="0" y1={zero} x2="100" y2={zero} className="stroke-border" strokeWidth="0.4" />
      </svg>
      <span className="whitespace-nowrap font-mono-num text-micro text-ink-muted">
        ±{Math.round(peak).toLocaleString()} {unit}
      </span>
    </div>
  );
}
```

- [ ] **Step 8: Run it and confirm it passes**

Run: `cd client && npx vitest run src/components/charts/AbleResidualStrip.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 9: Commit**

```bash
git add client/src/components/dashboard/residualSeries.ts \
        client/src/components/dashboard/residualSeries.test.ts \
        client/src/components/charts/AbleResidualStrip.tsx \
        client/src/components/charts/AbleResidualStrip.test.tsx
git commit -m "feat: add gap-preserving residual pairing and the residual strip"
```

---

### Task 6: Figure 1 end-to-end — THE GATE

**Files:**
- Create: `client/src/views/CountryDocumentView.tsx`
- Modify: `client/src/App.tsx`

**Interfaces:**
- Consumes: `<Figure>` (Task 4), `<AccuracyBadge>` (Task 3), `buildResidualSeries` + `<AbleResidualStrip>` (Task 5), the existing load hook and `AbleLineChart`.
- Produces: `useTrailingAccuracySummary(days?)` in `client/src/hooks/useDashboardData.ts`.

**Do not use the existing `useForecastComparisonSummary()`** (`useDashboardData.ts:297`).
It derives `start`/`end` from `timePreset`/`timeOffset`, so it follows the page's
time control — on a 24h view it would compute a WAPE over 24 hours while the badge
says "over 30 days". A figure's accuracy claim is about the forecast's recent track
record, not about the day on screen; those are different windows and must stay
different queries.
- Produces: a reachable `CountryDocumentView` with exactly one figure.

The spec's stop condition: **if figure 1 does not hold up at real density, stop.** Build only this figure, measure, then decide.

- [ ] **Step 1: Add the flag route**

In `client/src/App.tsx`, alongside the existing `/ops-status` pathname branch in `AppContent`, add — the same off-nav pattern, so nothing on the main surface changes while this is being proven:

```typescript
  // The scrolling-document country view, reachable only by adding ?document=1.
  // Deliberately outside the persisted store and AbleHeader's nav until it has
  // cleared the paint-time gate against the tab view it would replace.
  if (window.location.search.includes('document=1')) {
    return (
      <div className="flex h-screen w-full flex-col bg-background text-foreground">
        <AbleHeader />
        <main className="flex flex-1 flex-col overflow-hidden">
          <Suspense fallback={<ViewSkeleton />}>
            <CountryDocumentView />
          </Suspense>
        </main>
      </div>
    );
  }
```

with the lazy import beside the others at the top of the file:

```typescript
const CountryDocumentView = lazy(() => import('@/views/CountryDocumentView').then(m => ({ default: m.CountryDocumentView })));
```

- [ ] **Step 2: Add the fixed-window accuracy hook**

Append to `client/src/hooks/useDashboardData.ts`:

```typescript
/**
 * Forecast accuracy over a FIXED trailing window, independent of the page's
 * time control.
 *
 * `useForecastComparisonSummary` above follows `timePreset`/`timeOffset`, which
 * is right for the comparison view — you ask it about the window you are
 * looking at. It is wrong for a figure badge: a badge reading "WAPE over 30
 * days" while the page shows 24 hours is a false claim, and one computed over
 * 24 hours is noise besides. The badge wants the track record.
 */
export function useTrailingAccuracySummary(days = 30) {
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);

  // Floor to the UTC day. `new Date()` in the query key would mint a fresh key
  // on every render and refetch forever against an API that serialises.
  const today = new Date().toISOString().slice(0, 10);

  return useQuery({
    queryKey: ['forecast-comparison', 'trailing', selectedCountry, days, today],
    queryFn: () => {
      const end = new Date(`${today}T00:00:00Z`);
      const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
      return fetchForecastComparisonSummary({
        countryCode: selectedCountry,
        start: start.toISOString(),
        end: end.toISOString(),
      });
    },
    staleTime: REFRESH_INTERVALS.map,
  });
}
```

- [ ] **Step 3: Write the view with figure 1 only**

Create `client/src/views/CountryDocumentView.tsx`:

```typescript
import { useDashboardStore } from '@/store/dashboardStore';
import { useCountries } from '@/hooks/useCountries';
import { useTrailingAccuracySummary } from '@/hooks/useDashboardData';
import { Figure } from '@/components/dashboard/Figure';
import { AccuracyBadge } from '@/components/dashboard/AccuracyBadge';
import { AbleResidualStrip } from '@/components/charts/AbleResidualStrip';
import { buildResidualSeries } from '@/components/dashboard/residualSeries';
import { LoadTab } from '@/components/dashboard/LoadTab';

/**
 * The country page as a scrolling annotated document.
 *
 * Figure 1 only, for now. This exists to answer one question before the rest is
 * built: does a captioned figure carrying its own accuracy claim hold up
 * against real quarter-hourly data at laptop width, on an API that serialises
 * requests? See docs/superpowers/specs/2026-08-29-country-page-scrolling-document-design.md.
 */
export function CountryDocumentView() {
  const { selectedCountry } = useDashboardStore();
  const { data: countries } = useCountries();
  // 30 days fixed — see useTrailingAccuracySummary. The badge's window label
  // below must match this number; they are one claim in two places.
  const { data: accuracy } = useTrailingAccuracySummary(30);

  const country = countries?.find((c) => c.country_code === selectedCountry);
  const loadMetrics = accuracy?.load?.tso?.dayAhead;

  return (
    <div className="flex-1 overflow-auto bg-background">
      <div className="mx-auto max-w-[1200px] px-5 pb-14 pt-6 md:px-8">
        <h1 className="m-0 mb-2 text-display font-medium">
          {country?.country_name ?? selectedCountry}
        </h1>
        <p className="mb-6 max-w-[76ch] text-body text-ink-dim [text-wrap:pretty]">
          Load, price, generation and cross-border position — each shown against
          the forecast that was published before the fact.
        </p>

        <Figure
          number={1}
          anchorId="load"
          title="Electricity demand against its day-ahead forecast"
          caption="System load in quarter-hourly resolution, drawn against the day-ahead
                   forecast published the previous morning. The separation between the two
                   lines is the subject of this page."
          footnote={
            <>
              <AccuracyBadge metrics={loadMetrics} window="30 days" />
              <span>
                Forecast is the TSO&rsquo;s own day-ahead publication, not an able model.
              </span>
            </>
          }
        >
          <LoadTab />
        </Figure>
      </div>
    </div>
  );
}
```

Wiring `<AbleResidualStrip>` and `buildResidualSeries` into `LoadTab`'s series is Step 4 — get the figure rendering first.

- [ ] **Step 4: See it in the browser**

Run: `npm run dev` from the repo root. Open `http://localhost:5173/?document=1` after selecting Belgium from the map.
Expected: header, title, one figure, an accuracy badge quoting a WAPE with its point count.

- [ ] **Step 5: Add the residual strip beneath the load plot**

Inside `<Figure>`, below `<LoadTab />`, pass the load actual and day-ahead series through `buildResidualSeries` and render the strip. Read `LoadTab.tsx` for the exact names its hook returns, and map them to `SeriesPoint` (`{ t, v }`) at the call site rather than changing the hook.

- [ ] **Step 6: Measure the gate**

With the dev server running, in Chrome DevTools → Performance, record a reload of `/?document=1` and of the tab view for the same country, three runs each. Record both medians for first contentful paint.

Write the two numbers into the spec's "Performance" section, replacing nothing else.

- [ ] **Step 7: Run both suites**

```bash
cd client && npx vitest run && node ../node_modules/typescript/bin/tsc -b
cd ../server && npx vitest run
```
Expected: PASS. Re-measure counts; do not trust a stale baseline.

- [ ] **Step 8: Commit**

```bash
git add client/src/views/CountryDocumentView.tsx client/src/App.tsx \n        client/src/hooks/useDashboardData.ts
git commit -m "feat: country document view behind ?document=1, figure 1 only"
```

- [ ] **Step 9: STOP and report**

Report the two paint medians and a screenshot at 1440px and at 1024px. **Do not start Task 7.** The spec's gate: first meaningful paint must not regress against the tab view. If it has, the design is wrong, not the budget — return to the spec rather than optimising past it.

---

## Gated on Task 6 — do not begin without an explicit go-ahead

### Task 7: Figures 2–5

Repeat Task 6's `<Figure>` pattern for price, generation mix, wind and net position, reusing `PriceTab`, `GenerationTab`, `WindOnshoreTab` + `WindOffshoreTab`, and `NetPositionTab` as the plot slots. Per the spec: figures 2 and 4 additionally carry `<AbleResidualStrip>`; figure 3's badge reports `accuracy?.solar?.tso?.dayAhead` and its label must say **solar component only**; figure 5 passes `metrics={undefined}` so `<AccuracyBadge>` renders nothing, and its footnote states in prose that no forecast is published for net position.

Figure 3's footnote must name the gaps found in the data — unpublished hours are hatched and stated, never interpolated. Add a test asserting that a generation series containing interior nulls produces a hatched span and no interpolated segment.

### Task 8: Intersection mounting

Wrap each figure body in an `IntersectionObserver` gate so only figure 1 fetches eagerly; render skeletons at each figure's final height so mounting does not shift scroll. Keep `staleTime` and the one-retry cap in `App.tsx` exactly as they are — the API is single-threaded and a fan-out of five is the failure mode. Re-measure the gate from Task 6 Step 6 afterwards.

### Task 9: Delete the tab row and migrate

Remove `TabsList`/`TabsContent` from `CountryDashboardView`, delete `ForecastTab` and the `analytics` banner (`CountryDashboardView.tsx:142`), drop `activeChartTab` from the store, and point `goToCountry(code, 'analytics')` callers at `#figure-<anchor>`. Add a `migratePersisted()` clause mapping every historic tab value to its figure anchor and bump `PERSIST_VERSION`. Note `VALID_CHART_TABS` (`store/migrate.ts:42`) currently omits `wind-onshore`/`wind-offshore` despite both being live triggers — this migration supersedes that bug; write the clause against the real trigger list, not that set.

### Task 10: Palette and direct labelling

Replace `GENERATION_GROUP_COLORS` (`generationSeries.ts:84`) with the validated Okabe-Ito set — solar `#E69F00`, wind `#56B4E9`, gas `#D55E00`, biomass `#009E73`, nuclear `#CC79A7` — keeping `other` as a reserved neutral outside the categorical set. The palette's contrast warning is dischargeable only by visible labels, so remove the legend box and label series at the line end. Re-run the validator before committing:

```bash
node "<dataviz skill>/scripts/validate_palette.js" "#E69F00,#56B4E9,#D55E00,#009E73,#CC79A7" --mode light --pairs all
```
Expected: ALL CHECKS PASS.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: WAPE source → 1; three badge states → 2, 3; figure anatomy → 4; residual strip → 5; performance gate → 6, 8; figures and stated gaps → 7; deletions and migration → 9; visual system and palette → 10. Two spec items are deliberately unimplemented and named as such: URL routing (a non-goal) and dark mode (a non-goal).

**One spec risk has no task, by design.** The spec's last open risk — `getComparisonSummary` swallowing failures at `forecastComparisonService.ts:135`, making an absent badge indistinguishable from a failed one — is not fixed here. Task 2's `absent` state currently means "not in the payload", which covers both. Resolving it needs a decision about whether the summary endpoint should report per-type errors, which is a change to its contract and belongs in its own spec. **Flagged, not silently dropped.**

**Type consistency.** `AccuracyMetrics.wape` (Task 1) → `AccuracyBadgeInput` (Task 2) → `<AccuracyBadge metrics>` (Task 3) carry the same three fields (`wape`, `mae`, `dataPoints`). `SeriesPoint`/`ResidualPoint` (Task 5) are consumed unchanged by `<AbleResidualStrip>` and Task 6. `anchorId` in Task 4 produces `#figure-<anchorId>`, which Task 9 links to.
