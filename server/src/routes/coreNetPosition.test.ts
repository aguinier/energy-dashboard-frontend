import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import Database, { type Database as DatabaseType } from 'better-sqlite3';

/**
 * A small, standalone in-memory fixture rather than an extension of
 * `test/fixtureDb.ts`. `core_net_position` is unrelated to the six-country
 * failure-shape story that shared fixture encodes (see its own doc comment),
 * and this route reads nothing else besides `countries` — a dedicated fixture
 * keeps that large, carefully-curated file untouched.
 *
 * The values are real. Every Core figure below was fetched live from
 * `https://publicationtool.jao.eu/core/api/data/netPos` on 2026-08-12 for
 * 2026-08-09, and every all-coupled figure quoted in a comment was read from
 * the replica's `net_position` for the same hour.
 */
function buildFixtureDb(): DatabaseType {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE core_net_position (
      country_code TEXT NOT NULL,
      timestamp_utc TEXT NOT NULL,
      net_position_mw REAL NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (country_code, timestamp_utc)
    )
  `);
  db.exec(`CREATE TABLE countries (country_code TEXT PRIMARY KEY, country_name TEXT NOT NULL)`);
  const country = db.prepare('INSERT INTO countries VALUES (?, ?)');
  for (const [code, name] of [
    ['FR', 'France'],
    ['DE', 'Germany'],
    ['LU', 'Luxembourg'],
    ['ES', 'Spain'],
    ['GB', 'United Kingdom'],
  ]) {
    country.run(code, name);
  }

  const insert = db.prepare(
    `INSERT INTO core_net_position (country_code, timestamp_utc, net_position_mw, fetched_at) VALUES (?, ?, ?, ?)`
  );
  const FETCHED = '2026-08-12T06:00:00.000Z';
  // France's four published quarters for 2026-08-09 08:00 UTC. Mean -368.9 MW
  // — an IMPORTER — against an all-coupled +1,494.575 MW for the same hour.
  // This is the sign-disagreement case ABL-219 exists to surface, and the one
  // that catches a toggle wired to the wrong table.
  insert.run('FR', '2026-08-09 08:00:00', -114.9, FETCHED);
  insert.run('FR', '2026-08-09 08:15:00', -624.8, FETCHED);
  insert.run('FR', '2026-08-09 08:30:00', 174.8, FETCHED);
  insert.run('FR', '2026-08-09 08:45:00', -910.7, FETCHED);
  // Germany, same four quarters. Mean 9,423.875 — identical to its
  // all-coupled hourly value, which is exactly why DE proves nothing about
  // whether the toggle is wired at all.
  insert.run('DE', '2026-08-09 08:00:00', 7594.9, FETCHED);
  insert.run('DE', '2026-08-09 08:15:00', 9583.5, FETCHED);
  insert.run('DE', '2026-08-09 08:30:00', 9676.6, FETCHED);
  insert.run('DE', '2026-08-09 08:45:00', 10840.5, FETCHED);
  return db;
}

const fixtureDb = buildFixtureDb();
vi.mock('../config/database.js', () => ({ default: fixtureDb }));
vi.mock('../config/writeDatabase.js', async () => (await import('../test/noWriteDb.js')).forbidWriteDb());

const { startTestApi, clearResponseCache } = await import('../test/apiHarness.js');

type Api = Awaited<ReturnType<typeof startTestApi>>;
let api: Api;

beforeAll(async () => { api = await startTestApi(); });
afterAll(() => api.close());
beforeEach(() => clearResponseCache());

const WINDOW_QS = 'start=2026-08-09T00:00:00Z&end=2026-08-09T23:59:59Z';
const get = (path: string) => api.get(`core-net-position/${path}`);

type Series = {
  actual: Array<Record<string, unknown>>;
  meta: Record<string, unknown>;
};

describe('GET /api/core-net-position/:countryCode', () => {
  it('serves a Core zone, preserving the published sign', async () => {
    const { status, body } = await get(`FR?${WINDOW_QS}`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const data = body.data as Series;
    expect(data.meta.coverage).toBe('served');
    expect(data.meta.in_core).toBe(true);
    expect(data.actual).toEqual([
      { timestamp: '2026-08-09T08:00:00', net_position_mw: -114.9 },
      { timestamp: '2026-08-09T08:15:00', net_position_mw: -624.8 },
      { timestamp: '2026-08-09T08:30:00', net_position_mw: 174.8 },
      { timestamp: '2026-08-09T08:45:00', net_position_mw: -910.7 },
    ]);
    expect((body.meta as Record<string, unknown>).count).toBe(4);
  });

  it('resolves LU to the DE_LU zone stored under DE, same as /net-position', async () => {
    const { body } = await get(`LU?${WINDOW_QS}`);
    const data = body.data as Series;
    expect(data.meta.in_core).toBe(true);
    expect(data.meta.bidding_zone).toBe('DE_LU');
    expect(data.actual).toHaveLength(4);
  });

  it('answers out_of_core for a country the Core region never covers', async () => {
    // Not `no_data`: we hold a perfectly good all-coupled net position for
    // Spain. Calling that a data gap would be a confident falsehood in words
    // rather than in a number.
    const { status, body } = await get(`ES?${WINDOW_QS}`);
    expect(status).toBe(200);
    const data = body.data as Series;
    expect(data.actual).toEqual([]);
    expect(data.meta.coverage).toBe('out_of_core');
    expect(data.meta.in_core).toBe(false);
  });

  it('answers out_of_core for GB, never a fabricated point', async () => {
    const { body } = await get(`GB?${WINDOW_QS}`);
    const data = body.data as Series;
    expect(data.actual).toEqual([]);
    expect(data.meta.coverage).toBe('out_of_core');
  });

  it('distinguishes an empty window on a Core zone from a non-Core zone', async () => {
    const { body } = await get(`PL?${WINDOW_QS}`);
    const data = body.data as Series;
    expect(data.actual).toEqual([]);
    // Same empty array as ES above, different claim — which is the entire
    // reason this endpoint returns a coverage word at all.
    expect(data.meta.coverage).toBe('no_data');
    expect(data.meta.in_core).toBe(true);
  });

  it('requires start and end', async () => {
    const { status, body } = await get('FR');
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });
});

describe('GET /api/core-net-position/map', () => {
  it('is matched as the map route, not as a country code', async () => {
    // `/map` is declared before `/:countryCode`; if that order is ever lost,
    // this returns an out_of_core series for a country called "map".
    const { status, body } = await get(`map?${WINDOW_QS}`);
    expect(status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('averages the window and keeps France an importer', async () => {
    const { body } = await get(`map?${WINDOW_QS}`);
    const rows = body.data as Array<{ country_code: string; value: number }>;
    // -368.9 rounded. Sampling a single quarter instead of averaging would
    // give -910.7 or +174.8 — and the latter colours France an exporter.
    expect(rows.find((r) => r.country_code === 'FR')?.value).toBe(-369);
  });

  it('carries LU at the DE_LU value rather than leaving it to the hatch', async () => {
    const { body } = await get(`map?${WINDOW_QS}`);
    const rows = body.data as Array<{ country_code: string; value: number }>;
    expect(rows.find((r) => r.country_code === 'DE')?.value).toBe(9424);
    expect(rows.find((r) => r.country_code === 'LU')?.value).toBe(9424);
  });

  it('omits every non-Core country entirely', async () => {
    // The client renders their absence as "outside the Core region"; the
    // server must not invent a row for them.
    const { body } = await get(`map?${WINDOW_QS}`);
    const rows = body.data as Array<{ country_code: string }>;
    expect(rows.map((r) => r.country_code).sort()).toEqual(['DE', 'FR', 'LU']);
  });

  it('requires start and end', async () => {
    const { status, body } = await get('map');
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });
});
