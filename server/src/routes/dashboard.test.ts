import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

import { buildFixtureDb, WINDOW, WINDOW_QS } from '../test/fixtureDb.js';

// The router graph opens the shared SQLite file at import time. Hand it the
// in-memory fixture instead, so no test can reach the real database. The
// harness is imported dynamically, below, so that these mocks are registered
// before the router graph loads.
const fixtureDb = buildFixtureDb();
vi.mock('../config/database.js', () => ({ default: fixtureDb }));
vi.mock('../config/writeDatabase.js', async () => (await import('../test/noWriteDb.js')).forbidWriteDb());

const { startTestApi, clearResponseCache } = await import('../test/apiHarness.js');

type Api = Awaited<ReturnType<typeof startTestApi>>;
let api: Api;

beforeAll(async () => { api = await startTestApi(); });
afterAll(() => api.close());
// The response cache is a module singleton keyed on URL. Without this, a test
// can be served an earlier test's body.
beforeEach(() => clearResponseCache());

describe('GET /api/dashboard/overview — envelope and window', () => {
  it('returns the ApiResponse envelope with the measured window in meta', async () => {
    const { status, body } = await api.get(`dashboard/overview?country=DE&${WINDOW_QS}`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.meta).toEqual({
      country: 'DE',
      timeRange: { start: WINDOW.start, end: WINDOW.end },
    });
    expect(body.data).toMatchObject({
      currentLoad: 1300,
      avgPrice: 65,          // AVG(50, 60, 70, 80)
      peakDemand: 1300,      // MAX(1000, 1100, 1200, 1300)
      renewablePercentage: 30, // 300 renewable of 1000 positive MW per row
      dataTimestamp: '2026-07-01 03:00:00',
    });
  });

  it('uppercases the country code it echoes back', async () => {
    const { body } = await api.get(`dashboard/overview?country=de&${WINDOW_QS}`);
    expect((body.meta as Record<string, unknown>).country).toBe('DE');
  });

  it('omits priceChange24h rather than reporting a 0 change', async () => {
    // The 24h delta is computed against wall-clock now, which no fixture window
    // covers. Unmeasurable must not render as "no change".
    const { body } = await api.get(`dashboard/overview?country=DE&${WINDOW_QS}`);
    expect(body.data).not.toHaveProperty('priceChange24h');
  });

  it('rejects a request with no country', async () => {
    const { status, body } = await api.get('dashboard/overview');
    expect(status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: 'Country code is required',
      code: 'MISSING_COUNTRY',
    });
  });
});

describe('GET /api/dashboard/overview — start/end vs the legacy timeRange', () => {
  it('lets an explicit start/end win over timeRange', async () => {
    // Both are sent and they disagree: timeRange=24h resolves against wall-clock
    // now, which is nowhere near the fixture window. Getting the fixture's
    // numbers back is what proves start/end took precedence.
    const { body } = await api.get(`dashboard/overview?country=DE&timeRange=24h&${WINDOW_QS}`);
    expect((body.data as Record<string, unknown>).avgPrice).toBe(65);
    expect((body.meta as Record<string, unknown>).timeRange)
      .toEqual({ start: WINDOW.start, end: WINDOW.end });
  });

  it('falls back to the timeRange enum when start/end are absent', async () => {
    const { body } = await api.get('dashboard/overview?country=DE&timeRange=24h');
    // A 24h window ending now contains no fixture row, so every windowed metric
    // is null — and null, not 0.
    expect(body.data).toMatchObject({
      avgPrice: null,
      peakDemand: null,
      renewablePercentage: null,
    });
    expect((body.meta as Record<string, unknown>).timeRange).toBe('24h');
  });

  it('ignores a half-supplied window instead of guessing the other end', async () => {
    // The route requires BOTH start and end before it honours the explicit
    // window. `start` alone falls back to the enum rather than inventing an end.
    const { body } = await api.get(`dashboard/overview?country=DE&start=${WINDOW.start}&timeRange=24h`);
    expect((body.data as Record<string, unknown>).avgPrice).toBeNull();
    expect((body.meta as Record<string, unknown>).timeRange).toBe('24h');
  });

  it('reports currentLoad from the latest row regardless of the window', async () => {
    // currentLoad is deliberately unwindowed — it is "latest known", not "latest
    // in this window" — so it survives a window with nothing in it.
    const { body } = await api.get('dashboard/overview?country=DE&timeRange=24h');
    expect((body.data as Record<string, unknown>).currentLoad).toBe(1300);
  });
});

describe('GET /api/dashboard/overview — renewable share must never fabricate a number', () => {
  it('returns null when every generation column is NULL', async () => {
    // PT has rows in the window but reports no production type at all. NULL is
    // "we do not know", and a share of nothing is undefined, not 0%.
    const { body } = await api.get(`dashboard/overview?country=PT&${WINDOW_QS}`);
    expect((body.data as Record<string, unknown>).renewablePercentage).toBeNull();
  });

  it('returns null when the window has no generation rows at all', async () => {
    // AT is still mid-backfill. A different null path than PT's — zero rows,
    // rather than rows that sum to nothing — and it must land in the same place.
    const { body } = await api.get(`dashboard/overview?country=AT&${WINDOW_QS}`);
    expect((body.data as Record<string, unknown>).renewablePercentage).toBeNull();
  });

  it('returns null when total positive generation is a measured zero', async () => {
    // BE's generation is 0.0 everywhere — measured, not unknown. The ratio is
    // still undefined, and "0% renewable" would be a fabricated reading.
    const { body } = await api.get(`dashboard/overview?country=BE&${WINDOW_QS}`);
    expect((body.data as Record<string, unknown>).renewablePercentage).toBeNull();
  });

  it('excludes pumped storage and clamps negative draws out of the denominator', async () => {
    // FR pumps 300 MW and draws 50 MW on a consumption-only coal series. Neither
    // may shrink the base: renewable 100 over positive generation 800 = 12.5%.
    // Counting the -300 would give 100/500 = 20%; counting pumped storage as
    // renewable output would double-count energy generated elsewhere.
    const { body } = await api.get(`dashboard/overview?country=FR&${WINDOW_QS}`);
    expect((body.data as Record<string, unknown>).renewablePercentage).toBe(12.5);
  });
});

describe('GET /api/dashboard/overview — negative values are legitimate', () => {
  it('averages negative day-ahead prices without cancelling or absolute-valuing them', async () => {
    // BE's window is -10 / -20 / -30 / -40. The answer is -25.
    const { body } = await api.get(`dashboard/overview?country=BE&${WINDOW_QS}`);
    expect((body.data as Record<string, unknown>).avgPrice).toBe(-25);
  });
});

describe('GET /api/dashboard/overview — a zone that stopped publishing', () => {
  it('reports only what was published, and stops at the last published hour', async () => {
    // GR goes silent after 01:00 — the GR/IE shape. peakDemand covers the two
    // hours that exist; it does not extend the last value across the gap.
    const { body } = await api.get(`dashboard/overview?country=GR&${WINDOW_QS}`);
    expect(body.data).toMatchObject({
      currentLoad: 310,
      peakDemand: 310,
      dataTimestamp: '2026-07-01 01:00:00',
    });
  });

  it('returns nulls, not zeros, for a window entirely after the zone went silent', async () => {
    const { body } = await api.get('dashboard/overview?country=GR&start=2026-07-02T00:00:00Z&end=2026-07-02T03:00:00Z');
    expect(body.data).toMatchObject({
      avgPrice: null,
      peakDemand: null,
      renewablePercentage: null,
      currentLoad: 310, // still the last thing GR ever published
    });
  });
});

describe('GET /api/dashboard/map', () => {
  it('returns one row per country with data, ordered by country name', async () => {
    const { status, body } = await api.get(`dashboard/map?metric=load&${WINDOW_QS}`);
    expect(status).toBe(200);
    const data = body.data as Array<{ country_code: string; value: number }>;
    expect(data.map((d) => d.country_code)).toEqual(['AT', 'BE', 'FR', 'DE', 'GR', 'PT']);
    expect(data.map((d) => d.value)).toEqual([630, 500, 800, 1150, 305, 200]);
    expect(body.meta).toMatchObject({ metric: 'load', count: 6, unit: 'MW' });
  });

  it('carries negative prices through to the choropleth', async () => {
    const { body } = await api.get(`dashboard/map?metric=price&${WINDOW_QS}`);
    const data = body.data as Array<{ country_code: string; value: number }>;
    expect(data.find((d) => d.country_code === 'BE')?.value).toBe(-25);
    expect((body.meta as Record<string, unknown>).unit).toBe('EUR/MWh');
  });

  it('omits a country whose renewable share is undefined rather than colouring it 0%', async () => {
    // PT (all NULL) and BE (all measured zero) both have generation rows in the
    // window, and both must be absent — the map renders an absent country as
    // "no data", which is the honest reading. A 0 here would paint them as the
    // greenest grids in Europe.
    const { body } = await api.get(`dashboard/map?metric=renewable_pct&${WINDOW_QS}`);
    const data = body.data as Array<{ country_code: string; value: number }>;
    expect(data.map((d) => d.country_code)).toEqual(['FR', 'DE', 'GR']);
    expect(data.map((d) => d.value)).toEqual([12.5, 30, 50]);
  });

  it('forces Luxembourg to the DE_LU zone value rather than showing two colours', async () => {
    // LU carries its own contradictory ingest artifact (-6201 MW). Left alone it
    // renders beside Germany's +175 as two colours for one bidding zone.
    const { body } = await api.get(`dashboard/map?metric=net_position&${WINDOW_QS}`);
    const data = body.data as Array<{ country_code: string; value: number; timestamp: string }>;
    const de = data.find((d) => d.country_code === 'DE');
    const lu = data.find((d) => d.country_code === 'LU');
    expect(de?.value).toBe(175);
    expect(lu?.value).toBe(175);
    expect(lu?.timestamp).toBe(de?.timestamp);
  });

  it('rejects an unknown metric and names the valid ones', async () => {
    const { status, body } = await api.get('dashboard/map?metric=bogus');
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.code).toBe('INVALID_METRIC');
    expect(String(body.error)).toContain('renewable_pct');
  });
});

describe('GET /api/dashboard/timeseries', () => {
  it('merges load, price and renewable output onto one row per day', async () => {
    const { status, body } = await api.get(`dashboard/timeseries?country=DE&${WINDOW_QS}`);
    expect(status).toBe(200);
    expect(body.data).toEqual([
      {
        date: '2026-07-01',
        load: 1150,
        price: 65,
        solar: 130,          // AVG(100, 120, 140, 160)
        wind_onshore: 200,
        wind_offshore: 0,
        hydro: 0,
        biomass: 0,
        geothermal: 0,
      },
    ]);
    expect(body.meta).toMatchObject({ country: 'DE', count: 1 });
  });

  it('returns an empty series rather than an error for a country with no rows', async () => {
    const { status, body } = await api.get(`dashboard/timeseries?country=LU&${WINDOW_QS}`);
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect((body.meta as Record<string, unknown>).count).toBe(0);
  });

  it('rejects a request with no country', async () => {
    const { status, body } = await api.get('dashboard/timeseries');
    expect(status).toBe(400);
    expect(body.code).toBe('MISSING_COUNTRY');
  });
});

describe('GET /api/dashboard/initial', () => {
  it('returns overview and load data in one payload', async () => {
    const { status, body } = await api.get(`dashboard/initial?country=DE&${WINDOW_QS}`);
    expect(status).toBe(200);
    const data = body.data as { overview: Record<string, unknown>; loadData: Array<Record<string, unknown>> };
    expect(data.loadData).toEqual([
      { timestamp: '2026-07-01T00:00:00', load: 1000, quality: 'actual' },
      { timestamp: '2026-07-01T01:00:00', load: 1100, quality: 'actual' },
      { timestamp: '2026-07-01T02:00:00', load: 1200, quality: 'actual' },
      { timestamp: '2026-07-01T03:00:00', load: 1300, quality: 'actual' },
    ]);
    expect((body.meta as Record<string, unknown>).loadDataCount).toBe(4);
  });

  it('computes the same overview a direct /overview call would', async () => {
    // usePrefetch seeds the useDashboardOverview query cache straight from this
    // response. If the two computed their window differently, the seeded cache
    // would silently carry different numbers than a live fetch.
    const initial = await api.get(`dashboard/initial?country=FR&${WINDOW_QS}`);
    clearResponseCache();
    const overview = await api.get(`dashboard/overview?country=FR&${WINDOW_QS}`);

    const fromInitial = (initial.body.data as { overview: unknown }).overview;
    expect(fromInitial).toEqual(overview.body.data);
  });

  it('rejects a request with no country', async () => {
    const { status, body } = await api.get('dashboard/initial');
    expect(status).toBe(400);
    expect(body.code).toBe('MISSING_COUNTRY');
  });
});

describe('the API error envelope', () => {
  it('answers an unmounted path with the 404 envelope, not an HTML page', async () => {
    const { status, body } = await api.get('dashboard/does-not-exist');
    expect(status).toBe(404);
    expect(body).toEqual({
      success: false,
      error: 'Resource not found',
      code: 'NOT_FOUND',
    });
  });

  it('serves the health check', async () => {
    const { status, body } = await api.get('health');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect((body.data as Record<string, unknown>).status).toBe('healthy');
  });
});
