import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { buildFixtureDb, NEXT_DAY, WINDOW_QS } from '../test/fixtureDb.js';
import { DIVERGENT_LOAD_BASIS } from '../services/loadForecastBasis.js';

const fixtureDb = buildFixtureDb();
vi.mock('../config/database.js', () => ({ default: fixtureDb }));
vi.mock('../config/writeDatabase.js', async () => (await import('../test/noWriteDb.js')).forbidWriteDb());
vi.mock('../services/readQueryWorker.js', () => ({
  runReadQueryInWorker: async (sql: string, params: unknown[]) => fixtureDb.prepare(sql).all(...params),
}));

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
    // Neither country has a D-7 actual anywhere in this fixture (it only seeds
    // WINDOW and NEXT_DAY), so skill is insufficient data for both — see
    // crossCountryMetricsService.test.ts for the seeded, computed-skill cases.
    const noSkill = { n: 0, skillPct: null, baselineWape: null };
    // AT: forecast 60 MW under actual at each of four hours.
    // WAPE = 100 * 240 / 2520.
    expect(data.load.AT).toEqual({ mae: 60, wape: 9.52, rmse: 60, bias: 60, dataPoints: 4, skillVsSeasonalNaive: noSkill });
    // DE: four D+1 points at 100 MW error plus four D+2 points at 200 MW.
    // WAPE = 100 * 1200 / 9200.
    expect(data.load.DE).toEqual({ mae: 150, wape: 13.04, rmse: 158.11, bias: 150, dataPoints: 8, skillVsSeasonalNaive: noSkill });
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

describe('divergent load basis reaches the wire (ABL-493)', () => {
  // The gap this covers was a *routing* gap, not a rule gap: the rule existed
  // and had exactly one caller (`tsoForecastService`), so NL's load error
  // measures were withheld on `/tso-forecast/accuracy/load/NL` and published
  // in full on this endpoint at the same moment. Prod, 2026-08-04..11:
  // `data.load.NL` = mae 2435.77, wape 30.99, rmse 3475.71, bias -2063.27,
  // skillPct -136.8, and no `basis` key of any kind. Asserting on the service
  // alone would not have caught a route that pivoted or re-shaped the entry.
  const nextDay = `start=${NEXT_DAY.start}&end=${NEXT_DAY.end}`;
  const loadFor = async (cc: string) => {
    const { body } = await get(`metrics/load?${nextDay}`);
    return (body.data as Record<string, Record<string, Record<string, unknown>>>).load[cc];
  };

  it('serves NL load with the measures withheld, the pairing count intact, and the reason attached', async () => {
    expect(await loadFor('NL')).toEqual({
      mae: null,
      wape: null,
      rmse: null,
      bias: null,
      dataPoints: 4,
      // `n` and `baselineWape` are realized-vs-realized and stay; only the
      // ratio against the contaminated model WAPE goes.
      skillVsSeasonalNaive: { n: 4, skillPct: null, baselineWape: 16.67 },
      basis: 'divergent_basis',
      basisNote: DIVERGENT_LOAD_BASIS.NL.reason,
    });
  });

  it('serves the same country\'s price numbers unchanged, with no basis key', async () => {
    const { body } = await get(`metrics/price?${nextDay}`);
    const nl = (body.data as Record<string, Record<string, Record<string, unknown>>>).price.NL;
    expect(nl).toEqual({
      mae: 5, wape: 7.69, rmse: 5, bias: -5, dataPoints: 4,
      skillVsSeasonalNaive: { n: 0, skillPct: null, baselineWape: null },
    });
  });

  it('carries the suppression through the all-types route identically', async () => {
    // The per-type and all-types routes take different code paths (one sync,
    // one through the read worker) and must not disagree about NL, the same
    // way they must not disagree about BE's null WAPE below.
    const { body } = await get(`metrics?${nextDay}`);
    const data = body.data as Record<string, Record<string, Record<string, unknown>>>;
    expect(data.load.NL).toMatchObject({ wape: null, bias: null, basis: 'divergent_basis' });
    expect(data.price.NL).toMatchObject({ wape: 7.69, bias: -5 });
    expect(data.price.NL).not.toHaveProperty('basis');
  });

  it('still counts NL as a country with data — withheld is not absent', async () => {
    const { body } = await get(`metrics/load?${nextDay}`);
    expect((body.meta as Record<string, unknown>).countriesWithData).toContain('NL');
  });
});

describe('GET /api/cross-country/metrics', () => {
  it('spans every type that has data and lists the countries once', async () => {
    const { status, body } = await get(`metrics?${WINDOW}`);

    expect(status).toBe(200);
    const data = body.data as Record<string, Record<string, unknown>>;
    // Only types with at least one paired country appear; the other four are
    // absent rather than present-and-empty. `renewable` and `hydro_total` are
    // FR's, added with the forecastService column-mapping fix — the order is
    // VALID_FORECAST_TYPES', not alphabetical.
    expect(Object.keys(data)).toEqual(['load', 'renewable', 'solar', 'hydro_total']);
    expect(body.meta).toMatchObject({
      countriesWithData: ['AT', 'BE', 'DE', 'FR'],
      forecastTypes: ['load', 'renewable', 'solar', 'hydro_total'],
    });
  });

  it('carries the null WAPE through the all-types response too', async () => {
    // The per-type route and the all-types route must not disagree about BE.
    const { body } = await get(`metrics?${WINDOW}`);
    const solar = (body.data as Record<string, Record<string, Record<string, unknown>>>).solar;
    expect(solar.BE.wape).toBeNull();
  });
});
