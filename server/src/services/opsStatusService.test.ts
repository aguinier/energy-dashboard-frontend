import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ABL-657 — `getOpsStatus()` must not throw when the database cannot be read.
 *
 * WHY THIS IS A UNIT TEST WITH THE DB LAYER MOCKED OUT
 *
 * The failure being pinned is a *thrown* database read, and the only honest
 * ways to produce one are to hold a real exclusive write lock on a real file or
 * to make the read throw. `routes/opsStatus.test.ts` already drives this
 * endpoint against a real fixture database and covers the happy path; what it
 * cannot do is make that fixture fail on demand. Mocking the two DB-touching
 * modules is the whole point here, not a shortcut around one.
 *
 * The error strings below are the two real ones, measured 2026-09-03 against
 * the acceptance replica while `sync-db-v2.ps1` held its Stage 2 transaction:
 * a reader on the Windows host sees `SQLITE_BUSY`, and a reader inside the
 * container over the same bind mount sees `SQLITE_READONLY_ROLLBACK` — the
 * mount hides the host writer's lock, so SQLite reads the journal as hot and
 * tries to roll it back on a readonly handle.
 */

const getAllCountries = vi.fn();
const getDataFreshness = vi.fn();

vi.mock('./countryService.js', () => ({ getAllCountries: () => getAllCountries() }));
vi.mock('./dataFreshnessService.js', () => ({
  getDataFreshness: (cc: string, now: Date) => getDataFreshness(cc, now),
}));

const { getOpsStatus } = await import('./opsStatusService.js');

const LIVE_STREAM = { latest: '2026-09-03T12:00:00', ageHours: 1, status: 'live' as const };
const LIVE_COUNTRY = {
  load: LIVE_STREAM,
  price: LIVE_STREAM,
  generation: LIVE_STREAM,
  tsoLoadForecast: LIVE_STREAM,
  tsoGenerationForecast: LIVE_STREAM,
};

beforeEach(() => {
  vi.clearAllMocks();
  getAllCountries.mockReturnValue([{ country_code: 'DE' }, { country_code: 'FR' }]);
  getDataFreshness.mockReturnValue(LIVE_COUNTRY);
});

const NOW = new Date('2026-09-03T14:48:09.499Z');

describe('getOpsStatus freshness section', () => {
  it('reports the measured rollup, with no `unmeasured` marker, when the database reads', () => {
    const { freshness } = getOpsStatus(NOW);

    expect(freshness.unmeasured).toBeUndefined();
    expect(freshness.status).toBe('live');
    expect(freshness.countriesChecked).toBe(2);
    expect(freshness.streamsChecked).toBe(10);
  });

  it.each([
    ['SQLITE_READONLY_ROLLBACK, as the container sees it', 'attempt to write a readonly database'],
    ['SQLITE_BUSY, as a host-side reader sees it', 'database is locked'],
  ])('does not throw when the country list fails — %s', (_label, message) => {
    getAllCountries.mockImplementation(() => {
      throw Object.assign(new Error(message), { code: 'SQLITE_READONLY_ROLLBACK' });
    });

    const status = getOpsStatus(NOW);

    expect(status.freshness.unmeasured).toBe(message);
    expect(status.freshness.countriesChecked).toBe(0);
    expect(status.freshness.streamsChecked).toBe(0);
    expect(status.freshness.staleCountries).toEqual([]);
  });

  it('does not throw when a per-country read fails partway through the fleet', () => {
    // The lock can land between countries as easily as before the first one.
    getDataFreshness.mockImplementationOnce(() => LIVE_COUNTRY).mockImplementationOnce(() => {
      throw new Error('attempt to write a readonly database');
    });

    expect(getOpsStatus(NOW).freshness.unmeasured).toBe('attempt to write a readonly database');
  });

  it('never reports a partial fleet as a finished measurement', () => {
    // The half-built rollup is discarded, not returned: "DE is live, and we
    // never got to FR" would render as a clean one-country fleet.
    getDataFreshness.mockImplementationOnce(() => LIVE_COUNTRY).mockImplementationOnce(() => {
      throw new Error('database is locked');
    });

    const { freshness } = getOpsStatus(NOW);
    expect(freshness.counts).toEqual({ live: 0, stale: 0, ended: 0, none: 0 });
    expect(freshness.countriesChecked).toBe(0);
  });

  it('keeps every other section of the payload measured — an unreadable DB costs one KPI, not the endpoint', () => {
    // This is the actual regression. `/api/ops/status` is what the peer poll and
    // the alert engine's local read both call, and `reachable` is decided by
    // whether it answers at all — so one throwing KPI reported a live, serving
    // process as an unreachable *environment* (ABL-634: 172 errors in six days).
    getAllCountries.mockImplementation(() => {
      throw new Error('attempt to write a readonly database');
    });

    const status = getOpsStatus(NOW);

    expect(status.timestamp).toBe(NOW.toISOString());
    expect(status.provenance.db_path).toEqual(expect.any(String));
    expect(status.process.memory.rssBytes).toBeGreaterThan(0);
    expect(status.host.platform).toBe(process.platform);
    expect(status.visitors.countingSince).toEqual(expect.any(String));
  });

  it('carries the failure reason verbatim rather than a generic label', () => {
    // The message is the only thing that separates "planned replica swap" from
    // "the file is gone" for whoever reads the alert.
    getAllCountries.mockImplementation(() => {
      throw new Error('SQLITE_CANTOPEN: unable to open database file');
    });

    expect(getOpsStatus(NOW).freshness.unmeasured).toBe(
      'SQLITE_CANTOPEN: unable to open database file',
    );
  });

  it('handles a non-Error throw without losing the reason', () => {
    getAllCountries.mockImplementation(() => {
      throw 'better-sqlite3 threw a string';
    });

    expect(getOpsStatus(NOW).freshness.unmeasured).toBe('better-sqlite3 threw a string');
  });
});
