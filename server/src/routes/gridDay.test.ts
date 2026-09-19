import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { buildFixtureDb } from '../test/fixtureDb.js';

const fixtureDb = buildFixtureDb();
vi.mock('../config/database.js', () => ({ default: fixtureDb }));
vi.mock('../config/writeDatabase.js', async () => (await import('../test/noWriteDb.js')).forbidWriteDb());

const { startTestApi, clearResponseCache } = await import('../test/apiHarness.js');

type Api = Awaited<ReturnType<typeof startTestApi>>;
let api: Api;

beforeAll(async () => { api = await startTestApi(); });
afterAll(() => api.close());
beforeEach(() => clearResponseCache());

type Series = (number | null)[];
type Zone = { load: Series; price: Series; net: Series; mix: Record<string, Series> };
type Payload = { zones: Record<string, Zone>; flows: Record<string, Series> };
type Meta = {
  date: string;
  timezone: string;
  hoursUtc: (string | null)[];
  sharedZones: Record<string, string>;
  currentHour: number;
  isToday: boolean;
  today: string;
  zoneCount: number;
  borderCount: number;
};

const get = (qs = '') => api.get(`grid/day${qs}`);

/**
 * The fixture's rows sit at 00:00-03:00 UTC on 2026-07-01. Brussels is CEST
 * (+2) that day, so the local day starts at 22:00 UTC the evening before and
 * those four hours land in slots 2-5 — which is the whole point of serving a
 * local day rather than a UTC one, and is asserted rather than assumed below.
 */
const FIXTURE_SLOTS = [2, 3, 4, 5] as const;
const DAY = '?date=2026-07-01';

const atSlots = (series: Series): Series => FIXTURE_SLOTS.map((s) => series[s]);

describe('GET /api/grid/day — envelope and shape', () => {
  it('serves one 24-slot series per stream per zone', async () => {
    const { status, body } = await get(DAY);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const data = body.data as Payload;

    const de = data.zones.DE;
    expect(de.load).toHaveLength(24);
    expect(de.price).toHaveLength(24);
    expect(de.net).toHaveLength(24);
    for (const fuel of ['nuclear', 'hydro', 'wind', 'solar', 'gas', 'coal', 'biomass', 'other']) {
      expect(de.mix[fuel]).toHaveLength(24);
    }
  });

  it('reports the local day, its UTC hours and the zone count in meta', async () => {
    const { body } = await get(DAY);
    const meta = body.meta as Meta;

    expect(meta).toMatchObject({
      date: '2026-07-01',
      timezone: 'Europe/Brussels',
      isToday: false,
    });
    expect(meta.hoursUtc).toHaveLength(24);
    expect(meta.hoursUtc[0]).toBe('2026-06-30T22:00:00Z');
    expect(meta.zoneCount).toBeGreaterThan(0);
  });

  it('places the fixture hours in the local slots, not the UTC ones', async () => {
    const { body } = await get(DAY);
    const de = (body.data as Payload).zones.DE;

    expect(atSlots(de.load)).toEqual([1000, 1100, 1200, 1300]);
    // Slot 0 is 22:00 UTC the previous evening — outside the fixture's rows.
    expect(de.load[0]).toBeNull();
    expect(de.load[23]).toBeNull();
  });

  it('serves price and net position from the same day window', async () => {
    const { body } = await get(DAY);
    const de = (body.data as Payload).zones.DE;

    expect(atSlots(de.price)).toEqual([50, 60, 70, 80]);
    expect(atSlots(de.net)).toEqual([100, 150, 200, 250]);
  });
});

describe('GET /api/grid/day — a missing hour is null, never zero', () => {
  it('leaves unreported hours null rather than filling them', async () => {
    const { body } = await get(DAY);
    const gr = (body.data as Payload).zones.GR;

    // GR stops publishing after 01:00 UTC — slots 2 and 3, then silence.
    expect(gr.net[2]).toBe(-50);
    expect(gr.net[3]).toBe(-60);
    expect(gr.net[4]).toBeNull();
    expect(gr.net[5]).toBeNull();
  });

  it('keeps a country that reports no production type at all entirely null', async () => {
    const { body } = await get(DAY);
    const pt = (body.data as Payload).zones.PT;

    // PT has generation ROWS but every column is NULL. Reading that as 0 MW
    // would draw Portugal a full mix ring of nothing.
    for (const fuel of Object.keys(pt.mix)) {
      expect(pt.mix[fuel].every((v) => v === null)).toBe(true);
    }
  });

  it('keeps a measured zero distinguishable from an absent one', async () => {
    const { body } = await get(DAY);
    const be = (body.data as Payload).zones.BE;

    // BE genuinely generates 0 MW of solar and wind, and reports nothing else.
    expect(atSlots(be.mix.solar)).toEqual([0, 0, 0, 0]);
    expect(atSlots(be.mix.wind)).toEqual([0, 0, 0, 0]);
    expect(be.mix.nuclear.every((v) => v === null)).toBe(true);
  });
});

describe('GET /api/grid/day — the generation mix', () => {
  it('groups the A75 columns into the eight fuels the legend draws', async () => {
    const { body } = await get(DAY);
    const de = (body.data as Payload).zones.DE;

    expect(atSlots(de.mix.nuclear)).toEqual([300, 300, 300, 300]);
    expect(atSlots(de.mix.wind)).toEqual([200, 200, 200, 200]);
    expect(atSlots(de.mix.solar)).toEqual([100, 100, 100, 100]);
    expect(atSlots(de.mix.gas)).toEqual([400, 400, 400, 400]);
    expect(de.mix.coal.every((v) => v === null)).toBe(true);
  });

  it('clamps a pumping hour instead of shrinking hydro', async () => {
    const { body } = await get(DAY);
    const fr = (body.data as Payload).zones.FR;

    // FR: hydro_run 100 with hydro_pumped -300. The store consuming power is
    // not negative generation, so hydro is 100 and not -200.
    expect(atSlots(fr.mix.hydro)).toEqual([100, 100, 100, 100]);
    // fossil_hard_coal is -50, a consumption-only reading: clamped to 0, but
    // still REPORTED, so it must not come back null.
    expect(atSlots(fr.mix.coal)).toEqual([0, 0, 0, 0]);
    expect(atSlots(fr.mix.solar)).toEqual([0, 0, 0, 0]);
    expect(fr.mix.wind.every((v) => v === null)).toBe(true);
  });
});

describe('GET /api/grid/day — bidding zones that share a series', () => {
  it('serves Luxembourg the DE_LU net position, not its own stale rows', async () => {
    const { body } = await get(DAY);
    const { zones } = body.data as Payload;

    // LU's own row says -6201 MW. Left alone it paints Luxembourg the opposite
    // colour to Germany for one bidding zone.
    expect(atSlots(zones.LU.net)).toEqual([100, 150, 200, 250]);
    expect(zones.LU.net).toEqual(zones.DE.net);
  });

  it('names the sharing in meta so the client can label it', async () => {
    const { body } = await get(DAY);

    expect((body.meta as Meta).sharedZones).toMatchObject({ LU: 'DE_LU' });
  });
});

describe('GET /api/grid/day — cross-border flows', () => {
  it('nets the two directed legs into one signed series per border', async () => {
    const { body } = await get(DAY);
    const { flows } = body.data as Payload;

    // DE->FR 500/200/400/150 against FR->DE 200/300/0/150.
    expect(atSlots(flows['DE-FR'])).toEqual([300, -100, 400, 0]);
  });

  it('keys borders alphabetically and signs against that key', async () => {
    const { body } = await get(DAY);
    const { flows } = body.data as Payload;

    expect(Object.keys(flows)).toContain('DE-FR');
    expect(Object.keys(flows)).not.toContain('FR-DE');
    // DE exports 900 MW to BE, and DE is second in "BE-DE".
    expect(flows['BE-DE'][2]).toBe(-900);
  });

  it('reads a one-legged border as a number', async () => {
    const { body } = await get(DAY);

    expect(atSlots((body.data as Payload).flows['BE-FR'])).toEqual([250, 250, 250, 250]);
  });

  it('nets the return leg of a border whose far side is not a zone', async () => {
    // GB publishes nothing but flows, so it is not in `zones` — yet both legs
    // of FR<->GB are in the table, stored by border, not by zone. Fetching
    // exports only FROM zones served the FR leg gross, +700, as the net; the
    // real border is 700 out against 500 back.
    const { body } = await get(DAY);

    expect(atSlots((body.data as Payload).flows['FR-GB'])).toEqual([200, 200, 200, 200]);
  });

  it('leaves an hour with neither leg null, and a cancelling hour zero', async () => {
    const { body } = await get(DAY);
    const { flows } = body.data as Payload;

    // Nothing published on DE/BE at 01:00 UTC: null, not a still border.
    expect(flows['BE-DE'][3]).toBeNull();
    // DE/FR's legs are equal at 03:00 UTC: a measured balance, so 0.
    expect(flows['DE-FR'][5]).toBe(0);
  });

  it('buckets a row stored with the other timestamp separator', async () => {
    const { body } = await get(DAY);

    // The 02:00 DE/FR rows are 'T'-separated in the fixture. This column holds
    // both forms, and a window bound that understood only one silently dropped
    // a day of rows once already (ABL-21) — here that would read null.
    expect((body.data as Payload).flows['DE-FR'][4]).toBe(400);
  });
});

describe('GET /api/grid/day — request handling', () => {
  it('rejects a malformed or impossible date with 400', async () => {
    for (const bad of ['2026-02-31', 'today', '2026-7-1', '2026-13-01']) {
      const { status, body } = await get(`?date=${encodeURIComponent(bad)}`);
      expect(status).toBe(400);
      expect(body.success).toBe(false);
    }
  });

  it('defaults to today in Brussels', async () => {
    const { status, body } = await get();
    const meta = body.meta as Meta;

    expect(status).toBe(200);
    expect(meta.isToday).toBe(true);
    expect(meta.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(meta.currentHour).toBeGreaterThanOrEqual(0);
    expect(meta.currentHour).toBeLessThan(24);
  });

  it('prefers the space-form row over the T-form one for the same instant', async () => {
    // Both separator forms exist in these tables for the same country-hour —
    // 107,047 conflicting pairs in energy_load alone — and the codebase's
    // settled answer is to prefer the space form, never to combine them.
    // Averaging the pair would serve 500, a number neither row holds.
    const insert = fixtureDb.prepare(
      'INSERT INTO energy_load (country_code, timestamp_utc, load_mw) VALUES (?, ?, ?)',
    );
    insert.run('DE', '2026-07-05 10:00:00', 100);
    insert.run('DE', '2026-07-05T10:00:00', 900);

    const { body } = await get('?date=2026-07-05');

    // Brussels is CEST that day, so 10:00 UTC is the 12:00 local slot.
    expect((body.data as Payload).zones.DE.load[12]).toBe(100);
  });

  it('serves a day with no rows as an empty payload, not an error', async () => {
    const { status, body } = await get('?date=2020-01-01');

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect((body.data as Payload).zones).toEqual({});
    expect((body.data as Payload).flows).toEqual({});
  });
});

describe('GET /api/grid/day — the dateless request under the cache', () => {
  // Only Date is faked: the harness talks to a real HTTP server, and faking
  // the timer functions would stall it.
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  it('does not serve yesterday across Brussels midnight from the cache', async () => {
    // The dateless URL never changes, but what it means does — at Brussels
    // midnight, inside the cache's five-minute TTL. A 23:58 payload answering
    // an 00:01 request labels yesterday `isToday: true`.
    vi.setSystemTime(new Date('2026-06-30T21:58:00Z')); // 23:58 Brussels, CEST

    expect(((await get('')).body.meta as Meta).date).toBe('2026-06-30');

    vi.setSystemTime(new Date('2026-06-30T22:01:00Z')); // 00:01 the next day

    expect(((await get('')).body.meta as Meta).date).toBe('2026-07-01');
  });

  it('crosses an hour boundary without serving the old currentHour', async () => {
    // GO_LIVE jumps to meta.currentHour, so a cached hour makes the Live
    // button land the reader an hour behind the clock it claims to follow.
    vi.setSystemTime(new Date('2026-07-01T10:59:00Z')); // 12:59 Brussels

    expect(((await get('')).body.meta as Meta).currentHour).toBe(12);

    vi.setSystemTime(new Date('2026-07-01T11:01:00Z')); // 13:01 Brussels

    expect(((await get('')).body.meta as Meta).currentHour).toBe(13);
  });
});

describe('GET /api/grid/day — the day control needs an anchor', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  /**
   * `meta.today` exists because the client's day arrows have to decide whether
   * one more step is still inside the reach, which is a question about a date
   * the server was never asked for. Once a day is pinned, `meta.date` is that
   * day and cannot answer it.
   */
  it('reports today alongside the day it served', async () => {
    vi.setSystemTime(new Date('2026-07-01T10:00:00Z'));
    const meta = (await get('')).body.meta as Meta;

    expect(meta.today).toBe('2026-07-01');
    expect(meta.date).toBe(meta.today);
    expect(meta.isToday).toBe(true);
  });

  it('still reports today on a payload for another day', async () => {
    vi.setSystemTime(new Date('2026-07-01T10:00:00Z'));
    const meta = (await get('?date=2026-06-25')).body.meta as Meta;

    expect(meta.date).toBe('2026-06-25');
    expect(meta.today).toBe('2026-07-01');
    expect(meta.isToday).toBe(false);
  });

  it('serves a date ahead of today as an empty payload, not an error', async () => {
    vi.setSystemTime(new Date('2026-07-01T10:00:00Z'));
    const { status, body } = await get('?date=2026-07-08');

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect((body.meta as Meta).today).toBe('2026-07-01');
    expect((body.meta as Meta).isToday).toBe(false);
    expect((body.data as Payload).zones).toEqual({});
  });

  /**
   * The cache key had excluded dated requests, on the reasoning that an
   * explicit ?date= pinned everything the payload said about time. `today`
   * ended that: a dated payload cached at 23:58 and served at 00:01 would
   * carry yesterday as the anchor and disable the forward arrow a day early.
   */
  it('does not serve a stale today on a dated request across Brussels midnight', async () => {
    vi.setSystemTime(new Date('2026-06-30T21:58:00Z')); // 23:58 Brussels, CEST

    expect(((await get('?date=2026-06-25')).body.meta as Meta).today).toBe('2026-06-30');

    vi.setSystemTime(new Date('2026-06-30T22:01:00Z')); // 00:01 the next day

    expect(((await get('?date=2026-06-25')).body.meta as Meta).today).toBe('2026-07-01');
  });
});
