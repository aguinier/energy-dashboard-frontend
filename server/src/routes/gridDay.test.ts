import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
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

  it('serves a day with no rows as an empty payload, not an error', async () => {
    const { status, body } = await get('?date=2020-01-01');

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect((body.data as Payload).zones).toEqual({});
    expect((body.data as Payload).flows).toEqual({});
  });
});
