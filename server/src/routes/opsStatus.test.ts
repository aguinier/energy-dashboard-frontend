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

const HOUR_MS = 60 * 60 * 1000;
const spaceForm = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
const hoursAgo = (h: number) => spaceForm(new Date(Date.now() - h * HOUR_MS));

/**
 * The fixture's own rows sit at a fixed 2026-07-01, permanently past every
 * freshness threshold — see `dataFreshness.test.ts`. One now-relative row is
 * enough to prove this endpoint's freshness section is wired to the real
 * per-country classifier rather than a stub: BE at 20h old is past
 * `MEASURED_STALE_AFTER_HOURS` (18h) whatever day the suite runs.
 */
beforeAll(() => {
  const load = fixtureDb.prepare(
    'INSERT INTO energy_load (country_code, timestamp_utc, load_mw) VALUES (?, ?, ?)'
  );
  load.run('BE', hoursAgo(20), 8_800);
});

/** A real desktop Chrome UA — `fetch`'s own lands in the automated lane (ABL-289). */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Today's per-lane counts, read through the endpoint itself. */
async function lanes(): Promise<Record<string, number>> {
  const { body } = await api.get('ops/status');
  return (body.data as any).visitors.today as Record<string, number>;
}

describe('GET /api/ops/status', () => {
  it('returns provenance, host, process, freshness and visitor sections', async () => {
    const { status, body } = await api.get('ops/status');
    expect(status).toBe(200);

    const data = body.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual([
      'freshness', 'host', 'process', 'provenance', 'timestamp', 'visitors',
    ]);
  });

  it('carries the visitor counters with the coverage fields that keep them honest (ABL-289)', async () => {
    const { body } = await api.get('ops/status');
    const visitors = (body.data as any).visitors;

    // `countingSince` and `windowComplete` are not decoration: this store is
    // in-memory, so a restart zeroes it, and the payload has to say that rather
    // than let a reader take "3 this week" for an all-time total.
    expect(typeof visitors.countingSince).toBe('string');
    expect(visitors.windowComplete).toBe(false); // this process started seconds ago
    expect(visitors.windowDaysCovered).toBe(1);
    expect(Object.keys(visitors.today).sort()).toEqual(['api', 'asset', 'automated', 'page']);
    expect(Object.keys(visitors.window).sort()).toEqual(['api', 'asset', 'automated', 'page']);
  });

  it('counts its own /api/ops and /api/health polling as automated, never as app traffic', async () => {
    // The whole point of the split (ABL-289). Both environments sit under
    // constant self-inflicted traffic — the docker healthcheck, the peer poll,
    // this page's own 30s refetch — and none of it may read as a visit. Asserted
    // as a delta so it holds whatever else the suite has already sent.
    const before = await lanes();
    await api.get('health', { 'user-agent': BROWSER_UA });
    await api.get('ops/status', { 'user-agent': BROWSER_UA });
    const after = await lanes();

    // Three requests: the two above plus the /ops/status that read `after`.
    expect(after.automated - before.automated).toBe(3);
    expect(after.page).toBe(before.page);
    expect(after.api).toBe(before.api);
  });

  it('counts an ordinary data call as app api traffic', async () => {
    // A browser UA, because the lane also turns on the user agent and `fetch`'s
    // own is an automated one — the point under test here is the path.
    const before = await lanes();
    await api.get('countries', { 'user-agent': BROWSER_UA });
    const after = await lanes();

    expect(after.api - before.api).toBe(1);
  });

  it('does not count a bot user agent as a visitor, whatever it asks for', async () => {
    const before = await lanes();
    await api.get('countries', { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' });
    const after = await lanes();

    expect(after.api).toBe(before.api);
    expect(after.automated - before.automated).toBe(2); // the bot call, plus the read
  });

  it("reuses getHealthProvenance for commit/runtime/db_path, matching /api/health's own contract", async () => {
    const [opsRes, healthRes] = await Promise.all([api.get('ops/status'), api.get('health')]);
    const provenance = (opsRes.body.data as any).provenance;
    const healthData = healthRes.body.data as any;

    expect(provenance).toEqual({
      commit: healthData.commit,
      runtime: healthData.runtime,
      db_path: healthData.db_path,
    });
  });

  it('reports process uptime and memory as measured numbers, never fabricated', async () => {
    const { body } = await api.get('ops/status');
    const proc = (body.data as any).process;

    expect(proc.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(proc.memory.rssBytes).toBeGreaterThan(0);
    expect(proc.memory.heapUsedBytes).toBeGreaterThan(0);
    expect(proc.memory.heapTotalBytes).toBeGreaterThan(0);
  });

  it('reports host disk usage and cpu load as a real reading or an honest null, never a fabricated shape', async () => {
    const { body } = await api.get('ops/status');
    const host = (body.data as any).host;

    if (host.disk !== null) {
      expect(host.disk.totalBytes).toBeGreaterThan(0);
      expect(typeof host.disk.freeBytes).toBe('number');
      expect(typeof host.disk.usedBytes).toBe('number');
    }

    // os.loadavg() fabricates [0,0,0] on every Windows process — this is the
    // one platform where we can assert the null branch deterministically
    // without mocking os.loadavg() through the whole route stack.
    if (process.platform === 'win32') {
      expect(host.cpuLoad).toBeNull();
    }
  });

  it('surfaces the fleet as stale, reusing dataFreshnessService rather than a stub', async () => {
    const { body } = await api.get('ops/status');
    const freshness = (body.data as any).freshness;

    expect(freshness.status).toBe('stale');
    expect(freshness.staleCountries).toContain('BE');
    // DE, FR, BE, PT, GR, AT, LU — the fixture's seeded country list.
    expect(freshness.countriesChecked).toBe(7);
    expect(freshness.streamsChecked).toBe(35);
    expect(freshness.counts.stale).toBeGreaterThanOrEqual(1);
  });

  it("does not change /api/health's existing response contract", async () => {
    const { status, body } = await api.get('health');
    expect(status).toBe(200);
    const data = body.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['commit', 'db_path', 'runtime', 'status', 'timestamp']);
  });
});

describe('GET /api/ops/status/combined', () => {
  it('reports local KPIs and an honest unconfigured peer when OPS_PEER_URL is unset (test env)', async () => {
    const { status, body } = await api.get('ops/status/combined');
    expect(status).toBe(200);

    const data = body.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(
      ['local', 'peer', 'peerConfigured', 'syncBlackout', 'timestamp'],
    );

    const local = data.local as Record<string, unknown>;
    expect(local.reachable).toBe(true);
    expect((local.status as Record<string, unknown>).freshness).toBeDefined();

    // No OPS_PEER_URL in this test process's env — the honest "not configured"
    // state, distinct from "configured but unreachable".
    expect(data.peerConfigured).toBe(false);
    expect((data.peer as Record<string, unknown>).reachable).toBe(false);
  });
});
