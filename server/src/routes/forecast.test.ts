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

  // ABL-399 moved these actuals from the frozen `energy_renewable` onto
  // `energy_generation`. FR's generation rows report `hydro_run_mw` 100 and no
  // `hydro_reservoir_mw` at all — the shape Belgium has fleet-wide, where
  // `hydro_reservoir_mw` is NULL in all 49,213 rows because BE has no reservoir
  // fleet.
  it('sums the reported hydro components rather than reading a nonexistent hydro_mw', async () => {
    const { status, body } = await get(`compare?country=FR&type=hydro_total&${WINDOW_QS}`);

    expect(status).toBe(200);
    const data = body.data as Compare;
    expect(data.actuals).toEqual([
      { timestamp: '2026-07-01 00:00:00', value: 100 },
      { timestamp: '2026-07-01 01:00:00', value: 100 },
      { timestamp: '2026-07-01 02:00:00', value: 100 },
      { timestamp: '2026-07-01 03:00:00', value: 100 },
    ]);
  });

  // The reduction is null-aware in BOTH directions, and each half is the fix
  // for the other's failure. This is the half that keeps a real reading:
  // a NULL-propagating `a + b` would answer NULL for every one of BE's 49,213
  // hours and drop Belgium's hydro accuracy from 5,121 pairs to zero —
  // discarding real run-of-river measurements to express an absence that is a
  // property of Belgium's fleet, not of our data.
  it('keeps a reported hydro component when its sibling is not reported', async () => {
    const { body } = await get(`compare?country=FR&type=hydro_total&${WINDOW_QS}`);
    const data = body.data as Compare;

    // hydro_run_mw = 100 is reported; hydro_reservoir_mw is not.
    expect(data.actuals[2].value).toBe(100);
    expect(data.actuals[2].value).not.toBeNull();
  });

  // ...and this is the other half. PT's `energy_generation` rows exist but
  // every column is NULL — the country reports no production type at all. That
  // must not reduce to a confident `0`, and with the `IS NOT NULL` filter it is
  // an absent point rather than a `{ value: null }` one, so no consumer writing
  // `value ?? 0` can turn "we hold no reading" into "it generated nothing".
  it('serves no actual at all where every component is unreported', async () => {
    for (const type of ['renewable', 'hydro_total']) {
      const { status, body } = await get(`compare?country=PT&type=${type}&${WINDOW_QS}`);
      expect(status).toBe(200);
      expect((body.data as Compare).actuals, type).toEqual([]);
    }
  });

  // A measured zero is a value, not a missing reading — the distinction the
  // frozen table's `DEFAULT 0` destroyed in the other direction. BE's solar is
  // 0.0 at every hour (overnight), and must survive as 0.
  it('keeps a measured zero rather than dropping it as missing', async () => {
    const { body } = await get(`compare?country=BE&type=renewable&${WINDOW_QS}`);
    const data = body.data as Compare;

    expect(data.actuals).toHaveLength(4);
    expect(data.actuals.map((a) => a.value)).toEqual([0, 0, 0, 0]);
  });

  // `renewable` is the type with no counterpart column: `total_renewable_mw`
  // was a stored computed column on the frozen table. FR reports solar 0 and
  // hydro_run 100 and nothing else renewable, so the total is 100 — pumped
  // storage (-300) is a store and is excluded, which is what keeps this figure
  // equal to the one /renewables serves for the same hour.
  it('derives renewable as a null-aware sum over energy_generation', async () => {
    const { body } = await get(`compare?country=FR&type=renewable&${WINDOW_QS}`);
    const data = body.data as Compare;

    expect(data.actuals.map((a) => a.value)).toEqual([100, 100, 100, 100]);
  });

  // The cost of the move, and it must render as a gap. AT has no
  // `energy_generation` rows at all — the shape of the FR 2026-07-01..22 hole
  // (ABL-323/ABL-328), where the frozen table holds 2,073 rows and
  // energy_generation holds none. Never a zero, never carried forward.
  it('renders an energy_generation coverage hole as absent, never as zero', async () => {
    const { status, body } = await get(`compare?country=AT&type=solar&${WINDOW_QS}`);

    expect(status).toBe(200);
    expect((body.data as Compare).actuals).toEqual([]);
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

// ---------------------------------------------------------------------------
// ABL-319. Serving-readiness probe for ABL-316, which trains up to ~40 new
// per-country generation models. The question this block answers is whether a
// newly trained country/stream pair reaches the dashboard on its own, or whether
// something between the `forecasts` table and the chart gates by country.
//
// Traced end to end on 2026-08-12 against the replica, DE `wind_offshore`:
// nothing on the serving side gates by country. `getForecastData` filters on
// country_code / forecast_type / model_name only, `resolveModelCandidates` is
// keyed by stream and never sees a country, `getAvailableForecastTypes` is a
// plain SELECT DISTINCT over the rows that exist, and no client component
// carries a country allowlist. DE offshore is missing because it was never
// written: `models/DE/wind_offshore` holds only un-promoted variant
// subdirectories, with no top-level `model.joblib` for `Forecaster.load` to
// open, so `forecast_daily.py` skips the pair. The gate is the write path.
//
// So there is no fix to land, and these tests pin the property instead — the
// one that has to hold for the ABL-316 retrains to light up without a code
// change, and the one whose silent loss would be found only after 40 retrains.
//
// Both directions are asserted, because "serves when rows exist" is only half of
// it. The other half is what a country WITHOUT rows does, and the failure this
// dashboard exists to prevent is the confident wrong number: an offshore chart
// that renders a flat zero line for Germany, or a 500, rather than nothing.
// ---------------------------------------------------------------------------

describe('GET /api/forecasts — serving is data-driven, not country-gated', () => {
  it('serves a country that has rows for the stream', async () => {
    const { status, body } = await get(`?country=BE&type=wind_offshore&${WINDOW_QS}`);

    expect(status).toBe(200);
    expect(body.data).toHaveLength(4);
    expect((body.data as Array<{ value: number }>).map((p) => p.value)).toEqual([700, 710, 720, 730]);
    // Nothing in the registry pins offshore per country — BE resolves through
    // the same stream-keyed ladder every other country would.
    expect((body.data as Array<{ model_name: string }>).every((p) => p.model_name === 'xgboost')).toBe(true);
  });

  it('degrades to an empty series for a country with no rows, rather than erroring', async () => {
    // DE, the production case. A 500 here would be a bug; a zero-valued point
    // would be an incident.
    const { status, body } = await get(`?country=DE&type=wind_offshore&${WINDOW_QS}`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
    expect((body.meta as Record<string, unknown>).count).toBe(0);
    // No model is claimed to have served, because none did.
    expect((body.meta as Record<string, unknown>).model).toBeNull();
  });

  it('does not gate the country — the same country serves a stream it does have', async () => {
    // The control. If DE's empty offshore response came from a country-level
    // block rather than from absent rows, this would be empty too. Length is
    // deliberately not pinned: unfiltered by horizon this returns DE's D+1 and
    // D+2 vintages both, which is a separate property with its own tests.
    const { status, body } = await get(`?country=DE&type=load&${WINDOW_QS}`);

    expect(status).toBe(200);
    expect((body.data as unknown[]).length).toBeGreaterThan(0);
  });

  it('derives the available-type list from the rows that exist', async () => {
    // This is the mechanism by which a newly trained model becomes reachable:
    // `getAvailableForecastTypes` is SELECT DISTINCT over `forecasts`, so the
    // first row written for DE/wind_offshore adds the type with no code change.
    // It also had no test at all before this one.
    const be = await get(`types?country=BE`);
    const de = await get(`types?country=DE`);

    expect(be.status).toBe(200);
    expect(be.body.data).toContain('wind_offshore');
    expect(de.body.data).not.toContain('wind_offshore');
    // ...and DE is a fully served country otherwise, so absence is per-stream.
    expect(de.body.data).toContain('load');
  });

  it('returns nothing for a registered model that nothing has ever written', async () => {
    // A registry entry whose `model_name` no writer produces is dead: an
    // explicit request is honoured strictly (`resolveModelCandidates`), so it
    // resolves to that model and finds no rows. Measured on the replica
    // 2026-08-12, both wind shadow candidates are in exactly this state —
    // `xgboost-retrain-v1` and `catboost-retrain-v1` have zero rows fleet-wide.
    //
    // Pinned as an empty series rather than a substitution: answering with
    // xgboost's numbers under the retrain-v1 label is the failure mode
    // `resolveAccuracyModel` already refuses for accuracy.
    const { status, body } = await get(
      `?country=BE&type=wind_offshore&model=xgboost-retrain-v1&${WINDOW_QS}`
    );

    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect((body.meta as Record<string, unknown>).modelRequested).toBe('xgboost-retrain-v1');
    expect((body.meta as Record<string, unknown>).model).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ABL-501 — a forecast on a different basis from the actuals it is drawn
// against is withheld, not plotted.
//
// The live defect: `GET /api/forecasts?country=NL&type=load` served catboost's
// gross-basis prediction, and `LoadTab` drew it as a dashed line over a
// realized series published net of behind-the-meter solar. Measured through a
// local server on the replica 2026-08-20 for market day 2026-08-05, that put
// 9,431 MW on the chart against a realized 4,361 MW at 12:00 — while the same
// model at 03:00 the same day read 9,801 against 9,909, which is what makes it
// a basis gap and not a bad model.
// ---------------------------------------------------------------------------
describe('GET /api/forecasts — divergent forecast basis (ABL-501)', () => {
  it('withholds NL load and says how many rows it is holding', async () => {
    const { status, body } = await get(`?country=NL&type=load&${NEXT_DAY_QS}`);

    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    const meta0 = body.meta as Record<string, unknown>;
    expect(meta0.basis).toBe('divergent_basis');
    expect(meta0.basisNote).toContain('behind-the-meter solar');
    // Four rows exist and are being held back. `count: 0` alone would be
    // indistinguishable from a country nobody forecasts.
    expect(meta0.withheldPoints).toBe(4);
    expect(meta0.count).toBe(0);
  });

  it('still names the model whose rows were withheld', async () => {
    // The honest half of the answer, and what separates this from the no-rows
    // case where there is no model to name. Read before the withholding, not
    // off the empty array afterwards.
    const { body } = await get(`?country=NL&type=load&${NEXT_DAY_QS}`);
    expect((body.meta as Record<string, unknown>).model).toBe('catboost');
  });

  it('leaves NL price alone — the finding is about the load pair only', async () => {
    // Gated on the forecast type. Nothing has been measured about NL's price
    // pair, and blanking it would be a second false claim in the other
    // direction (generation-side divergence is ABL-400, still open).
    const { status, body } = await get(`?country=NL&type=price&${NEXT_DAY_QS}`);

    expect(status).toBe(200);
    expect((body.data as unknown[]).length).toBe(4);
    const meta1 = body.meta as Record<string, unknown>;
    expect(meta1.basis).toBe('comparable');
    expect(meta1.basisNote).toBeNull();
    expect(meta1.withheldPoints).toBe(0);
  });

  it('leaves every other country\'s load alone', async () => {
    const { status, body } = await get(`?country=DE&type=load&${NEXT_DAY_QS}`);

    expect(status).toBe(200);
    expect((body.data as unknown[]).length).toBeGreaterThan(0);
    const meta2 = body.meta as Record<string, unknown>;
    expect(meta2.basis).toBe('comparable');
    expect(meta2.withheldPoints).toBe(0);
  });

  it('withholds a pinned model too, not just the ladder\'s pick', async () => {
    // The rule is a property of NL's realized series, so it cannot be escaped
    // by naming a model — which is also why the picker's comparison mode is
    // covered without a second code path.
    const { body } = await get(`?country=NL&type=load&model=catboost&${NEXT_DAY_QS}`);
    expect(body.data).toEqual([]);
    expect((body.meta as Record<string, unknown>).withheldPoints).toBe(4);
  });
});

describe('GET /api/forecasts/compare — divergent forecast basis (ABL-501)', () => {
  it('withholds the forecast and keeps the realized series', async () => {
    // The forecasts go, the actuals stay: this endpoint's claim is that the
    // two arrays are the same quantity, so it is the pairing that is false.
    // The realized load is a true measurement, and dropping it would assert a
    // gap in data we hold in full.
    const { status, body } = await get(`compare?country=NL&type=load&${NEXT_DAY_QS}`);

    expect(status).toBe(200);
    const data = body.data as Compare;
    expect(data.forecasts).toEqual([]);
    expect(data.actuals.map((a) => a.value)).toEqual([900, 700, 500, 300]);
    const meta3 = body.meta as Record<string, unknown>;
    expect(meta3.basis).toBe('divergent_basis');
    expect(meta3.withheldPoints).toBe(4);
  });

  it('is unchanged for a comparable country', async () => {
    const { body } = await get(`compare?country=DE&type=load&${WINDOW_QS}`);
    const data = body.data as Compare;
    expect(data.forecasts.length).toBeGreaterThan(0);
    const meta4 = body.meta as Record<string, unknown>;
    expect(meta4.basis).toBe('comparable');
    expect(meta4.withheldPoints).toBe(0);
  });
});

describe('GET /api/forecasts/multi-horizon — divergent forecast basis (ABL-501)', () => {
  it('withholds NL load — splitting by horizon does not make either half comparable', async () => {
    const { status, body } = await get(`multi-horizon?country=NL&type=load&${NEXT_DAY_QS}`);

    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    const meta5 = body.meta as Record<string, unknown>;
    expect(meta5.basis).toBe('divergent_basis');
    expect(meta5.withheldPoints).toBeGreaterThan(0);
  });

  it('is unchanged for a comparable country', async () => {
    const { body } = await get(`multi-horizon?country=DE&type=load&${NEXT_DAY_QS}`);
    const meta6 = body.meta as Record<string, unknown>;
    expect(meta6.basis).toBe('comparable');
    expect(meta6.withheldPoints).toBe(0);
  });
});

/**
 * ABL-469 — the model registry endpoint now also answers "which of these is
 * the best available forecast for this country?".
 *
 * The ranking itself is measured in `services/recommendedModelService.test.ts`,
 * which seeds a multi-week history because that is what a track record needs.
 * What is pinned here is the endpoint's contract: the registry half must be
 * unchanged for every caller that does not ask, and a pair with no history
 * must still resolve to something renderable.
 */
describe('GET /api/forecasts/models — the recommendation is additive', () => {
  it('returns the bare registry when no country is asked about', async () => {
    const { status, body } = await get('models?type=load');

    expect(status).toBe(200);
    const load = (body.data as Record<string, Record<string, unknown>>).load;
    expect(load.production).toBe('catboost');
    expect(load.models).toHaveLength(4);
    // The key is absent, not null: a client on older code sees byte-identically
    // what it saw before this existed.
    expect(load).not.toHaveProperty('recommended');
  });

  it('still returns the whole registry with no type at all', async () => {
    const { status, body } = await get('models');

    expect(status).toBe(200);
    const data = body.data as Record<string, Record<string, unknown>>;
    expect(Object.keys(data).length).toBeGreaterThan(1);
    expect(data.load).not.toHaveProperty('recommended');
  });

  it('rejects a country without a type rather than ranking nine types nobody asked about', async () => {
    const { status, body } = await get('models?country=DE');

    expect(status).toBe(400);
    expect(body.code).toBe('MISSING_FORECAST_TYPE');
  });

  it('rejects an unknown forecast type', async () => {
    const { status, body } = await get('models?type=not_a_type&country=DE');

    expect(status).toBe(400);
    expect(body.code).toBe('UNKNOWN_FORECAST_TYPE');
  });

  it('carries the recommendation beside an unchanged registry when asked', async () => {
    const { status, body } = await get('models?type=load&country=DE');

    expect(status).toBe(200);
    const load = (body.data as Record<string, Record<string, unknown>>).load;
    // Registry half untouched.
    expect(load.production).toBe('catboost');
    expect(load.models).toHaveLength(4);

    const rec = load.recommended as Record<string, unknown>;
    expect(rec).toBeDefined();
    // The fixture holds four hours, which is deliberately below the evidence
    // bar — so this is the no-history fallback, and it says so.
    expect(rec.fallback).toBe(true);
    expect(rec.modelId).toBe('catboost');
    expect(rec.wape).toBeNull();
    expect(rec.windowDays).toBe(30);
    // Every registered model is still reported, each with its own reason.
    expect(rec.candidates).toHaveLength(4);
  });

  it('resolves a country with no rows at all to the production model rather than blanking', async () => {
    const { status, body } = await get('models?type=load&country=ZZ');

    expect(status).toBe(200);
    const rec = (body.data as Record<string, Record<string, unknown>>).load.recommended as Record<string, unknown>;
    expect(rec.modelId).toBe('catboost');
    expect(rec.fallback).toBe(true);
  });

  it('answers for a type nothing can be scored against, instead of failing', async () => {
    // `net_position` has no actuals source, so no accuracy path exists for it.
    const { status, body } = await get('models?type=net_position&country=DE');

    expect(status).toBe(200);
    const rec = (body.data as Record<string, Record<string, unknown>>).net_position.recommended as Record<string, unknown>;
    expect(rec.modelId).toBe('chronos-2-V010');
    expect(rec.fallback).toBe(true);
  });
});
