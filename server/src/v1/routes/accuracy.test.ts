import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createV1Routes } from './index.js';
import { publicErrorHandler, publicNotFoundHandler } from '../publicErrors.js';
import {
  createMemoryDataContext,
  createMemoryEnergySource,
  type MemoryEnergySource,
} from '../data/memoryEnergySource.js';

/**
 * `GET /v1/accuracy` as a subscriber meets it.
 *
 * `accuracyRepo.test.ts` proves the join and `accuracyMetrics.test.ts` proves
 * the arithmetic; this file proves the **contract** — the parts somebody outside
 * engineering has signed off on, which are only kept if something reads a
 * response body:
 *
 * | promise | where it comes from |
 * |---|---|
 * | `coverage` on every response, distinguishing perfect from unmeasurable | ABL-293 §2a |
 * | a metric is `null`, never `0`, when it was not measured | ABL-293 §2a |
 * | the conflicting-timestamp convention is published, not silent | ABL-215 is open; this is the CTO's instruction on ABL-373 |
 * | accuracy metrics are ours, `attribution_required: false` | ToS §7.3, §2 |
 * | every numeric field carries its unit | ABL-293 §2a |
 * | freshness on every response | Board, 2026-08-12 |
 * | no link is built from the request host | ABL-291 brief §2, trap 1 |
 *
 * Mounted on a bare app rather than through `createPublicApp`: the key gate and
 * the meter have their own suites, and threading a key through every request
 * here would make a failure in the gate read as a failure in the contract.
 */

let source: MemoryEnergySource;
let api: { origin: string; close: () => Promise<void> };

const NOW = new Date('2026-08-12T12:00:00Z');

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${api.origin}${path}`);
  return { status: res.status, body: await res.json() };
}

/**
 * A fleet shaped around the cases that are hard rather than the ones that are
 * typical.
 *
 * - **DE** — twelve catboost load hours, ten of which pair. One pairs only
 *   through the 'T'-form fallback; one is a conflicting T/space pair; one has an
 *   impossible `0.0` actual that must not be scored; one has no actual at all.
 * - **FR** — forecast by **xgboost**, not catboost, which is the real fleet: the
 *   two models cover disjoint zone sets. Asking for catboost here is the
 *   `no_model_coverage` case, and it is a normal question.
 * - **NO** — catboost forecasts and no actuals ingested at all. The
 *   `no_paired_actuals` case, which must not read as the same thing.
 */
function seed(db: MemoryEnergySource): void {
  db.zones('DE', 'FR', 'NO');

  const target = (hour: number) => `2026-08-12T${String(hour).padStart(2, '0')}:00:00`;
  const stored = (hour: number) => `2026-08-12 ${String(hour).padStart(2, '0')}:00:00`;

  for (let hour = 0; hour < 12; hour += 1) {
    db.forecast({
      zone: 'DE',
      type: 'load',
      target: target(hour),
      generatedAt: '2026-08-12T07:00:00.100000',
      horizonHours: hour,
      value: 40_000,
      model: 'catboost',
    });
  }
  // Eight ordinary hours: forecast 40,000 against an actual 41,000.
  for (let hour = 0; hour < 8; hour += 1) db.load('DE', stored(hour), 41_000);
  // Hour 8 exists only in 'T' form — the ABL-214 rescue.
  db.load('DE', target(8), 41_000);
  // Hour 9 exists in both forms, disagreeing. Space wins by the stated convention.
  db.load('DE', stored(9), 41_000);
  db.load('DE', target(9), 99_999);
  // Hour 10's actual is an impossible 0.0: a placeholder, not a measurement.
  db.load('DE', stored(10), 0);
  // Hour 11 has no actual in either form.

  for (let hour = 0; hour < 4; hour += 1) {
    db.forecast({
      zone: 'FR',
      type: 'load',
      target: target(hour),
      generatedAt: '2026-08-12T07:00:00.100000',
      horizonHours: hour,
      value: 50_000,
      model: 'xgboost',
    });
    db.load('FR', stored(hour), 51_000);
  }

  for (let hour = 0; hour < 4; hour += 1) {
    db.forecast({
      zone: 'NO',
      type: 'load',
      target: target(hour),
      generatedAt: '2026-08-12T07:00:00.100000',
      horizonHours: hour,
      value: 9_000,
      model: 'catboost',
    });
  }

  db.ingestPass({
    pipelineType: 'load',
    zone: 'DE',
    startTime: '2026-08-12T11:30:00+00:00',
    endTime: '2026-08-12T11:41:00+00:00',
  });
}

beforeAll(async () => {
  source = createMemoryEnergySource();
  seed(source);

  const app = express();
  app.use('/v1', createV1Routes(createMemoryDataContext(source, { now: () => NOW })));
  app.use(publicNotFoundHandler);
  app.use(publicErrorHandler);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server did not bind');
  api = {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
});

afterAll(async () => {
  await api.close();
  source.close();
});

const DE_DAY = 'zone=DE&type=load&from=2026-08-12&to=2026-08-13';

describe('a measured window', () => {
  it('scores the ten hours that paired, out of twelve forecast', () => {
    // The pairing rate is published rather than left to be assumed 100%: two
    // hours are legitimately absent (no actual, and an impossible `0.0`), and a
    // metric over ten hours must not look like a metric over twelve.
    return get(`/v1/accuracy?${DE_DAY}`).then(({ body }) => {
      expect(body.meta.coverage).toBe('ok');
      expect(body.meta.forecast_hours).toBe(12);
      expect(body.data[0].sample_size).toBe(10);
    });
  });

  it('returns one row with all five metrics, never an empty array', () => {
    return get(`/v1/accuracy?${DE_DAY}`).then(({ body }) => {
      expect(body.data).toHaveLength(1);
      // A forecast of 40,000 against an actual of 41,000, ten times over.
      expect(body.data[0]).toMatchObject({
        mae: 1_000,
        rmse: 1_000,
        mape: 2.44,
        wape: 2.44,
        sample_size: 10,
        mape_samples: 10,
      });
    });
  });

  it('resolved the conflicting pair to the space-form value, and says so', () => {
    // Hour 9 holds 41,000 (space) and 99,999 ('T'). Had the 'T' row been scored,
    // or had both been, MAE would be far above 1,000 — so the assertion above
    // that it is exactly 1,000 is also the assertion that the convention held.
    return get(`/v1/accuracy?${DE_DAY}`).then(({ body }) => {
      expect(body.meta.conflict_convention).toBe('space_preferred');
      expect(body.data[0].mae).toBe(1_000);
    });
  });

  it('echoes what the number is a statement about', () => {
    return get(`/v1/accuracy?${DE_DAY}`).then(({ body }) => {
      expect(body.meta).toMatchObject({
        resource: 'accuracy',
        zone: 'DE',
        forecast_type: 'load',
        model: 'catboost',
        horizon_hours: null,
        from: '2026-08-12T00:00:00Z',
        to: '2026-08-13T00:00:00Z',
      });
      expect(body.meta.latest_vintage_at).toBe('2026-08-12T07:00:00Z');
    });
  });

  it('filters to one horizon when asked', async () => {
    const { body } = await get(`/v1/accuracy?${DE_DAY}&horizon=3`);

    expect(body.meta.horizon_hours).toBe(3);
    expect(body.data[0].sample_size).toBe(1);
  });
});

describe('an unmeasurable window is never a flawless one', () => {
  it('answers no_model_coverage for a model that does not serve the zone', async () => {
    // catboost covers 21 zones and xgboost covers AT/BE/FR. "How does catboost
    // forecast France" is well-formed and its honest answer is "it does not" —
    // not `mape: 0`.
    const { body } = await get('/v1/accuracy?zone=FR&type=load&from=2026-08-12&to=2026-08-13&model=catboost');

    expect(body.meta.coverage).toBe('no_model_coverage');
    expect(body.meta.forecast_hours).toBe(0);
    expect(body.data).toHaveLength(1);
    for (const field of ['mape', 'wape', 'smape', 'mae', 'rmse']) {
      expect(body.data[0][field]).toBeNull();
    }
  });

  it('answers no_paired_actuals when we forecast the window and nothing landed', async () => {
    // A different fact with a different remedy: wait, versus ask a different
    // model. Collapsing both into one word is what makes an empty result
    // unactionable.
    const { body } = await get('/v1/accuracy?zone=NO&type=load&from=2026-08-12&to=2026-08-13');

    expect(body.meta.coverage).toBe('no_paired_actuals');
    expect(body.meta.forecast_hours).toBe(4);
    expect(body.data[0].sample_size).toBe(0);
    expect(body.data[0].mape).toBeNull();
  });

  it('never reports a zero metric for either empty case', async () => {
    for (const path of [
      '/v1/accuracy?zone=FR&type=load&from=2026-08-12&to=2026-08-13&model=catboost',
      '/v1/accuracy?zone=NO&type=load&from=2026-08-12&to=2026-08-13',
    ]) {
      const { body } = await get(path);
      for (const field of ['mape', 'wape', 'smape', 'mae', 'rmse']) {
        expect(body.data[0][field]).not.toBe(0);
      }
    }
  });

  it('honours an explicit model strictly rather than substituting one that works', async () => {
    // FR is forecast by xgboost and has actuals. Asking for catboost must not
    // quietly return xgboost's accuracy under catboost's name.
    const pinned = await get('/v1/accuracy?zone=FR&type=load&from=2026-08-12&to=2026-08-13&model=catboost');
    const resolved = await get('/v1/accuracy?zone=FR&type=load&from=2026-08-12&to=2026-08-13');

    expect(pinned.body.meta.model).toBe('catboost');
    expect(pinned.body.data[0].mae).toBeNull();
    expect(resolved.body.meta.model).toBe('xgboost');
    expect(resolved.body.data[0].mae).toBe(1_000);
  });
});

describe('ToS §7.3 — whose numbers these are, and in what unit', () => {
  it('marks accuracy metrics as ours, needing no attribution', async () => {
    const { body } = await get(`/v1/accuracy?${DE_DAY}`);

    expect(body.meta.series).toHaveLength(5);
    for (const series of body.meta.series) {
      expect(series.source.id).toBe('able');
      expect(series.source.licence).toBe('proprietary');
      expect(series.source.attribution_required).toBe(false);
      expect(series.source.attribution).toBeNull();
    }
  });

  it('gives the three percentages and the two target-unit measures different units', async () => {
    // Five fields and two units in one response — the case §8.1 says a
    // response-level unit field would get wrong. A subscriber charting MAE
    // across types without reading this is charting megawatts against euros.
    const { body } = await get(`/v1/accuracy?${DE_DAY}`);
    const units = Object.fromEntries(body.meta.series.map((s: any) => [s.field, s.unit]));

    expect(units).toEqual({ mape: '%', wape: '%', smape: '%', mae: 'MW', rmse: 'MW' });
  });

  it('reports EUR/MWh for a price forecast', async () => {
    const { body } = await get('/v1/accuracy?zone=DE&type=price&from=2026-08-12&to=2026-08-13');
    const units = Object.fromEntries(body.meta.series.map((s: any) => [s.field, s.unit]));

    expect(units.mae).toBe('EUR/MWh');
    expect(units.mape).toBe('%');
  });
});

describe('freshness and links', () => {
  it('reports the actuals stream, which is what bounds measurability', async () => {
    // Not the forecast side. A forecast `data_through` reaches up to 64 hours
    // into the future, and advertising that on an accuracy endpoint would claim
    // measurability we do not have — nothing can be scored past the newest
    // actual.
    const { body } = await get(`/v1/accuracy?${DE_DAY}`);

    expect(Object.keys(body.meta.freshness).sort()).toEqual([
      'data_through',
      'generated_at',
      'source_checked_at',
      'status',
    ]);
    expect(body.meta.freshness.generated_at).toBe('2026-08-12T12:00:00Z');
    // DE's newest measured load hour, not its newest forecast target.
    expect(body.meta.freshness.data_through).toBe('2026-08-12T09:00:00Z');
    expect(body.meta.freshness.source_checked_at).toBe('2026-08-12T11:41:00Z');
  });

  it('builds a relative self link and a null next link', async () => {
    // `PUBLIC_BASE_URL` is unset here, which is the LAN's configuration today.
    // A link built from the request host would bake `127.0.0.1:<port>` into a
    // subscriber's client (ABL-291 brief §2, trap 1). `next` is null rather than
    // absent: one aggregate is never paged, and an absent field is one `?.` away
    // from an infinite loop.
    const { body } = await get(`/v1/accuracy?${DE_DAY}`);

    expect(body.links.next).toBeNull();
    // Colons percent-encoded by `URLSearchParams`, exactly as the eight ABL-303
    // endpoints emit them — the timestamps round-trip, and this is the shape a
    // subscriber's client already handles.
    expect(body.links.self).toBe(
      '/v1/accuracy?zone=DE&type=load&from=2026-08-12T00%3A00%3A00Z&to=2026-08-13T00%3A00%3A00Z'
    );
    expect(body.links.self).not.toContain('127.0.0.1');
  });
});

describe('the parameter grammar', () => {
  it('refuses hydro_total and renewable, naming the six types it does serve', async () => {
    // Withheld because what their actual *is* on `energy_generation` is ABL-399
    // — the frozen table folded pumping into `hydro_reservoir_mw` and stored a
    // pre-netting figure, so scoring a model fit on that basis against this one
    // reports the difference between two definitions of hydro as forecast error.
    // A refusal a client can act on beats a plausible number computed wrongly.
    for (const type of ['hydro_total', 'renewable']) {
      const { status, body } = await get(`/v1/accuracy?zone=DE&type=${type}&from=2026-08-12&to=2026-08-13`);

      expect(status).toBe(400);
      expect(body.error.code).toBe('invalid_type');
      expect(body.error.message).toContain('wind_offshore');
      // Never an echo of what the caller sent (ABL-293 §1.2e).
      expect(body.error.message).not.toContain(type);
    }
  });

  it('requires both window bounds and caps the window', async () => {
    const missing = await get('/v1/accuracy?zone=DE&type=load');
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('window_required');

    const huge = await get('/v1/accuracy?zone=DE&type=load&from=2020-01-01&to=2026-01-01');
    expect(huge.status).toBe(400);
    expect(huge.body.error.code).toBe('window_too_large');
  });

  it('refuses a horizon beyond the longest this data reaches', async () => {
    const { status, body } = await get(`/v1/accuracy?${DE_DAY}&horizon=200`);

    expect(status).toBe(400);
    expect(body.error.code).toBe('invalid_horizon');
    expect(body.error.message).toContain('no D+3');
  });

  it('has no route for net position, at any spelling', async () => {
    // Absent by construction across `/v1` — no series, no catalogue entry, no
    // target mapping. Serving it would take an addition, not the removal of a
    // guard.
    const { status, body } = await get('/v1/accuracy?zone=DE&type=net_position&from=2026-08-12&to=2026-08-13');

    expect(status).toBe(400);
    expect(body.error.message).not.toContain('net_position');
  });
});
