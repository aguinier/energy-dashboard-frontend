import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { buildFixtureDb, WINDOW_QS, NEXT_DAY_QS } from '../test/fixtureDb.js';

// The router's services open the shared SQLite file at import time. Hand them
// the in-memory fixture instead, so no test can reach the real database. The
// harness is imported dynamically, below, so these mocks are registered before
// the router graph loads.
const fixtureDb = buildFixtureDb();

// ABL-399's offshore-wind case, added to THIS file's own fixture instance
// rather than to `fixtureDb.ts`.
//
// `/renewables/latest` reports each country's newest row and
// `/countries/:code/summary` counts every row it holds, so neither is bounded
// by a query window — putting these rows in the shared builder moved BE's
// "every reading is a measured zero" assertion and its record count in two
// other files. `routes/prices.test.ts` and `routes/dataFreshness.test.ts` seed
// their own rows for the same reason.
//
// The shape, measured on the replica: BE's offshore fleet draws auxiliary load,
// so the real value is NEGATIVE (BE 2026-01-14 08:00, -26.2625 MW). The frozen
// `energy_renewable` carries `DEFAULT 0` and stores a flat `0.0` instead, and
// ENTSO-E publishes a `0.0` forecast for such a zone — so the pair was `0 - 0`
// and the endpoint published a flawless offshore forecast over a full window.
{
  const gen = fixtureDb.prepare(
    'INSERT INTO energy_generation (country_code, timestamp_utc, wind_offshore_mw) VALUES (?, ?, ?)'
  );
  const frozen = fixtureDb.prepare(
    'INSERT INTO energy_renewable (country_code, timestamp_utc, wind_offshore_mw) VALUES (?, ?, ?)'
  );
  const fc = fixtureDb.prepare(
    `INSERT INTO forecasts
       (country_code, forecast_type, target_timestamp_utc, generated_at, horizon_hours, forecast_value, model_name, model_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (let h = 0; h < 4; h++) {
    const hh = String(h).padStart(2, '0');
    gen.run('BE', `2026-07-02 ${hh}:00:00`, -26.26);
    frozen.run('BE', `2026-07-02 ${hh}:00:00`, 0);
    fc.run('BE', 'wind_offshore', `2026-07-02T${hh}:00:00`, '2026-06-30 12:00:00', 12, 0, 'xgboost', 'v1');
  }
}

vi.mock('../config/database.js', () => ({ default: fixtureDb }));
vi.mock('../config/writeDatabase.js', async () => (await import('../test/noWriteDb.js')).forbidWriteDb());

const { startTestApi, clearResponseCache } = await import('../test/apiHarness.js');

type Api = Awaited<ReturnType<typeof startTestApi>>;
let api: Api;

beforeAll(async () => { api = await startTestApi(); });
afterAll(() => api.close());
beforeEach(() => clearResponseCache());

/** `forecast-comparison/<path>`, so each test reads as the URL a client sends. */
const get = (path: string) => api.get(`forecast-comparison/${path}`);

const WINDOW = WINDOW_QS;

// ---------------------------------------------------------------------------
// Validation. These run before any query, so they held even when this file
// mocked the database out entirely.
// ---------------------------------------------------------------------------

describe('GET /:countryCode/ml-accuracy — model parameter', () => {
  it('rejects an unregistered model rather than querying for it', async () => {
    // An unregistered id would return zero rows, which is indistinguishable
    // from a registered model that has no coverage here. Reject instead.
    const { status, body } = await get(`DE/ml-accuracy?${WINDOW}&forecastType=load&model=bogus`);
    expect(status).toBe(400);
    expect(body.code).toBe('UNREGISTERED_MODEL');
    expect(body.success).toBe(false);
  });

  it('rejects a model that lost its evaluation and was never registered', async () => {
    const { status, body } = await get(
      `DE/ml-accuracy?${WINDOW}&forecastType=load&model=chronos-2-V011`
    );
    expect(status).toBe(400);
    expect(body.code).toBe('UNREGISTERED_MODEL');
  });

  it('rejects a tso model on the ml accuracy endpoint', async () => {
    // tso-d1 is registered for load, but this endpoint measures ml forecasts.
    // Silently ignoring it would answer a different question than was asked.
    const { status, body } = await get(`DE/ml-accuracy?${WINDOW}&forecastType=load&model=tso-d1`);
    expect(status).toBe(400);
    expect(body.code).toBe('WRONG_MODEL_SOURCE');
  });

  it('rejects a model not registered for the requested forecast type', async () => {
    // catboost serves load, but wind_offshore registers xgboost + tso-d1 only.
    // The registry is per-type, so a valid id elsewhere is not valid here.
    const { status, body } = await get(
      `DE/ml-accuracy?${WINDOW}&forecastType=wind_offshore&model=catboost`
    );
    expect(status).toBe(400);
    expect(body.code).toBe('UNREGISTERED_MODEL');
  });

  it('names the servable alternatives so a 400 is actionable', async () => {
    const { body } = await get(`DE/ml-accuracy?${WINDOW}&forecastType=load&model=bogus`);
    expect(String(body.error)).toContain('catboost');
  });

  it('still rejects an invalid forecast type ahead of the model check', async () => {
    const { status, body } = await get(`DE/ml-accuracy?${WINDOW}&forecastType=nonsense&model=catboost`);
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_FORECAST_TYPE');
  });

  it('rejects a horizon that is neither D+1 nor D+2', async () => {
    // There is no stored forecast beyond ~D+2. Accepting horizon=3 would invite
    // an extrapolated answer to a question the data cannot support.
    const { status, body } = await get(`DE/ml-accuracy?${WINDOW}&forecastType=load&horizon=3`);
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_HORIZON');
  });
});

// ---------------------------------------------------------------------------
// Measured accuracy, end to end against the fixture database.
// ---------------------------------------------------------------------------

describe('GET /:countryCode/ml-accuracy — measured metrics', () => {
  it('returns the full envelope with per-point errors and aggregate metrics', async () => {
    const { status, body } = await get(`DE/ml-accuracy?${WINDOW}&forecastType=load&horizon=1`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual([
      { timestamp: '2026-07-01T00:00:00', forecast_value: 900, actual_value: 1000, error: 100, error_pct: 10, horizon_hours: 12 },
      { timestamp: '2026-07-01T01:00:00', forecast_value: 1000, actual_value: 1100, error: 100, error_pct: 9.09, horizon_hours: 12 },
      { timestamp: '2026-07-01T02:00:00', forecast_value: 1100, actual_value: 1200, error: 100, error_pct: 8.33, horizon_hours: 12 },
      { timestamp: '2026-07-01T03:00:00', forecast_value: 1200, actual_value: 1300, error: 100, error_pct: 7.69, horizon_hours: 12 },
    ]);
    expect(body.metrics).toEqual({
      mae: 100, mape: 8.78, wape: 8.7, rmse: 100, bias: 100, dataPoints: 4, mapeSamples: 4,
    });
    expect(body.meta).toMatchObject({
      count: 4,
      countryCode: 'DE',
      forecastType: 'load',
      horizon: 1,
      model: null,
      modelRequested: null,
      coverage: 'served',
    });
  });

  // ABL-399. The defect this issue exists for, end to end.
  //
  // BE's offshore fleet draws auxiliary load, so the real measurement is
  // NEGATIVE. The frozen `energy_renewable` carries `DEFAULT 0` on every
  // `*_mw` column and cannot express that, storing a flat `0.0`; ENTSO-E
  // publishes a `0.0` forecast for such a zone. Scored against the frozen
  // table this pair was `0 - 0`, and the endpoint published `mae: 0, rmse: 0`
  // over a full window of `dataPoints` — a flawless offshore-wind forecast, and
  // top of any ranking sorted by error. Measured on the replica 2026-08-13,
  // 3,895 offshore pairs were fabricated exactly this way and NOT ONE agreed
  // with what `energy_generation` recorded at the same instant.
  it('scores an offshore-wind pair against the real negative actual, not a fabricated zero', async () => {
    const { status, body } = await get(
      `BE/ml-accuracy?${NEXT_DAY_QS}&forecastType=wind_offshore`
    );

    expect(status).toBe(200);
    expect(body.data).toHaveLength(4);
    for (const point of body.data) {
      expect(point.actual_value).toBe(-26.26);
      expect(point.actual_value).not.toBe(0);
      // A percentage error is undefined at a non-positive actual, and must be
      // null rather than 0 — the same rule that keeps solar overnight honest.
      expect(point.error_pct).toBeNull();
    }

    // The headline: a real error, where the frozen table published none.
    expect(body.metrics.mae).toBe(26.26);
    expect(body.metrics.mae).not.toBe(0);
    expect(body.metrics.rmse).toBe(26.26);
    expect(body.metrics.bias).toBe(-26.26);
    // MAPE has no measurable sample here (no positive actual) and must be null,
    // never 0. WAPE is defined, because it divides by sum|actual|.
    expect(body.metrics.mape).toBeNull();
    expect(body.metrics.mapeSamples).toBe(0);
    expect(body.metrics.wape).toBe(100);
    expect(body.meta.coverage).toBe('served');
  });

  it('measures the newest vintage only, never a superseded run', async () => {
    // The fixture carries the same four targets from an older generated_at at
    // an absurd 1 MW. If the MAX(generated_at) dedup ever stops working, those
    // land in the metrics — so an MAE of exactly 100 is the assertion that the
    // dedup ran.
    const { body } = await get(`DE/ml-accuracy?${WINDOW}&forecastType=load&horizon=1`);
    expect((body.metrics as Record<string, unknown>).mae).toBe(100);
    expect((body.metrics as Record<string, unknown>).dataPoints).toBe(4);
  });

  it('separates D+1 from D+2 by horizon band', async () => {
    const d2 = await get(`DE/ml-accuracy?${WINDOW}&forecastType=load&horizon=2`);
    expect(d2.body.metrics).toEqual({
      mae: 200, mape: 17.56, wape: 17.39, rmse: 200, bias: 200, dataPoints: 4, mapeSamples: 4,
    });
  });

  it('covers both horizons when none is requested', async () => {
    const { body } = await get(`DE/ml-accuracy?${WINDOW}&forecastType=load`);
    // Four D+1 points at 100 MW error plus four D+2 points at 200 MW.
    expect(body.metrics).toEqual({
      mae: 150, mape: 13.17, wape: 13.04, rmse: 158.11, bias: 150, dataPoints: 8, mapeSamples: 8,
    });
    expect((body.meta as Record<string, unknown>).horizon).toBeUndefined();
  });
});

describe('GET /:countryCode/ml-accuracy — a window whose actuals are all zero', () => {
  it('returns a null MAPE and zero mapeSamples, never a flawless 0%', async () => {
    // BE's solar actuals are a measured 0.0 at every hour (overnight). The
    // forecast was wrong by 5 MW each hour — real error — but a percentage
    // error is undefined at zero. Reporting 0% here would rank BE as the most
    // accurate solar forecast in Europe.
    const { status, body } = await get(`BE/ml-accuracy?${WINDOW}&forecastType=solar&horizon=1`);

    expect(status).toBe(200);
    // WAPE abstains here too, and for the same reason rather than a different
    // one: its denominator is sum|actual|, which is 0. This is the one place
    // WAPE's robustness must not be read as an answer — a magnitude-weighted
    // error over zero magnitude is undefined, not 0% (ABL-388).
    expect(body.metrics).toEqual({
      mae: 5, mape: null, wape: null, rmse: 5, bias: -5, dataPoints: 4, mapeSamples: 0,
    });
    // The points were measured — this is not a coverage gap.
    expect((body.meta as Record<string, unknown>).coverage).toBe('served');
  });

  it('reports a null error_pct per point rather than 0', async () => {
    const { body } = await get(`BE/ml-accuracy?${WINDOW}&forecastType=solar&horizon=1`);
    const data = body.data as Array<{ actual_value: number; error: number; error_pct: number | null }>;
    expect(data).toHaveLength(4);
    for (const point of data) {
      expect(point.actual_value).toBe(0);   // measured zero, not missing
      expect(point.error).toBe(-5);
      expect(point.error_pct).toBeNull();
    }
  });
});

describe('GET /:countryCode/ml-accuracy — disjoint model coverage', () => {
  it('answers "this model does not serve this country" with nulls and no_model_coverage', async () => {
    // AT is served by xgboost; catboost has no row for it anywhere. This is a
    // normal answer, not an error — and every metric must be null so the
    // country cannot render as a flawless 0% error.
    const { status, body } = await get(`AT/ml-accuracy?${WINDOW}&forecastType=load&horizon=1&model=catboost`);

    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.metrics).toEqual({
      mae: null, mape: null, wape: null, rmse: null, bias: null, dataPoints: 0, mapeSamples: 0,
    });
    expect(body.meta).toMatchObject({
      model: 'catboost',
      modelRequested: 'catboost',
      coverage: 'no_model_coverage',
    });
  });

  it('measures the model that does serve that country', async () => {
    const { body } = await get(`AT/ml-accuracy?${WINDOW}&forecastType=load&horizon=1&model=xgboost`);
    expect(body.metrics).toMatchObject({ mae: 60, bias: 60, dataPoints: 4 });
    expect((body.meta as Record<string, unknown>).coverage).toBe('served');
    expect((body.meta as Record<string, unknown>).model).toBe('xgboost');
  });

  it('reports model: null when unpinned, rather than naming the production model', async () => {
    // Unpinned, the query really is model-agnostic — it takes the latest run
    // per timestamp whichever model produced it. AT's rows are xgboost's, and
    // catboost is production for load, so naming a model here would be a
    // fabricated attribution.
    const { body } = await get(`AT/ml-accuracy?${WINDOW}&forecastType=load&horizon=1`);
    expect((body.meta as Record<string, unknown>).model).toBeNull();
    expect((body.meta as Record<string, unknown>).modelRequested).toBeNull();
    expect(body.metrics).toMatchObject({ mae: 60, dataPoints: 4 });
  });

  it('distinguishes forecasts with no actual yet from a model that never serves here', async () => {
    // The day after the window: catboost forecast it, but no actual has landed.
    // no_paired_actuals and no_model_coverage both produce zero data points and
    // must not be collapsed into one answer.
    const { body } = await get(`DE/ml-accuracy?${NEXT_DAY_QS}&forecastType=load&horizon=1&model=catboost`);
    expect((body.metrics as Record<string, unknown>).dataPoints).toBe(0);
    expect((body.meta as Record<string, unknown>).coverage).toBe('no_paired_actuals');
  });

  it('does not score a forecast against an impossible zero actual', async () => {
    // PT's NEXT_DAY load is 200 / 0 / 220 / 0 and the forecast is a flat 210.
    // Scored over all four hours the model looks terrible — MAE 110, because
    // two of the "actuals" are placeholders worth a 210 MW error each. Scored
    // over the two real hours it is MAE 10, which is the truth.
    //
    // This is live: measured on the replica 2026-08-06, 104 ES hours and 8 SI
    // hours pair a stored ML load forecast with an actual of exactly 0.0, and
    // SI's fall inside the default 30-day window.
    const { body } = await get(`PT/ml-accuracy?${NEXT_DAY_QS}&forecastType=load&horizon=1`);
    expect(body.metrics).toMatchObject({ mae: 10, dataPoints: 2 });
  });
});

describe('GET /:countryCode — unified TSO vs ML comparison', () => {
  it('reports both providers and both horizons for the same window', async () => {
    const { status, body } = await get(`DE?${WINDOW}&forecastType=load`);
    expect(status).toBe(200);

    const data = body.data as {
      tso: Record<string, Record<string, unknown>>;
      ml: Record<string, Record<string, unknown>>;
      meta: Record<string, unknown>;
    };
    expect(data.tso.dayAhead).toMatchObject({ mae: 50, mape: 4.39, rmse: 50, dataPoints: 4 });
    expect(data.tso.weekAhead).toMatchObject({ mae: 200, mape: 17.56, rmse: 200, dataPoints: 4 });
    expect(data.ml.d1).toMatchObject({ mae: 100, mape: 8.78, rmse: 100, dataPoints: 4 });
    expect(data.ml.d2).toMatchObject({ mae: 200, mape: 17.56, rmse: 200, dataPoints: 4 });
    expect(data.meta.dataAvailability).toEqual({
      tso: { dayAhead: true, weekAhead: true },
      ml: { d1: true, d2: true },
    });
    expect(data.meta.mlModel).toBeNull();
  });

  it('pins only the ml side when a model is given, never the TSO metrics', async () => {
    // xgboost has no DE rows, so the ml side empties out — while the TSO
    // numbers, which no ml model id can affect, stay exactly as they were.
    const { body } = await get(`DE?${WINDOW}&forecastType=load&model=xgboost`);
    const data = body.data as {
      tso: Record<string, Record<string, unknown>>;
      ml: Record<string, unknown>;
      meta: Record<string, unknown>;
    };
    expect(data.tso.dayAhead).toMatchObject({ mae: 50, dataPoints: 4 });
    expect(data.ml).toEqual({});
    expect(data.meta.dataAvailability).toMatchObject({ ml: { d1: false, d2: false } });
    expect(data.meta.mlModel).toBe('xgboost');
  });

  it('omits a provider with no data instead of reporting it at zero error', async () => {
    // GR has no forecast of any kind. Absent beats a zero-filled block.
    const { body } = await get(`GR?${WINDOW}&forecastType=load`);
    const data = body.data as { tso: unknown; ml: unknown; meta: Record<string, unknown> };
    expect(data.tso).toEqual({});
    expect(data.ml).toEqual({});
    expect(data.meta.dataAvailability).toEqual({
      tso: { dayAhead: false, weekAhead: false },
      ml: { d1: false, d2: false },
    });
  });
});

describe('GET /:countryCode/best', () => {
  it('picks the lowest measured MAPE across providers and horizons', async () => {
    // TSO day-ahead at 4.39 beats ml D+1 at 8.78 and both D+2 series at 17.56.
    const { status, body } = await get(`DE/best?${WINDOW}&forecastType=load`);
    expect(status).toBe(200);
    expect(body.data).toEqual({ provider: 'tso', horizon: 'day_ahead', mape: 4.39 });
    expect(body.meta).toMatchObject({ countryCode: 'DE', forecastType: 'load', mlModel: null });
  });

  it('returns null when no candidate has a measurable MAPE', async () => {
    // BE's solar actuals are all zero, so every candidate's MAPE is null. A
    // null MAPE is not a measurement and cannot be ranked — the honest answer
    // is "no best", not whichever provider happened to sort first.
    const { body } = await get(`BE/best?${WINDOW}&forecastType=solar`);
    expect(body.data).toBeNull();
  });

  it('echoes the pinned ml model id back', async () => {
    const { body } = await get(`DE/best?${WINDOW}&forecastType=load&model=catboost`);
    expect((body.meta as Record<string, unknown>).mlModel).toBe('catboost');
  });
});

describe('GET /:countryCode/rolling', () => {
  const ROLLING = 'start=2026-06-20T00:00:00Z&end=2026-07-01T00:00:00Z';

  it('emits a point only for days whose window actually contains data', async () => {
    const { status, body } = await get(`DE/rolling?${ROLLING}&forecastType=load&windowDays=7`);
    expect(status).toBe(200);

    const data = body.data as Array<{ date: string; tso?: Record<string, unknown>; ml_d1?: Record<string, unknown> }>;
    expect(data).toHaveLength(1);
    expect(data[0].date).toBe('2026-07-01');
    expect(data[0].tso).toEqual({ mape: 4.39, mae: 50 });
    expect(data[0].ml_d1).toEqual({ mape: 8.78, mae: 100 });
    expect(body.windowDays).toBe(7);
  });

  it('drops the ml series but keeps TSO when the pinned model has no rows', async () => {
    const { body } = await get(`DE/rolling?${ROLLING}&forecastType=load&windowDays=7&model=xgboost`);
    const data = body.data as Array<{ tso?: unknown; ml_d1?: unknown; ml_d2?: unknown }>;
    expect(data).toHaveLength(1);
    expect(data[0].tso).toEqual({ mape: 4.39, mae: 50 });
    expect(data[0].ml_d1).toBeUndefined();
    expect(data[0].ml_d2).toBeUndefined();
    expect((body.meta as Record<string, unknown>).mlModel).toBe('xgboost');
  });

  it('clamps windowDays to the supported 1-30 range', async () => {
    const { body } = await get(`DE/rolling?${ROLLING}&forecastType=load&windowDays=999`);
    expect(body.windowDays).toBe(30);
  });
});

describe('GET /:countryCode/summary', () => {
  it('spans every forecast type without being swallowed by the /:countryCode route', async () => {
    const { status, body } = await get(`DE/summary?${WINDOW}`);
    expect(status).toBe(200);

    const data = body.data as Record<string, { ml: Record<string, Record<string, unknown>> }>;
    expect(Object.keys(data)).toEqual(['load', 'price', 'solar', 'wind_onshore', 'wind_offshore']);
    expect(data.load.ml.d1).toMatchObject({ mae: 100, mape: 8.78, dataPoints: 4 });
    // DE has no price forecast in the fixture — an empty block, not zeros.
    expect(data.price.ml).toEqual({});
    expect(body.meta).toMatchObject({ countryCode: 'DE' });
  });
});
