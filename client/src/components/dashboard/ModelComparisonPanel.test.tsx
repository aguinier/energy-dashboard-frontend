import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ModelComparisonPanel } from './ModelComparisonPanel';
import type { ForecastModelRegistry } from '@/types';

/**
 * Renders the real panel to HTML. `renderToString` needs no DOM, so this runs
 * in the default node environment with no new dependency.
 *
 * It exists because the numbers are only half the guarantee: the row states
 * this panel must never confuse are ultimately a rendering question. A row that
 * correctly carries `metrics: null` still fails the bar if it draws as a blank
 * cell where a number goes.
 *
 * Every response below was recorded from a LOCAL server against
 * energy_dashboard.db on 2026-08-05, over 2026-07-29T17:00Z..2026-08-05T17:00Z.
 * DE is one half of the disjoint-coverage case this panel exists to get right:
 * catboost serves it and xgboost does not. (FR is the mirror; both halves are
 * asserted on the pure helper in modelComparison.test.ts.)
 *
 * The country is DE rather than a value this test chose, because zustand v5's
 * `useStore` reads `getInitialState()` under `useSyncExternalStore`'s server
 * snapshot — a `setState` here would not be visible to the render. DEFAULT_COUNTRY
 * is 'DE' and the initial window is '7d' at offset 0, which is what the query
 * keys below encode.
 */

const COUNTRY = 'DE';
const PRESET = '7d';
const OFFSET = 0;
const ML_HORIZON = 1;

const REGISTRY: ForecastModelRegistry = {
  load: {
    production: 'catboost',
    models: [
      { id: 'catboost', label: 'able-ml · catboost', source: 'ml', modelName: 'catboost' },
      { id: 'xgboost', label: 'able-ml · xgboost', source: 'ml', modelName: 'xgboost' },
      { id: 'tso-d1', label: 'ENTSO-E TSO · D+1', source: 'tso', tsoHorizon: 'day_ahead' },
      { id: 'tso-d7', label: 'ENTSO-E TSO · D+7', source: 'tso', tsoHorizon: 'week_ahead' },
    ],
  },
};

const DE_RESPONSES: Record<string, unknown> = {
  catboost: {
    metrics: { mae: 4383.39, mape: 9.25, rmse: 5250.16, bias: -576.71, dataPoints: 151, mapeSamples: 151 },
    coverage: 'served',
    model: 'catboost',
  },
  xgboost: {
    metrics: { mae: null, mape: null, rmse: null, bias: null, dataPoints: 0, mapeSamples: 0 },
    coverage: 'no_model_coverage',
    model: 'xgboost',
  },
  'tso-d1': { metrics: { mae: 1941.09, mape: 3.99, rmse: 2396.35, dataPoints: 151, mapeSamples: 151 } },
  'tso-d7': { metrics: { mae: 6417.23, mape: 14.82, rmse: 7354, dataPoints: 7, mapeSamples: 7 } },
};

/** Every registered model returns an empty window. */
const NOTHING_ANYWHERE: Record<string, unknown> = Object.fromEntries(
  ['catboost', 'xgboost', 'tso-d1', 'tso-d7'].map((id) => [
    id,
    {
      metrics: { mae: null, mape: null, rmse: null, dataPoints: 0, mapeSamples: 0 },
      ...(id.startsWith('tso') ? {} : { coverage: 'no_model_coverage' }),
    },
  ]),
);

function render(responses: Record<string, unknown> | null): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['forecast-models'], REGISTRY);
  for (const [id, payload] of Object.entries(responses ?? {})) {
    client.setQueryData(
      ['model-comparison', COUNTRY, 'load', id, PRESET, OFFSET, ML_HORIZON],
      payload,
    );
  }
  return renderToString(
    <QueryClientProvider client={client}>
      <ModelComparisonPanel forecastType="load" />
    </QueryClientProvider>,
  );
}

/** Strip tags so assertions read the text a person actually sees. */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The markup of the one row naming `label`. Rows are the only `py-2.5` grids. */
function rowFor(html: string, label: string): string {
  const chunk = html.split('border-t border-input py-2.5').find((c) => c.includes(label));
  expect(chunk, `no row rendered for ${label}`).toBeDefined();
  return chunk!;
}

describe('ModelComparisonPanel', () => {
  it('names every registered model, including the ones with no data', () => {
    const t = text(render(DE_RESPONSES));
    expect(t).toContain('able-ml · catboost');
    expect(t).toContain('able-ml · xgboost');
    expect(t).toContain('ENTSO-E TSO · D+1');
    expect(t).toContain('ENTSO-E TSO · D+7');
  });

  it("renders the measured models' figures", () => {
    const t = text(render(DE_RESPONSES));
    expect(t).toContain('4383');  // catboost MAE, 4383.39 to 0dp
    expect(t).toContain('9.25');  // catboost MAPE
    expect(t).toContain('151');   // samples
    expect(t).toContain('1941');  // TSO D+1 MAE
  });

  // The bar this panel is judged against.
  it('says "no data" in words for the model that does not serve the country', () => {
    expect(text(render(DE_RESPONSES))).toContain('No data — this model does not forecast DE.');
  });

  it('draws no metric cell of any kind on the no-coverage row', () => {
    const row = rowFor(render(DE_RESPONSES), 'able-ml · xgboost');
    expect(text(row)).toContain('No data');
    // Neither a measured value...
    expect(row).not.toContain('font-mono-num text-meta text-foreground');
    // ...nor the dash that stands for "not measurable" on a row that WAS measured.
    expect(row).not.toContain('Not measurable in this window');
    // ...nor a sample count, which is 0 on this row server-side.
    expect(row).not.toMatch(/>\s*0\s*</);
  });

  it('keeps the measured rows showing real numbers alongside it', () => {
    const row = rowFor(render(DE_RESPONSES), 'able-ml · catboost');
    expect(row).toContain('font-mono-num text-meta text-foreground');
    expect(text(row)).toContain('9.25');
  });

  it('states that a missing figure is not a zero', () => {
    expect(text(render(DE_RESPONSES))).toContain('rather than a zero');
  });

  it('warns that the D+7 row is not comparable to the D+1 rows', () => {
    expect(text(render(DE_RESPONSES))).toContain('only rows sharing a horizon are comparable');
  });

  it('shows every model as measuring, not as zero, before the responses land', () => {
    const t = text(render(null));
    expect(t).toContain('Measuring…');
    expect(t).not.toContain('0.00');
  });

  it('says so plainly when no registered model has data for the country', () => {
    const t = text(render(NOTHING_ANYWHERE));
    expect(t).toContain('None of the registered models has measured accuracy');
    expect(t).not.toContain('0.00');
  });
});
