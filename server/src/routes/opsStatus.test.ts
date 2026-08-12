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

describe('GET /api/ops/status', () => {
  it('returns provenance, host, process and freshness sections', async () => {
    const { status, body } = await api.get('ops/status');
    expect(status).toBe(200);

    const data = body.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['freshness', 'host', 'process', 'provenance', 'timestamp']);
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

  it('reports network throughput as real counters or an honest null, never a zeroed shape', async () => {
    const { body } = await api.get('ops/status');
    const host = (body.data as any).host;

    // `/proc/net/dev` exists on Linux only. Everywhere else the honest answer
    // is `null` — a zero-filled interface list would render as a quiet network
    // on the Windows acceptance host rather than as "not measured".
    if (process.platform !== 'linux') {
      expect(host.network).toBeNull();
      return;
    }

    expect(Array.isArray(host.network)).toBe(true);
    for (const iface of host.network) {
      expect(typeof iface.name).toBe('string');
      expect(iface.name).not.toBe('lo');
      expect(iface.rxBytes).toBeGreaterThanOrEqual(0);
      expect(iface.txBytes).toBeGreaterThanOrEqual(0);
      // Rates are derived from two samples, so they are legitimately null on
      // the first request; what they must never be is a number with no window
      // to have measured it over.
      if (iface.rxBytesPerSec !== null) {
        expect(iface.sampleWindowMs).toBeGreaterThan(0);
        expect(Number.isFinite(iface.rxBytesPerSec)).toBe(true);
        expect(iface.rxBytesPerSec).toBeGreaterThanOrEqual(0);
      }
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
