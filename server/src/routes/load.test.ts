import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { buildFixtureDb, WINDOW_QS, NEXT_DAY_QS } from '../test/fixtureDb.js';

const fixtureDb = buildFixtureDb();
vi.mock('../config/database.js', () => ({ default: fixtureDb }));
vi.mock('../config/writeDatabase.js', async () => (await import('../test/noWriteDb.js')).forbidWriteDb());

const { startTestApi, clearResponseCache } = await import('../test/apiHarness.js');

type Api = Awaited<ReturnType<typeof startTestApi>>;
let api: Api;

beforeAll(async () => { api = await startTestApi(); });
afterAll(() => api.close());
beforeEach(() => clearResponseCache());

const get = (path: string) => api.get(`load/${path}`);

type Point = { timestamp: string; load: number };

/**
 * The defect these cover: `energy_load` carries 543 rows of exactly `0.0`
 * across 11 countries (measured on the replica, 2026-08-06), and a national
 * grid never draws 0 MW. They are placeholders, not measurements, and the
 * dashboard was drawing them as fact — including as the header stat tile's
 * "latest load" for MK and SI, both of whose newest stored row was one.
 *
 * In the fixture on NEXT_DAY: `PT` is 200 / 0 / 220 / 0 (the interleaved shape,
 * MK's and SI's live form) and `GR` is 0 / 0 / 0 / 0 (a whole day of them).
 */
describe('GET /api/load — impossible zeros are withheld, not drawn', () => {
  it('drops the exact-zero hours and keeps the real ones', async () => {
    const { status, body } = await get(`?country=PT&granularity=hourly&${NEXT_DAY_QS}`);

    expect(status).toBe(200);
    const data = body.data as Point[];

    // The two real hours survive; a gap is left where the zeros were. A gap is
    // the correct rendering — "we have no reading for 01:00" is true, and a
    // flat line at 0 MW is not.
    expect(data).toEqual([
      { timestamp: '2026-07-02T00:00:00', load: 200, quality: 'actual' },
      { timestamp: '2026-07-02T02:00:00', load: 220, quality: 'actual' },
    ]);
  });

  it('never returns a zero load for any country in the fixture', async () => {
    for (const country of ['DE', 'FR', 'BE', 'PT', 'AT', 'GR']) {
      for (const qs of [WINDOW_QS, NEXT_DAY_QS]) {
        const { body } = await get(`?country=${country}&granularity=hourly&${qs}`);
        const loads = (body.data as Point[]).map((p) => p.load);
        expect(loads.every((v) => v > 0)).toBe(true);
      }
    }
  });

  it('leaves a healthy country untouched', async () => {
    // The guard must be invisible where there is nothing to guard against.
    const { body } = await get(`?country=DE&granularity=hourly&${WINDOW_QS}`);
    expect((body.data as Point[]).map((p) => p.load)).toEqual([1000, 1100, 1200, 1300]);
  });
});

describe('GET /api/load/stats — zeros do not enter the aggregates', () => {
  it('reports min/avg over measured hours only, and counts only those', async () => {
    const { status, body } = await get(`stats?country=PT&${NEXT_DAY_QS}`);

    expect(status).toBe(200);
    // Unguarded this read min_load 0, avg 105 over 4 "points". The zeros are
    // not small readings that drag a mean down — they are not readings.
    expect(body.data).toEqual({
      avg_load: 210,
      max_load: 220,
      min_load: 200,
      data_points: 2,
    });
  });
});

describe('GET /api/load/latest — the stat tile cannot read 0 MW', () => {
  it('returns the newest MEASURED hour, not the newest row', async () => {
    // GR's newest stored load row is 2026-07-02 03:00 and it is an impossible
    // zero — exactly MK's and SI's live shape, both of which had one as their
    // newest row when this was measured. Falling back over the whole zero day
    // to the last hour GR really published is the point: the country must not
    // vanish from the listing, and must not read a confident 0 MW.
    const { status, body } = await get('latest?country=GR');

    expect(status).toBe(200);
    expect(body.data).toMatchObject({
      country_code: 'GR',
      timestamp: '2026-07-01 01:00:00',
      load: 310,
    });
  });

  it('keeps every country in the all-countries listing at a real value', async () => {
    const { body } = await get('latest');
    const rows = body.data as Array<{ country_code: string; load: number }>;

    // GR is still present — the subquery filter is what stops the outer guard
    // from deleting the country along with its bad row.
    expect(rows.map((r) => r.country_code)).toContain('GR');
    expect(rows.every((r) => r.load > 0)).toBe(true);
  });
});
