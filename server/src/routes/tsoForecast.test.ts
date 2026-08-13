import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { buildFixtureDb, WINDOW_QS, NEXT_DAY_QS, HOURS, at, atT } from '../test/fixtureDb.js';

// Same pattern as dashboard.test.ts: the router's services open the shared
// SQLite file at import time, so hand them the in-memory fixture instead.
const fixtureDb = buildFixtureDb();
vi.mock('../config/database.js', () => ({ default: fixtureDb }));
vi.mock('../config/writeDatabase.js', async () => (await import('../test/noWriteDb.js')).forbidWriteDb());

/**
 * ABL-324 tranche 3 (ABL-353): rows this file adds to its own copy of the
 * fixture, not to `fixtureDb.ts`.
 *
 * They exist to make a revert of `getGenerationForecastAccuracy` back to
 * `energy_renewable` fail loudly. Both shapes are ones the frozen table
 * answers *confidently and wrongly*, so a test that only seeded
 * `energy_generation` would pass under either table and guard nothing.
 *
 * They are local rather than shared because `energy_renewable` is still read
 * by five other services (`crossCountryMetricsService`, `mlForecastService`,
 * `forecastService`, `dashboardService`, `countryService`) and both AT and PT
 * are asserted on by six other route tests — the same reasoning
 * `prices.test.ts` and `dataFreshness.test.ts` already apply to their own
 * clock-relative rows.
 */
function seedTranche3Shapes(db: ReturnType<typeof buildFixtureDb>): void {
  const renewable = db.prepare(
    `INSERT INTO energy_renewable
       (country_code, timestamp_utc, solar_mw, wind_onshore_mw, wind_offshore_mw)
     VALUES (?, ?, ?, ?, ?)`
  );
  const forecast = db.prepare(
    `INSERT INTO energy_generation_forecast
       (country_code, target_timestamp_utc, solar_mw, wind_onshore_mw, wind_offshore_mw,
        total_forecast_mw, forecast_type)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  // PT — the fabricated-actual shape, and the one that was publishing a
  // flawless score. PT's `energy_generation` rows exist but report nothing
  // (every column NULL). `energy_renewable` cannot express that: its columns
  // carry `DEFAULT 0`, so the same non-reporting reads as a measured `0.0`.
  // Paired against a `0.0` forecast that is a real number, the old join
  // produces 4 points at zero error — `mae: 0, rmse: 0` — a claim to have
  // measured something rather than a small error.
  //
  // (The fixture's PT is the all-NULL country; real Portugal does report
  // offshore wind, 48,587 pairs. The shape is what matters here, not the
  // country.) Measured fleet-wide on the replica 2026-08-13, it accounted for
  // 436,069 of wind_offshore's 661,077 pairs, and for the 23 countries that
  // report no offshore wind at all it was 100% of theirs.
  HOURS.forEach((h) => renewable.run('PT', at(h), 0, 0, 0));
  HOURS.forEach((h) => forecast.run('PT', at(h), 0, 0, 0, 0, 'day_ahead'));

  // AT — the coverage-hole shape (ABL-323/ABL-328). AT deliberately has no
  // `energy_generation` rows at all, while `energy_renewable` has real,
  // non-zero readings. Those hours must render as absent points, never as a
  // zero and never interpolated. Measured on the replica, the live instance is
  // FR 2026-07-01..07-22 (2,073 rows) plus BA (92).
  HOURS.forEach((h, i) => renewable.run('AT', at(h), 40 + i * 10, 500, null));
  HOURS.forEach((h, i) => forecast.run('AT', at(h), 30 + i * 10, 480, null, 510 + i * 10, 'day_ahead'));

  // DE — a variant-spelled actual, the defect this issue is named for. The
  // instant is already covered by DE's space-form `energy_generation` row, so
  // this row adds no information; it exists to prove the read path is not
  // consulting a table that holds 90,636 rows a space-form forecast can never
  // string-match.
  renewable.run('DE', atT(1), 9999, 9999, 9999);
}
seedTranche3Shapes(fixtureDb);

const { startTestApi, clearResponseCache } = await import('../test/apiHarness.js');

type Api = Awaited<ReturnType<typeof startTestApi>>;
let api: Api;

beforeAll(async () => { api = await startTestApi(); });
afterAll(() => api.close());
beforeEach(() => clearResponseCache());

const get = (path: string) => api.get(`tso-forecast/${path}`);
const WINDOW = WINDOW_QS;
const NEXT_DAY = NEXT_DAY_QS;

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
    expect(body.metrics).toEqual({ mae: 50, mape: 4.39, rmse: 50, dataPoints: 4, mapeSamples: 4, basis: 'comparable', basisNote: null });
    expect(body.meta).toMatchObject({ count: 4, forecastType: 'day_ahead', model: 'tso-d1', modelRequested: null });
  });

  it('measures the week-ahead series when asked for it by model id', async () => {
    const { body } = await get(`accuracy/load/DE?${WINDOW}&model=tso-d7`);
    expect(body.metrics).toEqual({ mae: 200, mape: 17.56, rmse: 200, dataPoints: 4, mapeSamples: 4, basis: 'comparable', basisNote: null });
    expect((body.meta as Record<string, unknown>).forecastType).toBe('week_ahead');
  });

  it('returns nulls, not zeros, for a zone with no TSO forecast at all', async () => {
    // GR publishes nothing here. Zeros would read as a flawless forecast.
    const { status, body } = await get(`accuracy/load/GR?${WINDOW}`);
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.metrics).toEqual({ mae: null, mape: null, rmse: null, dataPoints: 0, mapeSamples: 0, basis: 'comparable', basisNote: null });
  });
});

describe('GET /accuracy/generation/:countryCode', () => {
  it('measures a solar day-ahead forecast against actual output', async () => {
    // Actuals come from `energy_generation` (ABL-353), where DE's solar is a
    // flat 100 MW; the forecast ramps 90/110/130/150. Errors +10/-10/-30/-50
    // => MAE 25, RMSE 30, and MAPE 25 on a 100 MW actual.
    //
    // These numbers moved with the table. Under the frozen `energy_renewable`
    // DE's solar ramps 100/120/140/160, which tracked the forecast exactly
    // 10 MW behind and gave MAE 10 / MAPE 7.93. That the same country and
    // window yields two different accuracy figures depending on which actuals
    // table is read is the whole of ABL-324 in miniature — and the fixture
    // encodes the disagreement rather than smoothing it away.
    const { status, body } = await get(`accuracy/generation/DE?${WINDOW}&type=solar`);
    expect(status).toBe(200);
    expect(body.metrics).toEqual({ mae: 25, mape: 25, rmse: 30, dataPoints: 4, mapeSamples: 4 });
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

describe('generation accuracy reads energy_generation, not the frozen table (ABL-353)', () => {
  it('publishes no score for a type the country does not report, rather than a flawless 0', async () => {
    // PT reports no production type at all: every `energy_generation` column
    // is NULL. `energy_renewable` stores that same non-reporting as `0.0`
    // (DEFAULT 0), and against a `0.0` forecast the old join scored it as four
    // perfectly-forecast points.
    //
    // `mae: 0` over `dataPoints: 4` is not a small error — it is a claim to
    // have measured something, and it ranks PT top of any accuracy board. The
    // honest answer is that there is nothing to measure.
    const { status, body } = await get(`accuracy/generation/PT?${WINDOW}&type=wind_offshore`);
    expect(status).toBe(200);
    expect(body.metrics).toEqual({ mae: null, mape: null, rmse: null, dataPoints: 0, mapeSamples: 0 });
    expect(body.data).toEqual([]);
  });

  it('renders an hour absent from energy_generation as a gap, never as a zero', async () => {
    // AT has real, non-zero `energy_renewable` readings and no
    // `energy_generation` rows at all — the ABL-323/ABL-328 coverage cost,
    // signed off under ABL-324. The required behaviour is an absent point.
    // Nothing may substitute 0, carry the previous value forward, or
    // interpolate across the hole.
    const { body } = await get(`accuracy/generation/AT?${WINDOW}&type=solar`);
    expect(body.data).toEqual([]);
    expect(body.metrics).toMatchObject({ mae: null, rmse: null, dataPoints: 0 });
  });

  it('does not consult a variant-spelled actual, at either granularity', async () => {
    // DE carries a T-separated `energy_renewable` row at 01:00 holding an
    // absurd 9999 MW. A read that touched the frozen table would either drop
    // the hour (string equality against a space-form forecast) or, in the
    // aggregated branch, average the 9999 into the bucket. Neither may happen.
    const hourly = await get(`accuracy/generation/DE?${WINDOW}&type=solar`);
    expect(hourly.body.data).toHaveLength(4);
    expect(hourly.body.data.map((d: { actual_value: number }) => d.actual_value)).toEqual([100, 100, 100, 100]);

    const daily = await get(`accuracy/generation/DE?${WINDOW}&type=solar&granularity=daily`);
    expect(daily.body.data).toHaveLength(1);
    expect(daily.body.data[0].actual_value).toBe(100);
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
    expect(data.load).toEqual({ mae: 50, mape: 4.39, rmse: 50, dataPoints: 4, mapeSamples: 4, basis: 'comparable', basisNote: null });
    // solar moved with the actuals table (ABL-353) — see the accuracy test
    // above for the arithmetic. wind_onshore did not: DE reads a flat 200 MW
    // in both tables, so it is the control showing the move is not a blanket
    // shift of every number on this route.
    expect(data.solar).toEqual({ mae: 25, mape: 25, rmse: 30, dataPoints: 4, mapeSamples: 4 });
    expect(data.wind_onshore).toEqual({ mae: 10, mape: 5, rmse: 10, dataPoints: 4, mapeSamples: 4 });
    expect(data.wind_offshore).toEqual({ mae: null, mape: null, rmse: null, dataPoints: 0, mapeSamples: 0 });
  });

  it('nulls every type for a zone that stopped publishing', async () => {
    const { body } = await get(`metrics/GR?${WINDOW}`);
    const data = body.data as Record<string, Record<string, unknown>>;
    for (const type of ['load', 'solar', 'wind_onshore', 'wind_offshore']) {
      // `load` carries the basis verdict (ABL-277); the generation types have
      // no such rule, so their shape is unchanged.
      expect(data[type]).toEqual({
        mae: null, mape: null, rmse: null, dataPoints: 0, mapeSamples: 0,
        ...(type === 'load' ? { basis: 'comparable', basisNote: null } : {}),
      });
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

describe('divergent forecast basis (ABL-277)', () => {
  it('publishes no error measure for NL, whose two series measure different quantities', async () => {
    // NL pairs all four hours against a forecast at 2x the actual. Nothing is
    // missing — the numbers are withheld because the difference is a
    // definitional gap, not forecast error.
    const { body } = await get(`accuracy/load/NL?${NEXT_DAY}`);
    expect(body.metrics.mae).toBeNull();
    expect(body.metrics.mape).toBeNull();
    expect(body.metrics.rmse).toBeNull();
  });

  it('keeps the pairing counts, so the answer cannot read as "no data"', async () => {
    const { body } = await get(`accuracy/load/NL?${NEXT_DAY}`);
    expect(body.metrics.dataPoints).toBe(4);
    expect(body.metrics.mapeSamples).toBe(4);
    expect(body.data).toHaveLength(4);
  });

  it('says why, in words, on the response itself', async () => {
    const { body } = await get(`accuracy/load/NL?${NEXT_DAY}`);
    expect(body.meta.basis).toBe('divergent_basis');
    expect(body.meta.basisNote).toContain('behind-the-meter solar');
  });

  it('still measures DE, so the rule is not a blanket kill switch', async () => {
    const { body } = await get(`accuracy/load/DE?${WINDOW}`);
    expect(body.meta.basis).toBe('comparable');
    expect(body.meta.basisNote).toBeNull();
    expect(body.metrics.mae).toBe(50);
  });

  it('suppresses the same country on the aggregate /metrics route', async () => {
    // The rule lives in the service, not the route, so every consumer of
    // getLoadForecastAccuracyMetrics inherits it.
    const { body } = await get(`metrics/NL?${NEXT_DAY}`);
    expect(body.data.load.mape).toBeNull();
    expect(body.data.load.basis).toBe('divergent_basis');
  });

  it('keeps NL out of the horizon bars rather than drawing an uninterpretable one', async () => {
    // /forecast-comparison/:cc/summary reads the same service; buildHorizonBars
    // drops a bar whose mape is null, so the TSO D+1 bar simply is not there.
    const { body } = await api.get(`forecast-comparison/NL?${NEXT_DAY}&forecastType=load`);
    expect(body.data.tso.dayAhead.mape).toBeNull();
  });

  it('nulls MAE, RMSE and bias there too, rather than coercing them to a flawless 0', async () => {
    // Measured on the replica before this fix: NL's summary reported
    // `mae: 0, rmse: 0` beside `bias: 2435.22`. Bias is the worst of the four
    // — a clean systematic over-forecast the TSO could supposedly correct,
    // when it is the behind-the-meter solar the two series disagree about.
    const { body } = await api.get(`forecast-comparison/NL?${NEXT_DAY}&forecastType=load`);
    const da = body.data.tso.dayAhead;
    expect(da.mae).toBeNull();
    expect(da.rmse).toBeNull();
    expect(da.bias).toBeNull();
    expect(da.dataPoints).toBe(4);
  });

  it("keeps DE's summary numbers intact", async () => {
    const { body } = await api.get(`forecast-comparison/DE?${WINDOW}&forecastType=load`);
    const da = body.data.tso.dayAhead;
    expect(da.mae).toBe(50);
    expect(da.bias).toBe(-50); // forecast 50 MW under the actual at every hour
  });
});
