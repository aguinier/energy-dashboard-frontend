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

const get = (path: string) => api.get(`net-position/${path}`);

describe('GET /api/net-position/:countryCode', () => {
  it('returns actuals and the forecast band in one payload', async () => {
    const { status, body } = await get(`BE?${WINDOW_QS}`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const data = body.data as {
      actual: Array<Record<string, unknown>>;
      forecast: Array<Record<string, unknown>>;
      meta: Record<string, unknown>;
    };

    // A net importer is negative. The sign is the whole meaning of the metric.
    expect(data.actual).toEqual([
      { timestamp: '2026-07-01T00:00:00', net_position_mw: -200 },
      { timestamp: '2026-07-01T01:00:00', net_position_mw: -200 },
      { timestamp: '2026-07-01T02:00:00', net_position_mw: -200 },
      { timestamp: '2026-07-01T03:00:00', net_position_mw: -200 },
    ]);
    expect(data.forecast[0]).toEqual({
      timestamp: '2026-07-01T00:00:00',
      p50: -190,
      p10: -260,
      p90: -120,
      generated_at: '2026-06-30T18:00:00',
      horizon_hours: 40,
    });
    expect(data.meta).toMatchObject({
      bidding_zone: 'BE',
      model_name: 'chronos-2-V010',
      has_band: true,
      last_seen: '2026-07-01T03:00:00',
    });
    expect((body.meta as Record<string, unknown>).count).toBe(8);
  });

  it('summarises the serving vintage rather than blending runs', async () => {
    const { body } = await get(`BE?${WINDOW_QS}`);
    const meta = (body.data as { meta: Record<string, unknown> }).meta;
    expect(meta.vintages).toEqual([
      {
        generated_at: '2026-06-30T18:00:00',
        model_version: 'V010',
        horizon_hours_min: 40,
        horizon_hours_max: 40,
        target_count: 4,
        first_target: '2026-07-01T00:00:00',
        last_target: '2026-07-01T03:00:00',
      },
    ]);
  });

  it('resolves Luxembourg to the DE_LU zone instead of its own artifact rows', async () => {
    // LU carries ~180 rows of its own from before the zone mapping existed
    // (-6201 MW in the fixture). Net positions are published per bidding zone,
    // and LU's is DE_LU — stored under 'DE'. Reading LU's own rows would show
    // Luxembourg contradicting Germany for one shared zone.
    const { body } = await get(`LU?${WINDOW_QS}`);
    const data = body.data as { actual: Array<{ net_position_mw: number }>; meta: Record<string, unknown> };
    expect(data.meta.bidding_zone).toBe('DE_LU');
    expect(data.actual.map((a) => a.net_position_mw)).toEqual([100, 150, 200, 250]);
  });
});

describe('GET /api/net-position/:countryCode — a zone that stopped publishing', () => {
  it('returns only the hours that were published, with no gap-filling', async () => {
    // GR goes silent after 01:00 — the shape GR and IE have had since
    // 2026-03-14. Two points, not four, and no carried-forward last value.
    const { body } = await get(`GR?${WINDOW_QS}`);
    const data = body.data as { actual: Array<Record<string, unknown>>; meta: Record<string, unknown> };
    expect(data.actual).toEqual([
      { timestamp: '2026-07-01T00:00:00', net_position_mw: -50 },
      { timestamp: '2026-07-01T01:00:00', net_position_mw: -60 },
    ]);
    expect(data.meta.last_seen).toBe('2026-07-01T01:00:00');
  });

  it('still names the date it stopped when the window is entirely after the silence', async () => {
    // This is what separates "nothing in the last 7 days" from "this zone
    // stopped publishing on <date>". Inside the window the two look identical;
    // only last_seen — deliberately unbounded by the query window — can tell
    // them apart, so the tab can say why the chart is empty instead of
    // spinning forever.
    const { status, body } = await get(`GR?${NEXT_DAY_QS}`);
    expect(status).toBe(200);
    const data = body.data as { actual: unknown[]; forecast: unknown[]; meta: Record<string, unknown> };
    expect(data.actual).toEqual([]);
    expect(data.forecast).toEqual([]);
    expect(data.meta.last_seen).toBe('2026-07-01T01:00:00');
  });

  it('reports last_seen as null for a zone that has never published', async () => {
    // Never published and stopped publishing are different facts. Null here is
    // "no date to name", not a fabricated one.
    const { body } = await get(`PT?${WINDOW_QS}`);
    const data = body.data as { actual: unknown[]; meta: Record<string, unknown> };
    expect(data.actual).toEqual([]);
    expect(data.meta.last_seen).toBeNull();
  });

  it('reports no model rather than an empty forecast attributed to one', async () => {
    // PT has no Chronos run on file at all. model_name must be null — naming
    // the registered model beside an empty series would imply it forecast
    // nothing, which is a different fact from "it was never asked to".
    const { body } = await get(`PT?${WINDOW_QS}`);
    const meta = (body.data as { meta: Record<string, unknown> }).meta;
    expect(meta.model_name).toBeNull();
    expect(meta.vintages).toEqual([]);
    expect(meta.has_band).toBe(false);
    expect(meta.forecast_coverage).toBe('no_forecast');
    expect(meta.degenerate_forecast).toBeNull();
  });
});

describe('GET /api/net-position/:countryCode — a forecast that collapsed to zero', () => {
  it('withholds GR’s numerically-zero series instead of serving a flat line at 0 MW', async () => {
    // ABL-25. Charted, GR's forecast is a perfectly flat line at 0 MW under a
    // hairline p10-p90 band, which reads as an unusually CONFIDENT forecast —
    // and nothing contradicts it, because GR publishes no actuals and pairs no
    // points into any accuracy metric.
    const { status, body } = await get(`GR?${WINDOW_QS}`);
    expect(status).toBe(200);
    const data = body.data as { forecast: unknown[]; meta: Record<string, unknown> };

    expect(data.forecast).toEqual([]);
    expect(data.meta.forecast_coverage).toBe('degenerate_zero');
    expect(data.meta.degenerate_forecast).toEqual({
      points: 4,
      // The band's p90 ceiling — the largest magnitude anywhere in the series.
      max_abs_mw: 0.003754783421754837,
    });
  });

  it('still names the model that produced the withheld rows', async () => {
    // The opposite of the PT case above: here the model DID run and returned
    // values, so naming it is the honest half of the answer. `vintages` and
    // `has_band` empty out with the series — the client captions the chart
    // from them ("N runs on screen", "shaded band = p10-p90"), so leaving them
    // populated would move the confident lie into the subtitle.
    const { body } = await get(`GR?${WINDOW_QS}`);
    const meta = (body.data as { meta: Record<string, unknown> }).meta;
    expect(meta.model_name).toBe('chronos-2-V010');
    expect(meta.vintages).toEqual([]);
    expect(meta.has_band).toBe(false);
  });

  it('does not suppress a country whose forecast is real', async () => {
    // The rule must cost nothing anywhere else. BE's series is served whole.
    const { body } = await get(`BE?${WINDOW_QS}`);
    const data = body.data as { forecast: unknown[]; meta: Record<string, unknown> };
    expect(data.forecast).toHaveLength(4);
    expect(data.meta.forecast_coverage).toBe('served');
    expect(data.meta.degenerate_forecast).toBeNull();
  });
});

describe('GET /api/net-position/:countryCode — actuals that collapsed to zero', () => {
  it('withholds GR’s exactly-zero published rows instead of drawing them', async () => {
    // ABL-35, and a different defect from the forecast one above even though
    // the symptom rhymes. GR's net_position did not stop on 2025-10-01 — it
    // turned into exact 0.0 and has stayed there for all 192 rows published
    // since, while GR's own crossborder_flows show a median net export of
    // 1,142 MW over the very same hours. Drawn, that is a flat line at 0 MW
    // labelled "ENTSO-E day-ahead": a measurement, wrong by a gigawatt.
    const { status, body } = await get(`GR?${NEXT_DAY_QS}`);
    expect(status).toBe(200);
    const data = body.data as { actual: unknown[]; meta: Record<string, unknown> };

    expect(data.actual).toEqual([]);
    expect(data.meta.actual_coverage).toBe('degenerate_zero');
    expect(data.meta.degenerate_actual).toEqual({ points: 4, max_abs_mw: 0 });
  });

  it('dates the outage from the last USABLE hour, not the last row', async () => {
    // The newest GR row in the fixture is 2026-07-02 03:00 and it is a zero.
    // Reporting that as last_seen tells the user the series was healthy until
    // July; the last hour GR published a measurement is 2026-07-01 01:00.
    const { body } = await get(`GR?${NEXT_DAY_QS}`);
    const meta = (body.data as { meta: Record<string, unknown> }).meta;
    expect(meta.last_seen).toBe('2026-07-01T01:00:00');
  });

  it('serves GR’s own real hours in the earlier window', async () => {
    // Same country, same table, different window: the rule is on the series,
    // not on the country, so GR before the collapse is untouched.
    const { body } = await get(`GR?${WINDOW_QS}`);
    const data = body.data as { actual: unknown[]; meta: Record<string, unknown> };
    expect(data.actual).toHaveLength(2);
    expect(data.meta.actual_coverage).toBe('served');
    expect(data.meta.degenerate_actual).toBeNull();
  });

  it('does not suppress a country whose actuals are real', async () => {
    const { body } = await get(`BE?${WINDOW_QS}`);
    const data = body.data as { actual: unknown[]; meta: Record<string, unknown> };
    expect(data.actual).toHaveLength(4);
    expect(data.meta.actual_coverage).toBe('served');
    expect(data.meta.degenerate_actual).toBeNull();
  });
});

describe('GET /api/net-position/:countryCode — required window', () => {
  it('rejects a request with no start/end', async () => {
    // Note this route hand-rolls its 400 rather than throwing AppError, so the
    // envelope carries no `code` — unlike every other 400 in the API.
    const { status, body } = await get('DE');
    expect(status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: 'start and end query parameters are required',
    });
  });

  it('rejects a half-supplied window', async () => {
    const { status } = await get('DE?start=2026-07-01T00:00:00Z');
    expect(status).toBe(400);
  });
});
