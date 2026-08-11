import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import Database, { type Database as DatabaseType } from 'better-sqlite3';

/**
 * A small, standalone in-memory fixture rather than an extension of
 * `test/fixtureDb.ts`. `core_net_position` is unrelated to the six-country
 * failure-shape story that shared fixture encodes (see its own doc comment),
 * and this route reads nothing else — a dedicated fixture keeps that large,
 * carefully-curated file untouched by a feature the follow-up UI issue may
 * still reshape.
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
  const insert = db.prepare(
    `INSERT INTO core_net_position (country_code, timestamp_utc, net_position_mw, fetched_at) VALUES (?, ?, ?, ?)`
  );
  // France, 2026-08-09 — the ABL-219 research brief's own diverging case.
  insert.run('FR', '2026-08-09 00:00:00', 2112.1, '2026-08-11T20:00:00.000Z');
  insert.run('FR', '2026-08-09 08:00:00', -114.9, '2026-08-11T20:00:00.000Z');
  // Germany, same day — where Core and the all-borders figure coincide.
  insert.run('DE', '2026-08-09 00:00:00', 785.6, '2026-08-11T20:00:00.000Z');
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

describe('GET /api/core-net-position/:countryCode', () => {
  it('returns the stored points for the requested country and window', async () => {
    const { status, body } = await get(`FR?${WINDOW_QS}`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const data = body.data as { points: Array<Record<string, unknown>> };
    // The sign is the whole meaning of the metric — France is a net importer
    // in the Core figure at 08:00, which is the point ABL-219 exists to make.
    expect(data.points).toEqual([
      { timestamp: '2026-08-09T00:00:00', net_position_mw: 2112.1 },
      { timestamp: '2026-08-09T08:00:00', net_position_mw: -114.9 },
    ]);
    expect((body.meta as Record<string, unknown>).count).toBe(2);
  });

  it('resolves LU to the DE_LU zone stored under DE, same as /net-position', async () => {
    const { body } = await get(`LU?${WINDOW_QS}`);
    const data = body.data as { points: Array<{ net_position_mw: number }> };
    expect(data.points).toEqual([{ timestamp: '2026-08-09T00:00:00', net_position_mw: 785.6 }]);
  });

  it('returns an empty array for a country with no Core coverage, never a fabricated point', async () => {
    const { status, body } = await get(`GB?${WINDOW_QS}`);
    expect(status).toBe(200);
    const data = body.data as { points: unknown[] };
    expect(data.points).toEqual([]);
  });

  it('requires start and end', async () => {
    const { status, body } = await get('FR');
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });
});
