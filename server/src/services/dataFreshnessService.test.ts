import { describe, it, expect, beforeAll, vi } from 'vitest';
import { buildFixtureDb } from '../test/fixtureDb.js';

/**
 * ABL-717, end to end through the real SQL. The A69 verdict now reads
 * `data_ingestion_log` for *when this country was last looked at*, and still
 * reads the table for *whether tomorrow is held*. These cases use the replica's
 * own 2026-09-09 evening and the log's real stamps, so the query meets the
 * format it will actually see on prod.
 *
 * `getDataFreshness` is called with an explicit `now` because every verdict
 * here turns on the hour. `routes/dataFreshness.test.ts` covers the wiring at
 * the real clock.
 */

const fixtureDb = buildFixtureDb();
vi.mock('../config/database.js', () => ({ default: fixtureDb }));

const { getDataFreshness } = await import('./dataFreshnessService.js');

const QUARTER_HOUR_MS = 15 * 60 * 1000;

/**
 * Quarter-hourly A69 rows through `last`, written in the data tables' space
 * form. Whole days back to 08-20, so the ABL-632 coverage window behind every
 * case is complete and cannot be what moves a verdict here.
 */
function seedA69(cc: string, last: string): void {
  const insert = fixtureDb.prepare(
    `INSERT INTO energy_generation_forecast
       (country_code, target_timestamp_utc, solar_mw, wind_onshore_mw, total_forecast_mw, forecast_type)
     VALUES (?, ?, 100, 200, 300, 'day_ahead')`,
  );
  const end = Date.parse(`${last.replace(' ', 'T')}Z`);
  for (let t = Date.parse('2026-08-20T00:00:00Z'); t <= end; t += QUARTER_HOUR_MS) {
    insert.run(cc, new Date(t).toISOString().slice(0, 19).replace('T', ' '));
  }
}

/** One per-country fetch, exactly as `db.log_ingestion_start`/`_complete` write it. */
function logAttempt(
  cc: string,
  start: string,
  end: string | null,
  status: string,
  inserted: number,
  failed = 0,
  error: string | null = null,
): void {
  fixtureDb
    .prepare(
      `INSERT INTO data_ingestion_log
         (pipeline_type, country_code, start_time, end_time, status,
          records_inserted, records_updated, records_failed, error_message)
       VALUES ('wind_solar_forecast', ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(cc, start, end, status, inserted, failed, error);
}

// Under CEST the Brussels day of the 9th ends at 21:45 UTC, and the Brussels
// day of the 10th starts at 22:00 UTC on the 9th. Upstream owes the 10th by
// 18:00 Brussels on the 9th, which is 16:00 UTC.
const THROUGH_TODAY = '2026-09-09 21:45:00';
const THROUGH_TOMORROW = '2026-09-10 21:45:00';

beforeAll(() => {
  // SK — the negative control. The 18:30 pass reached it at 19:37 and stored
  // 684 rows as `completed`. Those are the replica's own DE stamps and count
  // from that evening. The table still ends at today, because 684 quarter-hours
  // from the pass's 19:00 window start run out at today's 21:45.
  seedA69('SK', THROUGH_TODAY);
  logAttempt('SK', '2026-09-09T13:39:39.020417+00:00', '2026-09-09T13:39:58.310552+00:00', 'completed', 704);
  logAttempt('SK', '2026-09-09T19:37:43.280609+00:00', '2026-09-09T19:38:27.174844+00:00', 'completed', 684);

  // SI — reached at 19:56, and that fetch did bring tomorrow.
  seedA69('SI', THROUGH_TOMORROW);
  logAttempt('SI', '2026-09-09T13:39:25.104116+00:00', '2026-09-09T13:39:37.550901+00:00', 'completed', 704);
  logAttempt('SI', '2026-09-09T19:56:35.617578+00:00', '2026-09-09T19:56:40.080310+00:00', 'completed', 780);

  // SE — only the 13:30 pass has finished with it. The 18:30 pass is fetching
  // it now, so that row has no `end_time` yet.
  seedA69('SE', THROUGH_TODAY);
  logAttempt('SE', '2026-09-09T13:39:11.448272+00:00', '2026-09-09T13:39:30.861193+00:00', 'completed', 704);
  logAttempt('SE', '2026-09-09T19:48:38.974941+00:00', null, 'running', 0);

  // FI — the post-deadline fetch errored. On 08-31, 09-01 and 09-07 every A69
  // fetch of the 18:30 pass did the same.
  seedA69('FI', THROUGH_TODAY);
  logAttempt('FI', '2026-09-09T13:35:39.207735+00:00', '2026-09-09T13:35:52.001236+00:00', 'completed', 704);
  logAttempt(
    'FI',
    '2026-09-09T20:04:18.914413+00:00',
    '2026-09-09T20:06:31.992619+00:00',
    'failed',
    0,
    1,
    'HTTP 503',
  );
});

const a69 = (cc: string, at: string) =>
  getDataFreshness(cc, new Date(at)).tsoGenerationForecast;

describe('getDataFreshness — A69 asks whether we have looked, not what time it is (ABL-717)', () => {
  it('calls A69 stale once our post-deadline fetch has looked and tomorrow is missing', () => {
    // The negative control, and the case a log-trusting rule gets wrong. The
    // log reports rows landing, `completed` and 684 inserted. The table reports
    // that none of them was tomorrow's. The verdict follows the table. Before
    // ABL-717 this read `live` until 21:00.
    const stream = a69('SK', '2026-09-09T19:45:00Z');

    expect(stream.status).toBe('stale');
    expect(stream.latest).toBe(THROUGH_TODAY);
    // The window behind it is complete. Coverage is not what makes it stale.
    expect(stream.coverage?.ratio).toBe(1);
  });

  it('leaves it live when that fetch brought tomorrow', () => {
    expect(a69('SI', '2026-09-09T20:00:00Z').status).toBe('live');
  });

  it('does not accuse a country the pass has not reached, while the pass is still on its way', () => {
    // SE's only finished attempt is the 13:30 pass's, which predates the
    // obligation. The row the 18:30 pass is writing has no `end_time` yet, so it
    // has not looked at anything. This is NOT the format guard: a space-form
    // `start_time >=` bound would let the 13:39 attempt through the SQL, but
    // `classifyDayAheadStream` re-compares parsed instants and rejects it, so
    // every test here still passes under that mutation (measured, ABL-717
    // review). The guard that does fail is the upper-bound test below (SK).
    for (const at of ['2026-09-09T17:00:00Z', '2026-09-09T19:50:00Z', '2026-09-09T20:59:00Z']) {
      expect(a69('SE', at).status).toBe('live');
    }
  });

  it('still falls back to 21:00 UTC for a country no finished attempt has reached', () => {
    // The backstop. On 08-11 and 09-03 no attempt reached 16 and 6 countries
    // all evening, and every one was a real miss.
    expect(a69('SE', '2026-09-09T21:00:00Z').status).toBe('stale');
  });

  it('counts a fetch that errored as a look, but only once it has finished', () => {
    // A 503 is still a look (ABL-637), and it brought nothing, so tomorrow is
    // missing and we know it. At 20:05 the same fetch is still in flight, and
    // an attempt that has not finished has not looked at anything.
    expect(a69('FI', '2026-09-09T20:05:00Z').status).toBe('live');
    expect(a69('FI', '2026-09-09T20:10:00Z').status).toBe('stale');
  });

  it('reads the log as of `now`, never from attempts that had not finished by then', () => {
    // This is the format guard; do not delete it believing SE covers it. The
    // upper bound is formatted like the lower one. A space-separated
    // `end_time <= ?` would sort every `T`-form stamp of the date after it and
    // exclude the 19:38 finish, which would turn the negative control above
    // back to `live`.
    expect(a69('SK', '2026-09-09T19:30:00Z').status).toBe('live'); // not yet started
    expect(a69('SK', '2026-09-09T19:38:00Z').status).toBe('live'); // started, not finished
    expect(a69('SK', '2026-09-09T19:39:00Z').status).toBe('stale');
  });

  it('leaves price and the A65 load forecast on their own clock deadline', () => {
    // Only A69 is keyed on an attempt. The same SK evening at 13:50 reads
    // exactly as it did before ABL-717 for the two streams with no rows here:
    // `none`, which is a statement about holding nothing, never an alarm.
    const data = getDataFreshness('SK', new Date('2026-09-09T13:50:00Z'));
    expect(data.price.status).toBe('none');
    expect(data.tsoLoadForecast.status).toBe('none');
    expect(data.tsoGenerationForecast.status).toBe('live');
  });
});
