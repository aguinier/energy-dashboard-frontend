import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { buildFixtureDb, at } from '../test/fixtureDb.js';
import { brusselsDayStartUtc } from '../services/freshness.js';

const fixtureDb = buildFixtureDb();
vi.mock('../config/database.js', () => ({ default: fixtureDb }));
vi.mock('../config/writeDatabase.js', async () => (await import('../test/noWriteDb.js')).forbidWriteDb());

const { startTestApi, clearResponseCache } = await import('../test/apiHarness.js');

type Api = Awaited<ReturnType<typeof startTestApi>>;
let api: Api;

beforeAll(async () => { api = await startTestApi(); });
afterAll(() => api.close());
beforeEach(() => clearResponseCache());

const get = (cc: string) => api.get(`data-freshness/${cc}`);

type Stream = { latest: string | null; ageHours: number | null; status: string };
type Freshness = {
  load: Stream;
  price: Stream;
  generation: Stream;
  tsoLoadForecast: Stream;
  tsoGenerationForecast: Stream;
};

/**
 * ABL-60. A whole-pass ENTSO-E outage on 2026-08-06 stored nothing for 30
 * countries and the dashboard said nothing — it kept drawing yesterday's data
 * under a green "live" pulse. This endpoint is the only thing that could have
 * said otherwise, and it returned five bare timestamps with no verdict.
 *
 * The fixture's own rows sit at a fixed 2026-07-01/02, permanently beyond the
 * stale threshold and eventually beyond the ended threshold too. Every verdict
 * asserted here is therefore created with a now-relative row on purpose; a
 * fixed timestamp would silently change state as the suite aged.
 */

const HOUR_MS = 60 * 60 * 1000;
const spaceForm = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
const hoursAgo = (h: number) => spaceForm(new Date(Date.now() - h * HOUR_MS));

/**
 * A price row covering tomorrow's Brussels market day. Chosen so the assertion
 * holds at every hour of the day: `classifyDayAheadStream` requires today's
 * market day before 14:00 UTC and tomorrow's after it, and a row dated at
 * tomorrow's *end* satisfies both. A test whose verdict flipped at 14:00 UTC
 * would be worse than no test.
 */
const endOfTomorrowBrussels = spaceForm(
  new Date(brusselsDayStartUtc(new Date(), 2).getTime() - HOUR_MS),
);

beforeAll(() => {
  const load = fixtureDb.prepare(
    'INSERT INTO energy_load (country_code, timestamp_utc, load_mw) VALUES (?, ?, ?)'
  );
  const price = fixtureDb.prepare(
    'INSERT INTO energy_price (country_code, timestamp_utc, price_eur_mwh) VALUES (?, ?, ?)'
  );
  const generation = fixtureDb.prepare(
    'INSERT INTO energy_generation (country_code, timestamp_utc, solar_mw) VALUES (?, ?, ?)'
  );

  // DE is the healthy case: measured actuals an hour old, and a day-ahead price
  // that reaches through tomorrow. This is what the fleet looked like on
  // 2026-08-07 07:10 UTC, minutes after a successful 06:30 pass.
  load.run('DE', hoursAgo(1), 41_000);
  generation.run('DE', hoursAgo(1), 9_400);
  price.run('DE', endOfTomorrowBrussels, 72.5);

  // BE is the outage shape: its newest measurement is 20 hours old, which is
  // past the threshold whatever the hour of the run. On 2026-08-06 the whole
  // fleet looked like this and nothing said so.
  load.run('BE', hoursAgo(20), 8_800);
  generation.run('BE', hoursAgo(20), 1_200);

  // PT has a recent-enough row that still fails day-ahead coverage. Keeping it
  // below the ended threshold makes this an intentional stale case rather than
  // relying on the shared fixture's fixed July timestamps.
  price.run('PT', hoursAgo(48), 61);

  // LU deliberately gets one generation row older than the ended threshold.
  // The shared fixture dates are old too, but age-sensitive states must be
  // created on purpose so this test does not change verdict as the clock moves.
  generation.run('LU', hoursAgo(31 * 24), 200);
});

describe('GET /api/data-freshness/:cc — the pipeline states its own health', () => {
  it('reports a healthy country as live on every stream it has', async () => {
    const { status, body } = await get('DE');
    expect(status).toBe(200);

    const data = body.data as Freshness;
    expect(data.load.status).toBe('live');
    expect(data.generation.status).toBe('live');
    expect(data.price.status).toBe('live');
    expect(data.load.ageHours).toBeGreaterThan(0.9);
    expect(data.load.ageHours).toBeLessThan(1.1);
  });

  it('reports a country whose passes have stopped as stale', async () => {
    const { body } = await get('BE');
    const data = body.data as Freshness;

    expect(data.load.status).toBe('stale');
    expect(data.generation.status).toBe('stale');
    // The age is still reported. "Stale" without a magnitude is an alarm nobody
    // can act on — 20 hours and 5 years are both stale and mean different
    // things (GB's load stops in 2021).
    expect(data.load.ageHours).toBeGreaterThan(19);
  });

  it('reports a formerly-held stream that stopped upstream as ended', async () => {
    const { body } = await get('LU');
    const data = body.data as Freshness;

    expect(data.generation.status).toBe('ended');
    expect(data.generation.ageHours).toBeGreaterThan(30 * 24);
  });

  it('does not date the pipeline from an impossible zero', async () => {
    // PT carries MK's and SI's live shape: real hours interleaved with exact
    // `0.0`, newest row a zero. Measured on the replica 2026-08-07, SI's raw
    // MAX was `00:15` (load_mw = 0) against a guarded MAX of `00:00` — this
    // endpoint was the one `energy_load` read site with no `measuredLoadClause`,
    // so it dated the pipeline's health from a row no chart will draw.
    const { body } = await get('PT');
    const data = body.data as Freshness;

    expect(data.load.latest).toBe(at(2, 2)); // the 220 MW hour
    expect(data.load.latest).not.toBe(at(3, 2)); // the 0.0 hour after it
  });

  it('steps back over a whole day of zeros rather than reading one as current', async () => {
    // GR's entire NEXT_DAY is exact zeros — its real shape since 2025-10-01,
    // where the rows kept coming and the numbers stopped meaning anything. The
    // last hour GR really published is the day before.
    const { body } = await get('GR');
    const data = body.data as Freshness;

    expect(data.load.latest).toBe(at(1));
  });

  it('says "none", never "stale", for a stream that was never held', async () => {
    // AT has load rows and no generation rows at all. Calling that stale would
    // assert an outage in a series that has never existed — and would put an
    // alarm on screen that no ingest fix could ever clear.
    const { body } = await get('AT');
    const data = body.data as Freshness;

    expect(data.generation).toEqual({ latest: null, ageHours: null, status: 'none' });
    expect(data.price).toEqual({ latest: null, ageHours: null, status: 'none' });
  });

  it('judges a day-ahead price on coverage, not on age', async () => {
    // DE's newest price is dated in the FUTURE — that is what a day-ahead
    // auction result is. Under the measured rule it would read as impossibly
    // fresh forever, which is exactly why a missing tomorrow went unnoticed.
    const { body } = await get('DE');
    const price = (body.data as Freshness).price;

    expect(price.ageHours).toBeLessThan(0);
    expect(price.status).toBe('live');
  });

  it('marks a price that does not reach its market day stale, at any hour', async () => {
    // PT's only price row is 2026-07-01. Before 14:00 UTC the rule requires
    // today's market day and after it requires tomorrow's; this row reaches
    // neither, so the verdict does not depend on when the suite runs.
    const { body } = await get('PT');
    expect((body.data as Freshness).price.status).toBe('stale');
  });

  it('returns every stream, so a caller cannot silently miss one', async () => {
    const { body } = await get('DE');
    expect(Object.keys(body.data as Freshness).sort()).toEqual([
      'generation',
      'load',
      'price',
      'tsoGenerationForecast',
      'tsoLoadForecast',
    ]);
  });
});

/**
 * ABL-295 — `GET /api/data-freshness/:cc/ingest`.
 *
 * The suite above asks "how old is the newest row we hold". This one asks a
 * different question with a different source: "when did we last go and look,
 * and did anything arrive". The whole reason it is a separate endpoint is that
 * those two answers routinely disagree, and merging them produces a confident
 * claim nobody measured.
 */

type Refresh = {
  lastChecked: string | null;
  lastStoredRows: string | null;
  delivery: string;
  pipelines: string[];
};
type Ingest = {
  load: Refresh;
  price: Refresh;
  generation: Refresh;
  tsoLoadForecast: Refresh;
  tsoGenerationForecast: Refresh;
  netPosition: Refresh;
  logStartsAt: string | null;
};

const getIngest = async (cc: string) => {
  const { status, body } = await api.get(`data-freshness/${cc}/ingest`);
  return { status, data: body.data as Ingest };
};

describe('GET /api/data-freshness/:cc/ingest — when did we last refresh it', () => {
  it('reports the same instant for both stamps when the last pass delivered', async () => {
    const { status, data } = await getIngest('DE');
    expect(status).toBe(200);

    expect(data.load.delivery).toBe('flowing');
    expect(data.load.lastStoredRows).toBe(data.load.lastChecked);
    expect(data.load.lastChecked).toBe('2026-07-02T00:30:15.882895+00:00');
  });

  it('keeps "checked" and "brought data" apart when the last passes brought nothing', async () => {
    // THE case this endpoint exists for. GR was checked on the newest pass and
    // last actually delivered a day earlier. A UI showing only `lastChecked`
    // would say GR's load was refreshed on 2026-07-02; it was not.
    const { data } = await getIngest('GR');

    expect(data.load.delivery).toBe('checked_no_data');
    expect(data.load.lastChecked).toBe('2026-07-02T00:40:15.882895+00:00');
    expect(data.load.lastStoredRows).toBe('2026-07-01T00:40:15.882895+00:00');
    expect(data.load.lastStoredRows).not.toBe(data.load.lastChecked);
  });

  it('says never_delivered — with a null stamp — rather than showing the check time', async () => {
    // AT's net position passes run and have never returned a row; 14 of 36
    // production zones are in this state. There is no "last refreshed" instant
    // to render, so the field must be null and not quietly the check time.
    const { data } = await getIngest('AT');

    expect(data.netPosition.delivery).toBe('never_delivered');
    expect(data.netPosition.lastStoredRows).toBeNull();
    expect(data.netPosition.lastChecked).not.toBeNull();
  });

  it('reports not_logged for a country the log does not cover', async () => {
    // Distinct from never_delivered: the log has no record, which says nothing
    // about whether the pipeline ran.
    const { data } = await getIngest('BE');

    expect(data.load.delivery).toBe('not_logged');
    expect(data.load.lastChecked).toBeNull();
    expect(data.load.lastStoredRows).toBeNull();
  });

  it('bounds not_logged with the log\'s own start, so it cannot read as "never ran"', async () => {
    const { data } = await getIngest('BE');
    expect(data.logStartsAt).toBe('2026-07-01T00:30:15.882895+00:00');
  });

  it('merges D+1 and D+7 into the one table they both write', async () => {
    // DE's week-ahead pass has never delivered while its day-ahead twin has.
    // `energy_load_forecast` WAS refreshed, so the stream is flowing — the
    // stream describes the table, and the tab reads the table.
    const { data } = await getIngest('DE');

    expect(data.tsoLoadForecast.pipelines).toEqual([
      'load_forecast_day_ahead',
      'load_forecast_week_ahead',
    ]);
    expect(data.tsoLoadForecast.delivery).toBe('flowing');
  });

  it('ignores failed and running passes when dating the last check', async () => {
    // Both are dated after every completed DE pass. Counting a failed pass
    // would let a stream erroring four times a day report itself freshly
    // checked; counting an in-flight one would report a check that has not
    // finished.
    const { data } = await getIngest('DE');

    expect(data.load.lastChecked).toBe('2026-07-02T00:30:15.882895+00:00');
    expect(data.price.lastChecked).toBe('2026-07-02T00:31:15.882895+00:00');
  });

  it('names the pipelines behind every stream, so the answer is auditable', async () => {
    const { data } = await getIngest('DE');

    expect(data.generation.pipelines).toEqual(['renewable']);
    expect(data.tsoGenerationForecast.pipelines).toEqual(['wind_solar_forecast']);
    expect(data.netPosition.pipelines).toEqual(['net_position']);
  });

  it('returns every stream plus the log bound', async () => {
    const { data } = await getIngest('DE');
    expect(Object.keys(data).sort()).toEqual([
      'generation',
      'load',
      'logStartsAt',
      'netPosition',
      'price',
      'tsoGenerationForecast',
      'tsoLoadForecast',
    ]);
  });
});
