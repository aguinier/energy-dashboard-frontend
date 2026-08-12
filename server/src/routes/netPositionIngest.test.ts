import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { buildFixtureDb } from '../test/fixtureDb.js';

/**
 * Route-level coverage for the ABL-240 generalization: `forecast_type` is
 * now an optional field on the net-position ingest payload, accepted for
 * 'net_position' (the default), 'wind_onshore' and 'wind_offshore'.
 *
 * The read connection (`config/database.js`) and the write connection
 * (`config/writeDatabase.js`) are mocked onto the SAME in-memory fixture db,
 * mirroring production where both are separate handles onto one file — so a
 * write here is actually observable through the fixture, not asserted only
 * via the response body.
 */
const fixtureDb = buildFixtureDb();
vi.mock('../config/database.js', () => ({ default: fixtureDb }));
vi.mock('../config/writeDatabase.js', () => ({ getWriteDb: () => fixtureDb }));

const { startTestApi, clearResponseCache } = await import('../test/apiHarness.js');

type Api = Awaited<ReturnType<typeof startTestApi>>;
let api: Api;

const TOKEN = 'test-write-token';
const auth = { authorization: `Bearer ${TOKEN}` };

beforeAll(async () => {
  process.env.HELIO_WRITE_TOKEN = TOKEN;
  api = await startTestApi();
});
afterAll(async () => {
  await api.close();
  delete process.env.HELIO_WRITE_TOKEN;
});
beforeEach(() => {
  clearResponseCache();
  // Scoped delete: leaves the fixture's own seeded rows (other model_name/
  // generated_at values) untouched, only clears what this file writes.
  fixtureDb.exec("DELETE FROM forecasts WHERE generated_at = '2026-08-11 09:00:00.000000'");
  fixtureDb.exec("DELETE FROM forecast_quantiles WHERE generated_at = '2026-08-11 09:00:00.000000'");
});

function payload(overrides: Record<string, unknown> = {}) {
  return {
    model: { name: 'chronos-2-V010', version: 'v1' },
    generated_at: '2026-08-11 09:00:00.000000',
    rows: [
      {
        country_code: 'BE',
        target_timestamp_utc: '2026-08-12 00:00:00',
        horizon_hours: 40,
        forecast_value: -57.2,
      },
    ],
    ...overrides,
  };
}

describe('POST /api/forecasts/net-position — forecast_type (ABL-240)', () => {
  it('defaults to net_position when forecast_type is omitted — pre-ABL-240 behavior unchanged', async () => {
    const { status, body } = await api.post('forecasts/net-position', payload(), auth);
    expect(status).toBe(201);
    expect(body).toEqual({ success: true, data: { points: 1, quantiles: 0, replaced: false } });

    const row = fixtureDb
      .prepare("SELECT forecast_type FROM forecasts WHERE generated_at = '2026-08-11 09:00:00.000000'")
      .get() as { forecast_type: string };
    expect(row.forecast_type).toBe('net_position');
  });

  it('accepts wind_onshore and writes rows under it', async () => {
    const { status, body } = await api.post(
      'forecasts/net-position',
      payload({ forecast_type: 'wind_onshore', model: { name: 'catboost-retrain-v1', version: 'a' } }),
      auth
    );
    expect(status).toBe(201);
    expect(body).toEqual({ success: true, data: { points: 1, quantiles: 0, replaced: false } });

    const row = fixtureDb
      .prepare(
        "SELECT forecast_type, model_name FROM forecasts WHERE generated_at = '2026-08-11 09:00:00.000000'"
      )
      .get() as { forecast_type: string; model_name: string };
    expect(row).toEqual({ forecast_type: 'wind_onshore', model_name: 'catboost-retrain-v1' });
  });

  it('accepts wind_offshore and does not collide with a wind_onshore row for the same country/model/generated_at', async () => {
    await api.post(
      'forecasts/net-position',
      payload({ forecast_type: 'wind_onshore', model: { name: 'shadow-v1', version: 'a' } }),
      auth
    );
    const { status } = await api.post(
      'forecasts/net-position',
      payload({ forecast_type: 'wind_offshore', model: { name: 'shadow-v1', version: 'a' } }),
      auth
    );
    expect(status).toBe(201);

    const counts = fixtureDb
      .prepare(
        "SELECT forecast_type, COUNT(*) n FROM forecasts WHERE generated_at = '2026-08-11 09:00:00.000000' GROUP BY forecast_type"
      )
      .all();
    expect(counts).toEqual([
      { forecast_type: 'wind_offshore', n: 1 },
      { forecast_type: 'wind_onshore', n: 1 },
    ]);
  });

  it('rejects an unknown forecast_type with 400 UNKNOWN_FORECAST_TYPE', async () => {
    const { status, body } = await api.post(
      'forecasts/net-position',
      payload({ forecast_type: 'solar' }),
      auth
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ success: false, code: 'UNKNOWN_FORECAST_TYPE' });
  });

  it('still requires the bearer token regardless of forecast_type', async () => {
    const { status } = await api.post('forecasts/net-position', payload({ forecast_type: 'wind_onshore' }));
    expect(status).toBe(401);
  });

  it('still enforces the row cap for a wind backfill', async () => {
    const rows = Array.from({ length: 5001 }, (_, i) => ({
      country_code: 'BE',
      target_timestamp_utc: `2026-08-${12 + Math.floor(i / 24)}T${String(i % 24).padStart(2, '0')}:00:00`,
      horizon_hours: 40,
      forecast_value: 1,
    }));
    const { status, body } = await api.post(
      'forecasts/net-position',
      payload({ forecast_type: 'wind_onshore', rows }),
      auth
    );
    expect(status).toBe(413);
    expect(body).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
});
