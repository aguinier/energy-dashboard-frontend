import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { buildFixtureDb } from '../test/fixtureDb.js';

// The router's services open the shared SQLite file at import time. Hand them
// the in-memory fixture instead, so no test can reach the real database.
const fixtureDb = buildFixtureDb();
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
});
