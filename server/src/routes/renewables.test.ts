import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { buildFixtureDb, WINDOW_QS, at } from '../test/fixtureDb.js';

const fixtureDb = buildFixtureDb();
vi.mock('../config/database.js', () => ({ default: fixtureDb }));
vi.mock('../config/writeDatabase.js', async () => (await import('../test/noWriteDb.js')).forbidWriteDb());

const { startTestApi, clearResponseCache } = await import('../test/apiHarness.js');

type Api = Awaited<ReturnType<typeof startTestApi>>;
let api: Api;

beforeAll(async () => { api = await startTestApi(); });
afterAll(() => api.close());
beforeEach(() => clearResponseCache());

const get = (path: string) => api.get(`renewables/${path}`);

/** `at()` in the ISO form the hourly bucket hands back. */
const isoAt = (hour: number) => at(hour).replace(' ', 'T');

const FIELDS = [
  'solar', 'wind_onshore', 'wind_offshore', 'hydro', 'biomass', 'geothermal', 'other',
] as const;

interface MixBody {
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
 * ABL-324 tranche 1 moved these four read sites from the frozen
 * `energy_renewable` - which stores one instant under several timestamp
 * spellings, 26,694 duplicate instants measured on the replica 2026-08-12 -
 * onto `energy_generation`, which has none across 3.18M rows.
 *
 * What these pin is the consequence that is easy to get wrong: the frozen
 * table carried `DEFAULT 0` and the old queries wrapped every column in
 * `COALESCE(x, 0)`, so "this country reports no solar" and "this country
 * measured 0 MW of solar" arrived identically. They must not any more.
 */
describe('GET /api/renewables/mix', () => {
  it('reports a mix for a country that reports renewables', async () => {
    // DE: solar 100, wind_onshore 200 at every hour of the window.
    const { status, body } = await get(`mix?country=DE&${WINDOW_QS}`);
    expect(status).toBe(200);
    const mix = body.data as MixBody;
    expect(mix.solar).toBe(100);
    expect(mix.wind_onshore).toBe(200);
    expect(mix.total).toBe(300);
  });

  it('nulls a type the country does not report, rather than zeroing it', async () => {
    // The defect this move exists to remove. DE reports no offshore wind, no
    // hydro, no biomass, no geothermal - on the frozen table every one of
    // those came back `0`, which reads as a measurement.
    const { body } = await get(`mix?country=DE&${WINDOW_QS}`);
    const mix = body.data as MixBody;
    for (const field of ['wind_offshore', 'hydro', 'biomass', 'geothermal', 'other'] as const) {
      expect(mix[field]).toBeNull();
    }
  });

  it('keeps a measured 0.0 as a value and totals it as 0, not null', async () => {
    // BE's solar and onshore wind are a measured zero at every hour - solar
    // overnight, the case a truthiness filter would silently delete. The
    // country genuinely generated no renewable power; that is a reading.
    const { body } = await get(`mix?country=BE&${WINDOW_QS}`);
    const mix = body.data as MixBody;
    expect(mix.solar).toBe(0);
    expect(mix.wind_onshore).toBe(0);
    expect(mix.total).toBe(0);
    expect(mix.total).not.toBeNull();
  });

  it('sums the reported components when a sibling column is null', async () => {
    // FR: solar a measured 0.0, hydro_run 100, hydro_reservoir never
    // reported. `hydro` must be 100 - the reported half standing alone - not
    // NULL, which a bare SQL `hydro_run_mw + hydro_reservoir_mw` would give.
    const { body } = await get(`mix?country=FR&${WINDOW_QS}`);
    const mix = body.data as MixBody;
    expect(mix.solar).toBe(0);
    expect(mix.hydro).toBe(100);
    expect(mix.wind_onshore).toBeNull();
    expect(mix.total).toBe(100);
  });

  it('nulls every field, and the total, when rows exist but report nothing', async () => {
    // PT: rows in the window, every *_mw column NULL. Distinct from BE above,
    // and the two must not render the same: PT is "we hold no reading", BE is
    // "we measured zero".
    const { body } = await get(`mix?country=PT&${WINDOW_QS}`);
    const mix = body.data as MixBody;
    for (const field of FIELDS) expect(mix[field]).toBeNull();
    expect(mix.total).toBeNull();
    expect(mix.total).not.toBe(0);
  });

  it('returns null - not a zero-filled mix - when the window holds no rows', async () => {
    // AT has no energy_generation rows at all. This is the shape of the FR
    // 2026-07-01..21 hole (ABL-323): energy_generation does not cover every
    // hour energy_renewable does, and those hours must render as a gap.
    const { status, body } = await get(`mix?country=AT&${WINDOW_QS}`);
    expect(status).toBe(200);
    expect(body.data).toBeNull();
  });

  it('requires a country', async () => {
    const { status, body } = await get(`mix?${WINDOW_QS}`);
    expect(status).toBe(400);
    expect(body.code).toBe('MISSING_COUNTRY');
  });
});

describe('GET /api/renewables', () => {
  interface SeriesPoint extends Omit<MixBody, 'total' | 'renewable_percentage'> {
    timestamp: string;
  }

  it('returns one bucket per hour with null for unreported types', async () => {
    const { status, body } = await get(`?country=DE&${WINDOW_QS}&granularity=hourly`);
    expect(status).toBe(200);
    const series = body.data as SeriesPoint[];
    expect(series).toHaveLength(4);
    expect(series[0].timestamp).toBe(isoAt(0));
    expect(series[0].solar).toBe(100);
    expect(series[0].hydro).toBeNull();
  });

  it('omits a bucket with no rows rather than emitting a zero point', async () => {
    // GR stops publishing after 01:00. A chart must draw two points and then
    // stop, not four with a pair of confident zeros on the end.
    const { body } = await get(`?country=GR&${WINDOW_QS}&granularity=hourly`);
    const series = body.data as SeriesPoint[];
    expect(series.map((p) => p.timestamp)).toEqual([isoAt(0), isoAt(1)]);
    expect(series.every((p) => p.solar === 50)).toBe(true);
  });

  it('returns an empty series, not zeros, for a country with no rows', async () => {
    const { body } = await get(`?country=AT&${WINDOW_QS}&granularity=hourly`);
    expect(body.data).toEqual([]);
  });

  it('buckets daily without dropping the window', async () => {
    const { body } = await get(`?country=DE&${WINDOW_QS}&granularity=daily`);
    const series = body.data as SeriesPoint[];
    expect(series).toHaveLength(1);
    expect(series[0].solar).toBe(100);
    expect(series[0].wind_onshore).toBe(200);
  });
});

describe('GET /api/renewables/latest', () => {
  interface LatestRow {
    country_code: string;
    country_name: string;
    timestamp: string;
    solar: number | null;
    hydro: number | null;
    total_renewable: number | null;
  }

  it('returns the newest row for one country, with unreported types null', async () => {
    const { status, body } = await get('latest?country=DE');
    expect(status).toBe(200);
    const row = body.data as LatestRow;
    expect(row.country_code).toBe('DE');
    expect(row.timestamp).toBe(at(3));
    expect(row.solar).toBe(100);
    expect(row.hydro).toBeNull();
    expect(row.total_renewable).toBe(300);
  });

  it('reports a null total for a latest row that reports no renewables', async () => {
    const { body } = await get('latest?country=PT');
    const row = body.data as LatestRow;
    expect(row.solar).toBeNull();
    expect(row.total_renewable).toBeNull();
  });

  it('drives the per-country scan from countries, not from energy_generation', async () => {
    // The CROSS JOIN pins `countries` (34 rows on the replica) as the outer
    // loop. Reordered, the planner scans every energy_generation index entry
    // and runs the correlated subquery per row: measured 2.819s vs 0.002s on
    // the replica 2026-08-12. Asserting the plan rather than a duration keeps
    // this meaningful on a fixture of six countries, where both shapes are
    // instant and a timing assertion would prove nothing.
    const plan = fixtureDb
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT r.country_code, r.timestamp_utc
         FROM countries c
         CROSS JOIN energy_generation r
           ON r.country_code = c.country_code
          AND r.timestamp_utc = (
            SELECT MAX(timestamp_utc) FROM energy_generation WHERE country_code = c.country_code
          )`
      )
      .all() as Array<{ detail: string }>;
    const detail = plan.map((p) => p.detail).join(' | ');
    expect(detail).toMatch(/SCAN c\b/);
    expect(detail).not.toMatch(/SCAN r\b/);
    expect(detail).toMatch(/SEARCH r\b/);
  });

  it('gives every country its own newest row, not one shared cutoff', async () => {
    // GR stopped publishing two hours before everyone else. A single global
    // MAX(timestamp_utc) would drop it entirely.
    const { body } = await get('latest');
    const rows = body.data as LatestRow[];
    const byCode = Object.fromEntries(rows.map((r) => [r.country_code, r]));
    expect(byCode.DE.timestamp).toBe(at(3));
    expect(byCode.GR.timestamp).toBe(at(1));
    // BE's every reading is a measured zero: a total of 0, not null.
    expect(byCode.BE.total_renewable).toBe(0);
    expect(byCode.PT.total_renewable).toBeNull();
    // AT has no generation rows, so it is absent rather than reported at 0.
    expect(byCode.AT).toBeUndefined();
  });
});
