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

const get = (path: string) => api.get(`forecasts/${path}`);

type Compare = {
  forecasts: Array<{ timestamp: string; value: number }>;
  actuals: Array<{ timestamp: string; value: number | null }>;
};

describe('GET /api/forecasts/compare — actual-column mapping', () => {
  // The regression this file exists for: `renewable` mapped to `total_mw` and
  // `hydro_total` to `hydro_mw`, neither of which is a column on
  // `energy_renewable`. better-sqlite3 throws at prepare(), so both types
  // answered 500 rather than returning a series. Every mapped type is exercised
  // here so a third one cannot rot unnoticed.
  const CASES = [
    { type: 'load', country: 'DE' },
    { type: 'price', country: 'BE' },
    { type: 'solar', country: 'DE' },
    { type: 'wind_onshore', country: 'DE' },
    { type: 'wind_offshore', country: 'DE' },
    { type: 'biomass', country: 'DE' },
    { type: 'renewable', country: 'FR' },
    { type: 'hydro_total', country: 'FR' },
  ];

  it.each(CASES)('resolves a real column for $type', async ({ type, country }) => {
    const { status, body } = await get(`compare?country=${country}&type=${type}&${WINDOW_QS}`);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('sums the two hydro columns rather than reading a nonexistent hydro_mw', async () => {
    const { status, body } = await get(`compare?country=FR&type=hydro_total&${WINDOW_QS}`);

    expect(status).toBe(200);
    const data = body.data as Compare;
    // 30+70, 35+75, 40+NULL, 45+85.
    expect(data.actuals).toEqual([
      { timestamp: '2026-07-01 00:00:00', value: 100 },
      { timestamp: '2026-07-01 01:00:00', value: 110 },
      { timestamp: '2026-07-01 02:00:00', value: null },
      { timestamp: '2026-07-01 03:00:00', value: 130 },
    ]);
  });

  it('leaves an unknown hydro component null instead of treating it as zero', async () => {
    const { body } = await get(`compare?country=FR&type=hydro_total&${WINDOW_QS}`);
    const data = body.data as Compare;

    const unknown = data.actuals[2];
    expect(unknown.value).toBeNull();
    // The specific failure guarded against: NULL + 40 reading as 40, which
    // would render a run-of-river-only hour as the whole hydro fleet.
    expect(unknown.value).not.toBe(40);
    expect(unknown.value).not.toBe(0);
  });

  it('reads renewable from total_renewable_mw', async () => {
    const { body } = await get(`compare?country=FR&type=renewable&${WINDOW_QS}`);
    const data = body.data as Compare;

    expect(data.actuals.map((a) => a.value)).toEqual([130, 145, null, 160]);
  });

  // ABL-21. `forecasts` stores `target_timestamp_utc` with a 'T' separator for
  // every model except the two chronos runs, while the route used to normalise
  // its query bounds to a space. SQLite compares these as plain strings and 'T'
  // (84) > ' ' (32), so every forecast on the END date sorted above the upper
  // bound and dropped out — the chart drew actuals for the day with no forecast
  // line, no error and no empty state. Measured against the replica on
  // 2026-08-05, FR/load over a 7-day window: 1344 rows returned where 1536
  // exist. Here the whole four-hour window falls on the end date, so the old
  // code returned an empty forecast series.
  it('returns the forecasts on the end date rather than silently dropping them', async () => {
    const { body } = await get(`compare?country=FR&type=hydro_total&${WINDOW_QS}`);
    const data = body.data as Compare;

    expect(data.forecasts.map((f) => f.value)).toEqual([95, 105, 115, 125]);
    expect(data.actuals).toHaveLength(4);
  });

  // The other half of the same fix, and the one a naive repair breaks. Swapping
  // the space upper bound for a 'T' one fixes the case above but admits every
  // space-form row later in the end day, because ' ' sorts below 'T'. These two
  // FR hydro_total rows sit at 04:00 and 05:00 — past WINDOW's 03:00 end — and
  // are stored space-separated, so a 'T'-only bound would hand them back.
  it('does not pull in space-separated rows past the end of the window', async () => {
    const { body } = await get(`compare?country=FR&type=hydro_total&${WINDOW_QS}`);
    const data = body.data as Compare;

    expect(data.forecasts).toHaveLength(4);
    expect(data.forecasts.map((f) => f.value)).not.toContain(500);
    expect(data.forecasts.map((f) => f.value)).not.toContain(510);
  });

  it('returns empty series, not an error, for a type with no mapping', async () => {
    const { status, body } = await get(`compare?country=DE&type=net_position&${WINDOW_QS}`);
    expect(status).toBe(200);
    expect(body.data).toEqual({ forecasts: [], actuals: [] });
  });

  it('rejects a missing country and a missing type by name', async () => {
    const noCountry = await get(`compare?type=load&${WINDOW_QS}`);
    expect(noCountry.status).toBe(400);
    expect(noCountry.body.code).toBe('MISSING_COUNTRY');

    const noType = await get(`compare?country=DE&${WINDOW_QS}`);
    expect(noType.status).toBe(400);
    expect(noType.body.code).toBe('MISSING_FORECAST_TYPE');
  });
});

// ---------------------------------------------------------------------------
// ABL-262. This endpoint's actuals query was the last `energy_load` read in
// `server/src` with no load-quality guard, so it handed placeholder `0.0` rows
// back as measurements. Measured read-only against prod on 2026-08-12:
// `?country=MK&type=load&start=2026-08-01T00:00:00Z&end=2026-08-03T00:00:00Z`
// returned 24 actuals, all 24 of them exactly `0` MW, against MK's documented
// 543-717 MW daily peak; ES returned 33 zeros in 193, BA 3 in 25, RO 3 in 97.
//
// Both directions are asserted, because the trap here is the fix and not the
// defect: this query is generic over forecast type, and a blanket `> 0` would
// delete a measured overnight solar zero, a still-air wind zero and a
// zero-clearing price — real readings whose removal biases every renewable
// metric upward.
// ---------------------------------------------------------------------------

describe('GET /api/forecasts/compare — impossible zero load actuals', () => {
  it('withholds the placeholder hours and serves the real ones beside them', async () => {
    // PT's NEXT_DAY load is 200 / 0 / 220 / 0 — the live MK/SI shape, zeros
    // interleaved inside a single otherwise-healthy day. The two real hours
    // survive; the day is not withheld wholesale.
    const { status, body } = await get(`compare?country=PT&type=load&${NEXT_DAY_QS}`);

    expect(status).toBe(200);
    const data = body.data as Compare;
    expect(data.actuals).toEqual([
      { timestamp: '2026-07-02 00:00:00', value: 200 },
      { timestamp: '2026-07-02 02:00:00', value: 220 },
    ]);
    expect(data.actuals.map((a) => a.value)).not.toContain(0);
  });

  it('returns no actuals at all for a day that is placeholders end to end', async () => {
    // GR's NEXT_DAY load is exactly 0.0 at every hour — MK's shape, where a
    // whole 24h window served as `0` MW. An empty series is the honest answer;
    // a flat zero line is a confident claim that GR drew no power that day.
    const { status, body } = await get(`compare?country=GR&type=load&${NEXT_DAY_QS}`);

    expect(status).toBe(200);
    expect((body.data as Compare).actuals).toEqual([]);
  });

  it('still serves a measured zero solar actual', async () => {
    // BE's solar is a measured 0.0 at every hour of the window — overnight, and
    // a real reading. A blanket `> 0` guard on this query empties this series.
    const { body } = await get(`compare?country=BE&type=solar&${WINDOW_QS}`);

    const data = body.data as Compare;
    expect(data.actuals).toHaveLength(4);
    expect(data.actuals.map((a) => a.value)).toEqual([0, 0, 0, 0]);
  });

  it('still serves negative day-ahead price actuals', async () => {
    // BE's window is a genuinely negative day-ahead day. Prices below zero are
    // the strongest form of the same assertion: the guard must not reach `price`
    // at all, or this whole series disappears.
    const { body } = await get(`compare?country=BE&type=price&${WINDOW_QS}`);

    const data = body.data as Compare;
    expect(data.actuals.map((a) => a.value)).toEqual([-10, -20, -30, -40]);
  });

  it('leaves an unguarded load actual above zero exactly as it was', async () => {
    // The guard must be a filter on impossible rows, not a change to the served
    // numbers. DE's window is untouched by it.
    const { body } = await get(`compare?country=DE&type=load&${WINDOW_QS}`);

    const data = body.data as Compare;
    expect(data.actuals.map((a) => a.value)).toEqual([1000, 1100, 1200, 1300]);
  });
});
