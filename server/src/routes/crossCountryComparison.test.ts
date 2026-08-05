import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { buildFixtureDb, WINDOW_QS } from '../test/fixtureDb.js';

const fixtureDb = buildFixtureDb();
vi.mock('../config/database.js', () => ({ default: fixtureDb }));
vi.mock('../config/writeDatabase.js', async () => (await import('../test/noWriteDb.js')).forbidWriteDb());

const { startTestApi, clearResponseCache } = await import('../test/apiHarness.js');

type Api = Awaited<ReturnType<typeof startTestApi>>;
let api: Api;

beforeAll(async () => { api = await startTestApi(); });
afterAll(() => api.close());
beforeEach(() => clearResponseCache());

const get = (path: string) => api.get(`cross-country/${path}`);
const WINDOW = WINDOW_QS;

describe('GET /api/cross-country/metrics/:forecastType', () => {
  it('returns WAPE, MAE, RMSE and bias per country', async () => {
    const { status, body } = await get(`metrics/load?${WINDOW}`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const data = body.data as Record<string, Record<string, Record<string, unknown>>>;
    // AT: forecast 60 MW under actual at each of four hours.
    // WAPE = 100 * 240 / 2520.
    expect(data.load.AT).toEqual({ mae: 60, wape: 9.52, rmse: 60, bias: 60, dataPoints: 4 });
    // DE: four D+1 points at 100 MW error plus four D+2 points at 200 MW.
    // WAPE = 100 * 1200 / 9200.
    expect(data.load.DE).toEqual({ mae: 150, wape: 13.04, rmse: 158.11, bias: 150, dataPoints: 8 });
    expect(body.meta).toMatchObject({
      countriesWithData: ['AT', 'DE'],
      forecastTypes: ['load'],
    });
  });

  it('returns a null WAPE — never 0 — when the window\'s actuals sum to zero', async () => {
    // This is the failure the cross-country view exists to avoid. BE's solar
    // actuals are a measured 0.0 at every hour, so the WAPE denominator
    // (sum of |actual|) is zero and the ratio is undefined. A 0 here puts BE
    // at the top of the accuracy leaderboard with a flawless score, on a
    // window where the forecast was wrong at every single point.
    const { status, body } = await get(`metrics/solar?${WINDOW}`);

    expect(status).toBe(200);
    const be = (body.data as Record<string, Record<string, Record<string, unknown>>>).solar.BE;
    expect(be.wape).toBeNull();
    // The error itself is real and still reported — only the ratio is undefined.
    expect(be).toMatchObject({ mae: 5, rmse: 5, bias: -5, dataPoints: 4 });
  });

  it('omits a forecast type with no paired data rather than emitting empty countries', async () => {
    const { body } = await get(`metrics/biomass?${WINDOW}`);
    expect(body.data).toEqual({ biomass: {} });
    expect((body.meta as Record<string, unknown>).countriesWithData).toEqual([]);
  });

  it('rejects an unknown forecast type', async () => {
    const { status, body } = await get('metrics/nonsense');
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.code).toBe('INVALID_FORECAST_TYPE');
    expect(String(body.error)).toContain('wind_offshore');
  });
});

describe('GET /api/cross-country/metrics', () => {
  it('spans every type that has data and lists the countries once', async () => {
    const { status, body } = await get(`metrics?${WINDOW}`);

    expect(status).toBe(200);
    const data = body.data as Record<string, Record<string, unknown>>;
    // Only types with at least one paired country appear; the other six are
    // absent rather than present-and-empty.
    expect(Object.keys(data)).toEqual(['load', 'solar']);
    expect(body.meta).toMatchObject({
      countriesWithData: ['AT', 'BE', 'DE'],
      forecastTypes: ['load', 'solar'],
    });
  });

  it('carries the null WAPE through the all-types response too', async () => {
    // The per-type route and the all-types route must not disagree about BE.
    const { body } = await get(`metrics?${WINDOW}`);
    const solar = (body.data as Record<string, Record<string, Record<string, unknown>>>).solar;
    expect(solar.BE.wape).toBeNull();
  });
});
