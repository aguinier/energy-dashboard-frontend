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

const get = (path: string) => api.get(`generation/${path}`);

/** `at()` in the ISO form the hourly bucket hands back. */
const isoAt = (hour: number) => at(hour).replace(' ', 'T');

interface SeriesPoint {
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

const GROUPS = [
  'nuclear', 'solar', 'wind', 'hydro', 'hydro_pumped',
  'fossil', 'biomass', 'waste', 'other',
] as const;

/**
 * ABL-44: the Generation tab's trend chart drew only the four renewable
 * families while the donut and by-source table beside it showed the whole A75
 * mix. These pin the endpoint that closes that gap — same table, same
 * grouping, same null and sign semantics as `/generation/mix`.
 */
describe('GET /api/generation/series', () => {
  it('serves the classical families alongside the renewable ones', async () => {
    const { status, body } = await get(`series?country=DE&granularity=hourly&${WINDOW_QS}`);

    expect(status).toBe(200);
    const data = body.data as SeriesPoint[];

    expect(data).toHaveLength(4);
    // Nuclear and fossil are the whole point of the ticket: energy_renewable
    // never carried either, so the old series could not have drawn them.
    expect(data[0]).toEqual({
      timestamp: isoAt(0),
      nuclear: 300,
      solar: 100,
      wind: 200,
      hydro: null,
      hydro_pumped: null,
      fossil: 400,
      biomass: null,
      waste: null,
      other: null,
    });
  });

  it('reports a country that sends no production type at all as all-null, never as zeros', async () => {
    // PT: rows exist for every hour, every column NULL. A zero here would
    // draw Portugal as a country that generates nothing.
    const { status, body } = await get(`series?country=PT&granularity=hourly&${WINDOW_QS}`);

    expect(status).toBe(200);
    const data = body.data as SeriesPoint[];

    expect(data).toHaveLength(4);
    for (const point of data) {
      for (const group of GROUPS) expect(point[group]).toBeNull();
    }
  });

  it('keeps a measured zero and an unreported type apart in the same point', async () => {
    // FR reports solar as a measured 0.0 and does not report wind at all.
    const { body } = await get(`series?country=FR&granularity=hourly&${WINDOW_QS}`);
    const [point] = body.data as SeriesPoint[];

    expect(point.solar).toBe(0);
    expect(point.wind).toBeNull();
  });

  it('returns pumped storage and a consumption-only fossil type signed, not clamped', async () => {
    // FR: hydro_pumped_mw -300 (pumping), fossil_hard_coal_mw -50
    // (consumption-only). Clamping either to 0 on the wire would erase a real
    // measured draw; how they are DRAWN is the client's decision (see
    // dashboard/generationSeries.ts).
    const { body } = await get(`series?country=FR&granularity=hourly&${WINDOW_QS}`);
    const data = body.data as SeriesPoint[];

    for (const point of data) {
      expect(point.hydro_pumped).toBe(-300);
      expect(point.fossil).toBe(-50);
      expect(point.nuclear).toBe(700);
      // hydro_run 100 with hydro_reservoir NULL — the sum must not propagate
      // the NULL and delete a real run-of-river reading.
      expect(point.hydro).toBe(100);
    }
  });

  it('returns an empty series for a country with no generation rows at all', async () => {
    // AT is mid-backfill: zero rows, a different null path than PT's.
    const { status, body } = await get(`series?country=AT&granularity=hourly&${WINDOW_QS}`);

    expect(status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it('stops where a country stopped publishing, rather than padding the window', async () => {
    // GR has rows for 00:00 and 01:00 only. The last two hours must be
    // absent, not zero-filled.
    const { body } = await get(`series?country=GR&granularity=hourly&${WINDOW_QS}`);
    const data = body.data as SeriesPoint[];

    expect(data.map((p) => p.timestamp)).toEqual([isoAt(0), isoAt(1)]);
    expect(data.every((p) => p.solar === 50 && p.nuclear === 50)).toBe(true);
  });

  it('agrees with /generation/mix over the same window, group for group', async () => {
    // The consistency property the ticket asks for: the trend chart and the
    // donut read the same table through the same grouping, so a monthly
    // bucket over this window must reproduce the mix the donut draws.
    const series = await get(`series?country=FR&granularity=monthly&${WINDOW_QS}`);
    const mix = await get(`mix?country=FR&${WINDOW_QS}`);

    const [point] = series.body.data as SeriesPoint[];
    const m = mix.body.data as Record<string, number | null>;

    expect(point.nuclear).toBe(m.nuclear);
    expect(point.solar).toBe(m.solar);
    expect(point.hydro_pumped).toBe(m.hydro_pumped);
    expect(point.hydro).toBe((m.hydro_run ?? 0) + (m.hydro_reservoir ?? 0));
    expect(point.fossil).toBe(m.fossil_hard_coal);
    expect(point.wind).toBeNull();
    expect(m.wind_onshore).toBeNull();
  });

  it('requires a country', async () => {
    const { status, body } = await get(`series?${WINDOW_QS}`);

    expect(status).toBe(400);
    expect(body).toMatchObject({ success: false, code: 'MISSING_COUNTRY' });
  });

  it('echoes the granularity and count it actually served', async () => {
    const { body } = await get(`series?country=DE&granularity=daily&${WINDOW_QS}`);

    expect(body.meta).toMatchObject({ count: 1, granularity: 'daily' });
    expect((body.data as SeriesPoint[])[0].timestamp).toBe('2026-07-01');
  });
});

interface WindSeriesPoint {
  timestamp: string;
  wind_onshore: number | null;
  wind_offshore: number | null;
}

/**
 * ABL-235: the wind forecast tab needs onshore and offshore actuals plotted
 * (and compared against their own registered forecast models) independently
 * — /series' combined `wind` family above cannot support that split.
 */
describe('GET /api/generation/wind', () => {
  it('splits onshore and offshore rather than summing them', async () => {
    const { status, body } = await get(`wind?country=DE&granularity=hourly&${WINDOW_QS}`);

    expect(status).toBe(200);
    const data = body.data as WindSeriesPoint[];

    expect(data).toHaveLength(4);
    expect(data[0]).toEqual({ timestamp: isoAt(0), wind_onshore: 200, wind_offshore: null });
  });

  it('keeps a measured zero for one type apart from an unreported sibling', async () => {
    // BE reports wind_onshore as a measured 0.0 every hour and never reports
    // wind_offshore at all — a country that has always had offshore wind read
    // as "unmeasured", not as "zero output".
    const { body } = await get(`wind?country=BE&granularity=hourly&${WINDOW_QS}`);
    const data = body.data as WindSeriesPoint[];

    expect(data).toHaveLength(4);
    for (const point of data) {
      expect(point.wind_onshore).toBe(0);
      expect(point.wind_offshore).toBeNull();
    }
  });

  it('reports a country that sends neither type as all-null, never as zeros', async () => {
    // PT: rows exist for every hour, every column NULL.
    const { body } = await get(`wind?country=PT&granularity=hourly&${WINDOW_QS}`);
    const data = body.data as WindSeriesPoint[];

    expect(data).toHaveLength(4);
    for (const point of data) {
      expect(point.wind_onshore).toBeNull();
      expect(point.wind_offshore).toBeNull();
    }
  });

  it('returns an empty series for a country with no generation rows at all', async () => {
    const { status, body } = await get(`wind?country=AT&granularity=hourly&${WINDOW_QS}`);

    expect(status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it('stops where a country stopped publishing, rather than padding the window', async () => {
    // GR has rows for 00:00 and 01:00 only.
    const { body } = await get(`wind?country=GR&granularity=hourly&${WINDOW_QS}`);
    const data = body.data as WindSeriesPoint[];

    expect(data.map((p) => p.timestamp)).toEqual([isoAt(0), isoAt(1)]);
  });

  it('requires a country', async () => {
    const { status, body } = await get(`wind?${WINDOW_QS}`);

    expect(status).toBe(400);
    expect(body).toMatchObject({ success: false, code: 'MISSING_COUNTRY' });
  });

  it('echoes the granularity and count it actually served', async () => {
    const { body } = await get(`wind?country=DE&granularity=daily&${WINDOW_QS}`);

    expect(body.meta).toMatchObject({ count: 1, granularity: 'daily' });
    expect((body.data as WindSeriesPoint[])[0].timestamp).toBe('2026-07-01');
  });
});
