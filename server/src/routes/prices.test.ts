import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { buildFixtureDb, WINDOW_QS, at, atT } from '../test/fixtureDb.js';

const fixtureDb = buildFixtureDb();
vi.mock('../config/database.js', () => ({ default: fixtureDb }));
vi.mock('../config/writeDatabase.js', async () => (await import('../test/noWriteDb.js')).forbidWriteDb());

const { startTestApi, clearResponseCache } = await import('../test/apiHarness.js');

type Api = Awaited<ReturnType<typeof startTestApi>>;
let api: Api;

beforeAll(async () => { api = await startTestApi(); });
afterAll(() => api.close());
beforeEach(() => clearResponseCache());

const get = (path: string) => api.get(`prices/${path}`);

type Point = { timestamp: string; price: number };

/**
 * Day-ahead prices are published ~12:45 Brussels time for the WHOLE of the
 * next market day, so `energy_price` legitimately holds rows dated in the
 * future — that is the product, not an anomaly. Nothing on the serving path
 * may cap the window at "now".
 *
 * ABL-54/ABL-51 was reported as "at 18:00 CEST the dashboard shows nothing for
 * tomorrow". The ingest window was measured innocent (prod requests
 * `periodEnd=<D+2>T00:00` on every pass), so the surviving question was whether
 * the read path drops a future-dated row. It does not, and these pin that it
 * keeps not doing so — the whole path, through the real `createApp`.
 *
 * The fixture's own rows sit at a fixed 2026-07-01, which is in the past for
 * any run after that date and therefore cannot express "later than now". The
 * D+1 rows below are stamped relative to `Date.now()` for that reason, and are
 * the only rows in this file that are.
 */

/** `2026-07-01 02:00:00`, for an arbitrary instant. Matches the actuals form. */
function spaceForm(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

const HOUR_MS = 60 * 60 * 1000;
/** Whole hours from now, so the row lands cleanly inside an hourly bucket. */
const hoursFromNow = (h: number): Date => {
  const d = new Date(Date.now() + h * HOUR_MS);
  d.setUTCMinutes(0, 0, 0);
  return d;
};

// Three hours of "tomorrow": comfortably past now, comfortably inside the
// now+36h window the client asks for (`getPriceWindowEnd`, priceWindow.ts).
const TOMORROW_HOURS = [20, 24, 28].map(hoursFromNow);
const TOMORROW_PRICES = [88.5, 91.25, 79];

beforeAll(() => {
  const insert = fixtureDb.prepare(
    'INSERT INTO energy_price (country_code, timestamp_utc, price_eur_mwh) VALUES (?, ?, ?)'
  );
  TOMORROW_HOURS.forEach((d, i) => insert.run('FR', spaceForm(d), TOMORROW_PRICES[i]));

  // FR's WINDOW hours are a flat 5 in the fixture, all space-separated. One
  // more on the window's END instant, in the `T` form — see the separator
  // block below for why that hour specifically. DE is left alone so its daily
  // average stays a clean 65.
  insert.run('FR', atT(3), 999);
});

describe('GET /api/prices — tomorrow is served, not clipped at now', () => {
  it('returns day-ahead rows dated after now', async () => {
    const start = new Date(Date.now() - HOUR_MS).toISOString();
    const end = new Date(Date.now() + 36 * HOUR_MS).toISOString();

    const { status, body } = await get(`?country=FR&granularity=hourly&start=${start}&end=${end}`);

    expect(status).toBe(200);
    expect(body.data).toEqual(
      TOMORROW_HOURS.map((d, i) => ({ timestamp: spaceForm(d), price: TOMORROW_PRICES[i] }))
    );
  });

  it('every returned row really is in the future', async () => {
    // The assertion above would also pass if the service quietly returned the
    // fixture's 2026-07-01 rows and nothing else on some future run date. This
    // one cannot: it fails the moment a now-cap reappears anywhere on the path.
    const start = new Date(Date.now() - HOUR_MS).toISOString();
    const end = new Date(Date.now() + 36 * HOUR_MS).toISOString();

    const { body } = await get(`?country=FR&granularity=hourly&start=${start}&end=${end}`);
    const data = body.data as Point[];

    expect(data.length).toBeGreaterThan(0);
    for (const p of data) {
      expect(new Date(`${p.timestamp}Z`).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('caps at now only when the caller omits `end`', async () => {
    // Documented, and the reason `getPriceWindowEnd` exists client-side: the
    // route's default end is `new Date()`. A caller that wants tomorrow must
    // ask for tomorrow. This is the behaviour, not a defect — but it is the
    // trap, so it is pinned rather than left to be rediscovered.
    const start = new Date(Date.now() - HOUR_MS).toISOString();

    const { body } = await get(`?country=FR&granularity=hourly&start=${start}`);

    expect(body.data).toEqual([]);
  });
});

describe('GET /api/prices — separator-agnostic window bounds', () => {
  it('serves a `T`-separated row dated on the window end date', async () => {
    // `energy_price.timestamp_utc` is the most mixed column in the database:
    // 828,878 `T` rows against 701,420 space rows (measured 2026-08-05). `'T'`
    // (84) sorts above `' '` (32), so a space-form upper bound excludes every
    // `T` row on the end date — ABL-21, which dropped exactly today's data
    // because the default window ends at now. `priceService` goes through
    // `rangeClause`/`rangeArgs`; this is what keeps it there.
    const { body } = await get(`?country=FR&granularity=hourly&${WINDOW_QS}`);
    const data = body.data as Point[];

    // 03:00 is the window's end instant and exists in both forms. Both come
    // back; neither separator is silently preferred.
    expect(data.filter((p) => p.timestamp.endsWith('03:00:00'))).toEqual([
      { timestamp: at(3), price: 5 },
      { timestamp: atT(3), price: 999 },
    ]);
  });
});

describe('GET /api/prices — a negative day-ahead price is a price', () => {
  it('averages BE to -25, not +25 and not 0', async () => {
    // BE's window is -10 / -20 / -30 / -40. Negative day-ahead prices are
    // routine at high renewable output, and this repo has already shipped one
    // metric that cancelled sign instead of accumulating it (MAPE at 148458%).
    // A daily bucket must carry the real signed mean.
    const { body } = await get(`?country=BE&granularity=daily&${WINDOW_QS}`);

    expect(body.data).toEqual([{ timestamp: '2026-07-01', price: -25 }]);
  });

  it('defaults to daily granularity when the caller omits it', async () => {
    // Four hourly rows collapse to one bucket. Worth pinning because a probe
    // that omits `granularity` reads as "the API only has one row for that
    // day", which is easy to mistake for missing data.
    const { body } = await get(`?country=DE&${WINDOW_QS}`);

    expect(body.data).toEqual([{ timestamp: '2026-07-01', price: 65 }]);
    expect((body.meta as { granularity: string }).granularity).toBe('daily');
  });
});

describe('GET /api/prices — a country with no rows in the window', () => {
  it('returns an empty series, not a zero', async () => {
    const { status, body } = await get(`?country=AT&granularity=hourly&${WINDOW_QS}`);

    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect((body.meta as { count: number }).count).toBe(0);
  });
});
