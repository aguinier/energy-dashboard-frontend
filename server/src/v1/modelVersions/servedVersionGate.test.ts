import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createV1Routes } from '../routes/index.js';
import { publicErrorHandler, publicNotFoundHandler } from '../publicErrors.js';
import {
  createMemoryDataContext,
  createMemoryEnergySource,
  type MemoryEnergySource,
} from '../data/memoryEnergySource.js';
import { readServedVersionLedger } from './servedLedger.js';
import { diffLedger } from './versionGuard.js';
import type { AcknowledgementLedger } from './acknowledgements.js';

/**
 * A retrain of an existing pair, end to end, through a real HTTP response.
 *
 * ABL-529's "done when" is a claim about what a **subscriber** receives, so this
 * file asserts against response bodies rather than against the repo — the same
 * reason `routes/accuracy.test.ts` exists beside `accuracyRepo.test.ts`.
 * `versionGuard.test.ts` proves the rule; this proves the rule is actually in
 * the path.
 *
 * The fleet is the real shape, small:
 *
 * - **DE / load / catboost** — the retrained pair. Artifact `v1` served hours
 *   00–05 from a 07:00 run; artifact `v2` then wrote hours 00–05 again from a
 *   *newer* 19:00 run at visibly different values. Only `v1` is acknowledged.
 *   Without the guard `MAX(generated_at)` picks `v2` and every number moves
 *   under an unchanged `"model": "catboost"` — ToS §9.3.1's material change,
 *   invisible on this surface. That is the defect, and hour-for-hour it is
 *   40,000 becoming 44,000.
 * - **FR / load / xgboost** — a pair the ledger has never heard of. Additive
 *   under §9.1 (ruling A1, and what ABL-525 is), so it must serve unfiltered.
 *   A guard that made this wait would block work the Terms permit at any time.
 */

let source: MemoryEnergySource;
let api: { origin: string; close: () => Promise<void> };

const NOW = new Date('2026-08-22T12:00:00Z');
const OLD_RUN = '2026-08-22T07:00:00.100000';
const NEW_RUN = '2026-08-22T19:00:00.100000';

/** DE/load/catboost v1 only. FR is deliberately absent — that is the A1 case. */
const LEDGER: AcknowledgementLedger = [
  {
    id: 'test-baseline',
    kind: 'baseline',
    acknowledged_at: '2026-08-01T00:00:00Z',
    acknowledged_by: 'test',
    serve_from: '2026-08-01T00:00:00Z',
    note: 'the artifact serving DE load when the ledger was built',
    pairs: [{ zone: 'DE', forecast_type: 'load', model: 'catboost', model_version: 'v1' }],
  },
];

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${api.origin}${path}`);
  return { status: res.status, body: await res.json() };
}

function seed(db: MemoryEnergySource): void {
  db.zones('DE', 'FR');
  const target = (hour: number) => `2026-08-22T${String(hour).padStart(2, '0')}:00:00`;

  for (let hour = 0; hour < 6; hour += 1) {
    db.forecast({
      zone: 'DE',
      type: 'load',
      target: target(hour),
      generatedAt: OLD_RUN,
      horizonHours: hour + 2,
      value: 40_000,
      model: 'catboost',
      modelVersion: 'v1',
    });
    // The retrain: same pair, same label, newer run, different numbers.
    db.forecast({
      zone: 'DE',
      type: 'load',
      target: target(hour),
      generatedAt: NEW_RUN,
      horizonHours: hour + 2,
      value: 44_000,
      model: 'catboost',
      modelVersion: 'v2',
    });
    db.forecast({
      zone: 'FR',
      type: 'load',
      target: target(hour),
      generatedAt: NEW_RUN,
      horizonHours: hour + 2,
      value: 50_000,
      model: 'xgboost',
      modelVersion: 'brand-new',
    });
  }
}

function serve(acknowledgedVersions: AcknowledgementLedger): Promise<void> {
  const app = express();
  app.use('/v1', createV1Routes(createMemoryDataContext(source, { now: () => NOW, acknowledgedVersions })));
  app.use(publicNotFoundHandler);
  app.use(publicErrorHandler);
  return new Promise((resolve) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      api = {
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      };
      resolve();
    });
  });
}

beforeAll(async () => {
  source = createMemoryEnergySource();
  seed(source);
  await serve(LEDGER);
});

afterAll(async () => {
  await api.close();
  source.close();
});

const WINDOW = 'zone=DE&type=load&from=2026-08-22T00:00:00Z&to=2026-08-22T06:00:00Z';

describe('a retrain of an existing pair cannot reach a /v1 response', () => {
  it('serves the acknowledged artifact, not the newer unacknowledged one', async () => {
    const { status, body } = await get(`/v1/forecasts?${WINDOW}`);
    expect(status).toBe(200);
    expect(body.data).toHaveLength(6);
    // The whole issue in one assertion: every value is v1's, and the label a
    // subscriber sees is the same `catboost` it would have been either way.
    expect(new Set(body.data.map((row: any) => row.value))).toEqual(new Set([40_000]));
    expect(new Set(body.data.map((row: any) => row.model))).toEqual(new Set(['catboost']));
  });

  it('does not blank the series — it goes stale, and says so', async () => {
    // ABL-529: "a refusal that blanks a country is worse than the problem".
    // The fallback is the load-bearing half, and `coverage: 'ok'` beside six
    // rows is what proves it is a fallback rather than a refusal.
    const { body } = await get(`/v1/forecasts?${WINDOW}`);
    expect(body.meta.coverage).toBe('ok');
    expect(body.meta.row_count).toBe(6);
  });

  it('dates the response from the served run, not from the withheld one', async () => {
    // The trap `readForecastEdges` closes. `latest_vintage_at` feeds
    // `freshness.status`, so reading it unfiltered would report the withheld
    // 19:00 run over the 07:00 run's numbers — a series claiming to be current
    // while serving something older, which is a sharper false claim than the
    // silent swap the guard exists to stop.
    const { body } = await get(`/v1/forecasts?${WINDOW}`);
    expect(body.meta.latest_vintage_at).toBe('2026-08-22T07:00:00Z');
  });

  it('holds on /forecasts/latest too, where the newest run is the whole answer', async () => {
    const { body } = await get('/v1/forecasts/latest?zone=DE&type=load');
    expect(body.data).toHaveLength(6);
    expect(new Set(body.data.map((row: any) => row.value))).toEqual(new Set([40_000]));
    expect(body.meta.latest_vintage_at).toBe('2026-08-22T07:00:00Z');
  });

  it('holds when the model is pinned explicitly', async () => {
    // An explicit `?model=` bypasses resolution entirely, so it is a second
    // path into the same query and the one a guard is most likely to miss.
    const { body } = await get(`/v1/forecasts?${WINDOW}&model=catboost`);
    expect(new Set(body.data.map((row: any) => row.value))).toEqual(new Set([40_000]));
  });

  it('holds across a page boundary', async () => {
    // Page two is minted from a cursor rather than from the original resolution,
    // so it re-enters `readForecasts` on its own. The guard has to be in the
    // query, not in the request handler.
    const first = await get(`/v1/forecasts?${WINDOW}&limit=2`);
    expect(first.body.data).toHaveLength(2);
    const next = new URL(first.body.links.next, api.origin);
    const { body } = await get(`${next.pathname}${next.search}`);
    expect(body.data.length).toBeGreaterThan(0);
    expect(new Set(body.data.map((row: any) => row.value))).toEqual(new Set([40_000]));
  });

  it('leaves the response shape untouched — no model_version on the wire', async () => {
    // Explicitly out of scope on ABL-529: publishing the artifact identity is
    // additive under §9.1 and arguably good, but it is a contract change and a
    // separate decision. `openapi/drift.test.ts` validates every response with
    // `additionalProperties: false`, so this is also what keeps that green.
    const { body } = await get(`/v1/forecasts?${WINDOW}`);
    expect(Object.keys(body.data[0]).sort()).toEqual([
      'generated_at',
      'horizon_hours',
      'model',
      'timestamp',
      'value',
    ]);
  });
});

describe('a pair the ledger has never heard of', () => {
  it('serves unfiltered — additive under ToS §9.1', async () => {
    // Ruling A1, and the reason the guard is not a tax on ordinary work:
    // ABL-525's eight new country/stream pairs are exactly this shape.
    const { status, body } = await get(
      '/v1/forecasts?zone=FR&type=load&from=2026-08-22T00:00:00Z&to=2026-08-22T06:00:00Z'
    );
    expect(status).toBe(200);
    expect(body.data).toHaveLength(6);
    expect(body.meta.model).toBe('xgboost');
  });
});

describe('the cutover happens on its own', () => {
  it('serves the new artifact once its notice period elapses, with no code change', async () => {
    // The same database and the same ledger, read 31 days later. Nothing is
    // deployed between these two assertions — which is the point of resolving
    // the gate per request rather than at startup.
    await api.close();
    const acknowledged: AcknowledgementLedger = [
      ...LEDGER,
      {
        id: 'test-material',
        kind: 'material',
        acknowledged_at: '2026-08-22T00:00:00Z',
        acknowledged_by: 'test',
        serve_from: '2026-09-21T00:00:00Z',
        note: 'DE load catboost retrained',
        pairs: [{ zone: 'DE', forecast_type: 'load', model: 'catboost', model_version: 'v2' }],
      },
    ];

    const app = express();
    app.use(
      '/v1',
      createV1Routes(
        createMemoryDataContext(source, {
          now: () => new Date('2026-09-22T12:00:00Z'),
          acknowledgedVersions: acknowledged,
        })
      )
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    api = {
      origin: `http://127.0.0.1:${port}`,
      close: () => new Promise((done) => server.close(() => done())),
    };

    const { body } = await get(`/v1/forecasts?${WINDOW}`);
    expect(new Set(body.data.map((row: any) => row.value))).toEqual(new Set([44_000]));
    expect(body.meta.latest_vintage_at).toBe('2026-08-22T19:00:00Z');
  });
});

describe('the detector', () => {
  it('sees the unacknowledged artifact the gate is hiding', () => {
    // The ledger reads unfiltered on purpose. A detector built from the rows the
    // gate already permits could never contain the version it exists to catch,
    // and would report all-clear for as long as the guard kept withholding.
    const diff = diffLedger(readServedVersionLedger(source), LEDGER, NOW);
    expect(diff.unacknowledged).toEqual([
      {
        zone: 'DE',
        forecast_type: 'load',
        model: 'catboost',
        model_version: 'v2',
        newest_vintage_at: NEW_RUN,
      },
    ]);
    expect(diff.additive.map((row) => `${row.zone}/${row.model_version}`)).toEqual(['FR/brand-new']);
    // v1 no longer writes rows: it was superseded, not withdrawn, and its entry
    // is what kept the series alive above. Deleting it would blank the pair.
    expect(diff.withdrawn).toEqual([
      { zone: 'DE', forecast_type: 'load', model: 'catboost', model_version: 'v1', triple_gone: false },
    ]);
  });
});
