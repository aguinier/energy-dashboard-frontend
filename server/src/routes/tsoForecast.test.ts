import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { buildFixtureDb, WINDOW_QS } from '../test/fixtureDb.js';

// Same pattern as dashboard.test.ts: the router's services open the shared
// SQLite file at import time, so hand them the in-memory fixture instead.
const fixtureDb = buildFixtureDb();
vi.mock('../config/database.js', () => ({ default: fixtureDb }));
vi.mock('../config/writeDatabase.js', async () => (await import('../test/noWriteDb.js')).forbidWriteDb());

const { startTestApi, clearResponseCache } = await import('../test/apiHarness.js');

type Api = Awaited<ReturnType<typeof startTestApi>>;
let api: Api;

beforeAll(async () => { api = await startTestApi(); });
afterAll(() => api.close());
beforeEach(() => clearResponseCache());

const get = (path: string) => api.get(`tso-forecast/${path}`);
const WINDOW = WINDOW_QS;

describe('TSO accuracy routes — model parameter', () => {
  it('rejects an ml model on a tso accuracy endpoint', async () => {
    // catboost is registered for load, but this route measures the TSO's own
    // forecast. Ignoring the parameter would answer a different question.
    const { status, body } = await get('accuracy/load/DE?model=catboost');
    expect(status).toBe(400);
    expect(body.code).toBe('WRONG_MODEL_SOURCE');
  });

  it('rejects an unregistered model', async () => {
    const { status, body } = await get('accuracy/load/DE?model=tso-d99');
    expect(status).toBe(400);
    expect(body.code).toBe('UNREGISTERED_MODEL');
  });

  it('rejects a model/forecastType conflict rather than silently picking one', async () => {
    // tso-d7 IS week_ahead. Honouring either side quietly would label the
    // response with a horizon the caller did not ask for.
    const { status, body } = await get('accuracy/load/DE?model=tso-d7&forecastType=day_ahead');
    expect(status).toBe(400);
    expect(body.code).toBe('MODEL_HORIZON_CONFLICT');
  });

  it('accepts a model that agrees with an explicit forecastType', async () => {
    // Not a conflict — both name week_ahead, so the request is served and the
    // response is labelled with the horizon that was actually measured.
    const { status, body } = await get(`accuracy/load/DE?${WINDOW}&model=tso-d7&forecastType=week_ahead`);
    expect(status).toBe(200);
    expect(body.meta).toMatchObject({ forecastType: 'week_ahead', model: 'tso-d7', modelRequested: 'tso-d7' });
  });

  it('rejects week-ahead for a generation type that registers day-ahead only', async () => {
    // There is no week-ahead solar forecast to measure. Answering with D+1
    // would be a fabricated horizon.
    const { status, body } = await get('accuracy/generation/DE?type=solar&model=tso-d7');
    expect(status).toBe(400);
    expect(body.code).toBe('UNREGISTERED_MODEL');
  });

  it('validates the generation type before the model', async () => {
    const { status, body } = await get('accuracy/generation/DE?model=tso-d1');
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_GENERATION_TYPE');
  });
});

describe('GET /accuracy/load/:countryCode — measured metrics', () => {
  it('returns paired points and metrics for the day-ahead horizon by default', async () => {
    const { status, body } = await get(`accuracy/load/DE?${WINDOW}`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual([
      { timestamp: '2026-07-01T00:00:00Z', forecast_value: 950, actual_value: 1000, error: 50, error_pct: 5 },
      { timestamp: '2026-07-01T01:00:00Z', forecast_value: 1050, actual_value: 1100, error: 50, error_pct: 4.55 },
      { timestamp: '2026-07-01T02:00:00Z', forecast_value: 1150, actual_value: 1200, error: 50, error_pct: 4.17 },
      { timestamp: '2026-07-01T03:00:00Z', forecast_value: 1250, actual_value: 1300, error: 50, error_pct: 3.85 },
    ]);
    expect(body.metrics).toEqual({ mae: 50, mape: 4.39, rmse: 50, dataPoints: 4, mapeSamples: 4 });
    expect(body.meta).toMatchObject({ count: 4, forecastType: 'day_ahead', model: 'tso-d1', modelRequested: null });
  });

  it('measures the week-ahead series when asked for it by model id', async () => {
    const { body } = await get(`accuracy/load/DE?${WINDOW}&model=tso-d7`);
    expect(body.metrics).toEqual({ mae: 200, mape: 17.56, rmse: 200, dataPoints: 4, mapeSamples: 4 });
    expect((body.meta as Record<string, unknown>).forecastType).toBe('week_ahead');
  });

  it('returns nulls, not zeros, for a zone with no TSO forecast at all', async () => {
    // GR publishes nothing here. Zeros would read as a flawless forecast.
    const { status, body } = await get(`accuracy/load/GR?${WINDOW}`);
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.metrics).toEqual({ mae: null, mape: null, rmse: null, dataPoints: 0, mapeSamples: 0 });
  });
});

describe('GET /accuracy/generation/:countryCode', () => {
  it('measures a solar day-ahead forecast against actual output', async () => {
    const { status, body } = await get(`accuracy/generation/DE?${WINDOW}&type=solar`);
    expect(status).toBe(200);
    expect(body.metrics).toEqual({ mae: 10, mape: 7.93, rmse: 10, dataPoints: 4, mapeSamples: 4 });
    expect(body.meta).toMatchObject({ generationType: 'solar', model: 'tso-d1' });
  });

  it('returns a null MAPE when every actual is a measured zero', async () => {
    // BE's overnight solar is 0.0 at every hour. The 3 MW forecast error is
    // real (MAE 3), but no percentage is defined — and 0% would rank BE as the
    // most accurate solar forecast on the board.
    const { body } = await get(`accuracy/generation/BE?${WINDOW}&type=solar`);
    expect(body.metrics).toEqual({ mae: 3, mape: null, rmse: 3, dataPoints: 4, mapeSamples: 0 });
  });
});

describe('GET /metrics/:countryCode', () => {
  it('reports each forecast type independently, nulling the ones not reported', async () => {
    // DE reports no offshore wind: the column is NULL on both the forecast and
    // the actual side. That must surface as null/0 samples, not as a perfect
    // score sitting beside three real measurements.
    const { status, body } = await get(`metrics/DE?${WINDOW}`);
    expect(status).toBe(200);

    const data = body.data as Record<string, Record<string, unknown>>;
    expect(data.load).toEqual({ mae: 50, mape: 4.39, rmse: 50, dataPoints: 4, mapeSamples: 4 });
    expect(data.solar).toEqual({ mae: 10, mape: 7.93, rmse: 10, dataPoints: 4, mapeSamples: 4 });
    expect(data.wind_onshore).toEqual({ mae: 10, mape: 5, rmse: 10, dataPoints: 4, mapeSamples: 4 });
    expect(data.wind_offshore).toEqual({ mae: null, mape: null, rmse: null, dataPoints: 0, mapeSamples: 0 });
  });

  it('nulls every type for a zone that stopped publishing', async () => {
    const { body } = await get(`metrics/GR?${WINDOW}`);
    const data = body.data as Record<string, Record<string, unknown>>;
    for (const type of ['load', 'solar', 'wind_onshore', 'wind_offshore']) {
      expect(data[type]).toEqual({ mae: null, mape: null, rmse: null, dataPoints: 0, mapeSamples: 0 });
    }
  });
});

describe('GET /load/:countryCode', () => {
  it('returns the week-ahead band, which the day-ahead series does not carry', async () => {
    const { body } = await get(`load/DE?${WINDOW}&forecastType=week_ahead`);
    expect(body.data).toEqual([
      {
        timestamp: '2026-07-01T12:00:00Z',   // week-ahead is daily, stamped at noon
        forecast_value_mw: 950,
        forecast_min_mw: 700,
        forecast_max_mw: 1200,
        forecast_type: 'week_ahead',
        publication_timestamp_utc: null,
      },
    ]);
  });

  it('leaves the band null on the day-ahead series rather than inventing one', async () => {
    const { body } = await get(`load/DE?${WINDOW}&forecastType=day_ahead`);
    const data = body.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(4);
    for (const point of data) {
      expect(point.forecast_min_mw).toBeNull();
      expect(point.forecast_max_mw).toBeNull();
    }
  });
});
