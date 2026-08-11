import { describe, it, expect, vi } from 'vitest';
import Database, { type Database as DatabaseType } from 'better-sqlite3';

vi.mock('../config/database.js', () => ({ default: null }));

const { fetchJaoCoreNetPosition, captureCoreNetPosition } = await import('./jaoCoreNetPositionCapture.js');

/** A minimal, real-shaped two-interval response — see coreNetPositionService.test.ts for the full sample. */
function sampleResponse() {
  return {
    data: [
      { dateTimeUtc: '2026-08-09T00:00:00Z', hub_FR: 2112.1, hub_DE: 785.6, hub_ALBE: 359.0 },
      { dateTimeUtc: '2026-08-09T00:15:00Z', hub_FR: 2149.1, hub_DE: 1028.0, hub_ALBE: 405.4 },
    ],
    rejected: false,
    messages: null,
  };
}

function stubFetch(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}) {
  const { ok = true, status = 200, statusText = 'OK' } = init;
  return vi.fn(async () => ({
    ok,
    status,
    statusText,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('fetchJaoCoreNetPosition', () => {
  it('requests the exact JAO netPos URL with FromUtc/ToUtc query params', async () => {
    const fetchImpl = stubFetch(sampleResponse());
    await fetchJaoCoreNetPosition('2026-08-09T00:00:00Z', '2026-08-10T00:00:00Z', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe(
      'https://publicationtool.jao.eu/core/api/data/netPos?FromUtc=2026-08-09T00%3A00%3A00Z&ToUtc=2026-08-10T00%3A00%3A00Z'
    );
  });

  it('returns the parsed JSON body on a 200', async () => {
    const body = sampleResponse();
    const result = await fetchJaoCoreNetPosition('a', 'b', stubFetch(body));
    expect(result).toEqual(body);
  });

  it('throws with the status on a non-ok response, never silently returning an empty result', async () => {
    const fetchImpl = stubFetch({}, { ok: false, status: 503, statusText: 'Service Unavailable' });
    await expect(fetchJaoCoreNetPosition('a', 'b', fetchImpl)).rejects.toThrow(/503/);
  });
});

describe('captureCoreNetPosition', () => {
  function memDb(): DatabaseType {
    return new Database(':memory:');
  }

  it('fetches, parses, and stores in one pass, reporting parsed vs inserted counts', async () => {
    const db = memDb();
    const fetchImpl = stubFetch(sampleResponse());

    const result = await captureCoreNetPosition(db, '2026-08-09T00:00:00Z', '2026-08-10T00:00:00Z', {
      fetchImpl,
      fetchedAt: '2026-08-11T20:00:00.000Z',
    });

    // 2 intervals x 2 zone hubs each (FR, DE) — hub_ALBE is not a Core zone hub.
    expect(result).toEqual({ parsed: 4, inserted: 4 });

    const row = db
      .prepare('SELECT net_position_mw, fetched_at FROM core_net_position WHERE country_code = ? AND timestamp_utc = ?')
      .get('FR', '2026-08-09 00:00:00') as Record<string, unknown>;
    expect(row.net_position_mw).toBe(2112.1);
    expect(row.fetched_at).toBe('2026-08-11T20:00:00.000Z');
  });

  it('is idempotent: capturing the same window twice inserts nothing the second time', async () => {
    const db = memDb();
    await captureCoreNetPosition(db, 'a', 'b', { fetchImpl: stubFetch(sampleResponse()) });
    const second = await captureCoreNetPosition(db, 'a', 'b', { fetchImpl: stubFetch(sampleResponse()) });
    expect(second).toEqual({ parsed: 4, inserted: 0 });
  });

  it('propagates a fetch failure without writing anything', async () => {
    const db = memDb();
    const fetchImpl = stubFetch({}, { ok: false, status: 500, statusText: 'Internal Server Error' });
    await expect(captureCoreNetPosition(db, 'a', 'b', { fetchImpl })).rejects.toThrow(/500/);
    const count = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='core_net_position'`).get());
    // Table is never even created — the failure happens before any DB write is attempted.
    expect(count).toBeUndefined();
  });

  it('propagates a parse failure (e.g. rejected request) without writing anything', async () => {
    const db = memDb();
    const fetchImpl = stubFetch({ data: [], rejected: true, messages: ['bad range'] });
    await expect(captureCoreNetPosition(db, 'a', 'b', { fetchImpl })).rejects.toThrow(/rejected/i);
  });
});
