import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { buildFixtureDb } from '../test/fixtureDb.js';

// The router's services open the shared SQLite file at import time. Hand them
// the in-memory fixture instead, so no test can reach the real database.
const fixtureDb = buildFixtureDb();

// One duplicate instant, added to THIS FILE'S copy of the fixture rather than
// to the shared builder — `energy_renewable` is still read by four other
// services, and a duplicate row is exactly what several of their tests are
// measured against not having.
//
// It is the real defect in miniature (ABL-324): BE's 00:00 reading stored a
// second time under the `T` spelling, with a different solar value. Measured
// on the replica 2026-08-13 the frozen table carries 34,440 such surplus rows,
// BA alone holding 65,868 rows for 48,766 distinct instants. A row count over
// that table is not an instant count, and `getCountrySummary` published it as
// one.
fixtureDb
  .prepare(
    `INSERT INTO energy_renewable
       (country_code, timestamp_utc, solar_mw, wind_onshore_mw, wind_offshore_mw, total_renewable_mw)
     VALUES ('BE', '2026-07-01T00:00:00', 7, 0, NULL, 7)`
  )
  .run();

// Two single-table countries, so `/with-data` can say WHICH generation table
// its third leg reads rather than being a no-op assertion. Real ENTSO-E codes,
// deliberately absent from this fixture's `countries` table — the UNION does
// not join it, and that is the behaviour under test.
fixtureDb
  .prepare(
    `INSERT INTO energy_generation (country_code, timestamp_utc, solar_mw)
     VALUES ('ES', '2026-07-01 00:00:00', 500)`
  )
  .run();
fixtureDb
  .prepare(
    `INSERT INTO energy_renewable (country_code, timestamp_utc, solar_mw, total_renewable_mw)
     VALUES ('IT', '2026-07-01 00:00:00', 400, 400)`
  )
  .run();
vi.mock('../config/database.js', () => ({ default: fixtureDb }));
vi.mock('../config/writeDatabase.js', async () => (await import('../test/noWriteDb.js')).forbidWriteDb());

const { startTestApi, clearResponseCache } = await import('../test/apiHarness.js');

type Api = Awaited<ReturnType<typeof startTestApi>>;
let api: Api;

beforeAll(async () => { api = await startTestApi(); });
afterAll(() => api.close());
beforeEach(() => clearResponseCache());

const get = (path: string) => api.get(`countries/${path}`);

type Summary = {
  country_code: string;
  load: { from: string; to: string; records: number } | null;
  price: { from: string; to: string; records: number } | null;
  renewable: { from: string; to: string; records: number } | null;
};

// ---------------------------------------------------------------------------
// ABL-262, item 4. `getCountrySummary` reported MIN/MAX/COUNT over raw
// `energy_load`, which is the ABL-60 defect in a second place: `MAX` dates our
// coverage from a placeholder, so `to` claims a reading in an hour holding a
// `0.0`. Measured on the replica 2026-08-07, SI's raw MAX was
// `2026-08-07 00:15` with `load_mw = 0` against a guarded MAX of `00:00`.
// ---------------------------------------------------------------------------

describe('GET /api/countries/:code/summary — measured load coverage', () => {
  it('dates coverage from the last measurement, not the last placeholder', async () => {
    // GR published 300 and 310 at 00:00/01:00 and then went silent; its
    // NEXT_DAY rows are exactly 0.0 at all four hours. The raw MAX is
    // 2026-07-02 03:00 — a day and two hours of coverage GR never measured.
    const { status, body } = await get('GR/summary');

    expect(status).toBe(200);
    const data = body.data as Summary;
    expect(data.load).toEqual({
      from: '2026-07-01 00:00:00',
      to: '2026-07-01 01:00:00',
      records: 2,
    });
    expect(data.load?.to).not.toBe('2026-07-02 03:00:00');
  });

  it('counts measured rows, so records agrees with the range beside it', async () => {
    // PT holds 4 real hours on day one and 200 / 0 / 220 / 0 on day two. A raw
    // COUNT reports 8 records inside a 6-record span — a payload that
    // contradicts itself, and the number a consumer would size a backfill from.
    const { body } = await get('PT/summary');

    const data = body.data as Summary;
    expect(data.load).toEqual({
      from: '2026-07-01 00:00:00',
      to: '2026-07-02 02:00:00',
      records: 6,
    });
  });

  it('leaves a country with no placeholder rows untouched', async () => {
    const { body } = await get('DE/summary');

    const data = body.data as Summary;
    expect(data.load).toEqual({
      from: '2026-07-01 00:00:00',
      to: '2026-07-01 03:00:00',
      records: 4,
    });
  });

  it('does not apply the load rule to price or renewable', async () => {
    // BE's window is negative day-ahead prices throughout and a measured 0.0
    // solar at every hour. Both are real measurements; only `load` is a
    // strictly positive quantity, and the guard must not leak across tables.
    const { body } = await get('BE/summary');

    const data = body.data as Summary;
    expect(data.price).toMatchObject({ records: 4 });
    expect(data.renewable).toMatchObject({ records: 4 });
  });
});

// ---------------------------------------------------------------------------
// ABL-352 / ABL-324 tranche 2. The `renewable` block reported MIN/MAX/COUNT(*)
// over the frozen `energy_renewable`, which stores one instant under several
// timestamp spellings — so `records` counted rows where it claimed to count
// readings, and the endpoint overstated our own coverage. It reads
// `energy_generation` now: same single A75 fetch, 0 duplicate instants across
// 3,178,270 rows on the replica.
// ---------------------------------------------------------------------------

describe('GET /api/countries/:code/summary — renewable coverage counts instants', () => {
  it('is not inflated by a duplicate instant in the frozen table', async () => {
    // This file's fixture carries a fifth BE `energy_renewable` row: 00:00
    // again, spelled with a `T` and holding a different solar value. The old
    // query returned 5 for a country that published 4 hours. The count comes
    // from `energy_generation` now, so it stays 4 — and the duplicate cannot
    // reach it.
    const { body } = await get('BE/summary');

    const data = body.data as Summary;
    expect(data.renewable).toEqual({
      from: '2026-07-01 00:00:00',
      to: '2026-07-01 03:00:00',
      records: 4,
    });
  });

  it('reports coverage for a country the frozen table holds nothing for', async () => {
    // PT has four `energy_generation` rows and no `energy_renewable` row at
    // all, so this block was `null` before the move. We do hold four A75
    // documents for PT; every production column in them is NULL, which the
    // /renewables endpoints serve as nulls rather than zeros. Coverage
    // metadata answers "which instants do we hold", so it reports them.
    const { body } = await get('PT/summary');

    const data = body.data as Summary;
    expect(data.renewable).toEqual({
      from: '2026-07-01 00:00:00',
      to: '2026-07-01 03:00:00',
      records: 4,
    });
  });

  it('ends coverage where the country stopped publishing', async () => {
    // GR went silent after 01:00 and has two generation rows, not four.
    const { body } = await get('GR/summary');

    const data = body.data as Summary;
    expect(data.renewable).toEqual({
      from: '2026-07-01 00:00:00',
      to: '2026-07-01 01:00:00',
      records: 2,
    });
  });

  it('reports null, not a zero-record block, for a country with no rows', async () => {
    // AT is mid-backfill: no `energy_generation` rows anywhere. `records > 0`
    // is what gates the block, so this must stay null rather than becoming a
    // confident span of zero readings.
    const { body } = await get('AT/summary');

    expect((body.data as Summary).renewable).toBeNull();
  });

  it('answers with nulls rather than an error for a country holding nothing', async () => {
    // LU is in `countries` with no rows in any energy table. Three nulls, not a
    // 404 and not a zero-filled block.
    const { status, body } = await get('LU/summary');

    expect(status).toBe(200);
    const data = body.data as Summary;
    expect(data).toEqual({
      country_code: 'LU',
      load: null,
      price: null,
      renewable: null,
    });
  });
});

describe('GET /api/countries/with-data', () => {
  it('lists a country on presence, not on measurement quality', async () => {
    // Deliberately unguarded, unlike the summary above: this is a picker's
    // membership question and returns no value a chart can render. GR's load is
    // half placeholders and it still belongs here — it has real rows too, as do
    // all 11 countries carrying placeholder zeros on the replica.
    const { status, body } = await get('with-data');

    expect(status).toBe(200);
    expect(body.data).toContain('GR');
    expect(body.data).toContain('PT');
    // LU has no rows in any of the three tables, so it is genuinely absent.
    expect(body.data).not.toContain('LU');
  });

  it('takes its generation leg from energy_generation, not the frozen table', async () => {
    // ABL-352 / ABL-324 tranche 2. ES exists only in `energy_generation` and
    // IT only in `energy_renewable`; nothing else in this fixture separates
    // the two tables, since every country in both has load rows as well.
    //
    // This site was never duplicate-exposed — `DISTINCT country_code` cannot
    // be inflated by duplicate instants — and on live data the move is a
    // no-op: both tables hold exactly the same 34 codes on the replica
    // (2026-08-13), and the whole UNION returns the identical 36 either way.
    // It moves so that no read path is left on the frozen table.
    const { body } = await get('with-data');

    expect(body.data).toContain('ES');
    expect(body.data).not.toContain('IT');
  });
});
