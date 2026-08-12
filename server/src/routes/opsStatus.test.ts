import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

/**
 * ABL-288. These go through a real JSONL file on a temp path rather than a
 * mocked store: the point of the endpoint is that a reading survives to disk
 * and comes back, and a mocked filesystem would prove neither.
 */
describe('GET /api/ops/status/history', () => {
  let tempDir: string;
  const originalPath = process.env.OPS_SNAPSHOT_PATH;
  const originalRetention = process.env.OPS_SNAPSHOT_RETENTION_DAYS;

  /** A side of a snapshot with `usedBytes` of a 1000-byte disk — so bytes read as tenths of a percent. */
  const side = (usedBytes: number | null) => ({
    reachable: usedBytes !== null,
    latencyMs: 5,
    diskUsedBytes: usedBytes,
    diskTotalBytes: usedBytes === null ? null : 1000,
    rssBytes: usedBytes === null ? null : 100,
    uptimeSeconds: usedBytes === null ? null : 60,
    freshnessStatus: usedBytes === null ? null : 'live',
    staleCountryCount: usedBytes === null ? null : 0,
    commit: usedBytes === null ? null : 'abc1234',
  });

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-history-'));
    process.env.OPS_SNAPSHOT_PATH = path.join(tempDir, 'snapshots.jsonl');
    process.env.OPS_SNAPSHOT_RETENTION_DAYS = '14';

    // 13 six-hourly readings ending now: local disk climbing 1 point/day from
    // 80% to 83%, peer flat at 50%.
    const lines = Array.from({ length: 13 }, (_, i) => {
      const hoursBack = (12 - i) * 6;
      const percent = 80 + (i * 6) / 24;
      return JSON.stringify({
        t: new Date(Date.now() - hoursBack * HOUR_MS).toISOString(),
        local: side(Math.round(percent * 10)),
        peer: side(500),
      });
    });
    fs.writeFileSync(process.env.OPS_SNAPSHOT_PATH, `${lines.join('\n')}\n`);
  });

  afterAll(() => {
    if (originalPath === undefined) delete process.env.OPS_SNAPSHOT_PATH;
    else process.env.OPS_SNAPSHOT_PATH = originalPath;
    if (originalRetention === undefined) delete process.env.OPS_SNAPSHOT_RETENTION_DAYS;
    else process.env.OPS_SNAPSHOT_RETENTION_DAYS = originalRetention;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns the stored snapshots and the storage state they came from', async () => {
    const { status, body } = await api.get('ops/status/history');
    expect(status).toBe(200);

    const data = body.data as any;
    expect(Object.keys(data).sort()).toEqual(['headroom', 'snapshots', 'storage', 'timestamp', 'windowHours']);
    expect(data.snapshots).toHaveLength(13);
    expect(data.storage).toMatchObject({
      captureEnabled: true,
      retentionDays: 14,
      storedSnapshots: 13,
      skippedLines: 0,
      error: null,
    });
  });

  it('projects the disk headroom for a rising side and refuses to for a flat one', async () => {
    const { body } = await api.get('ops/status/history');
    const { headroom } = body.data as any;

    expect(headroom.local.reason).toBe('ok');
    expect(headroom.local.thresholdPercent).toBe(90);
    expect(headroom.local.days).toBeCloseTo(7, 0);
    expect(headroom.local.basis.points).toBe(13);

    expect(headroom.peer.reason).toBe('not_rising');
    expect(headroom.peer.days).toBeNull();
  });

  it('clamps hours to what is retained and echoes the window it actually served', async () => {
    const { body } = await api.get('ops/status/history?hours=2160');

    expect((body.data as any).windowHours).toBe(14 * 24);
  });

  it('narrows the returned snapshots to a shorter requested window', async () => {
    // 13h rather than 12h: the -12h reading sits exactly on a 12h cutoff, and
    // the request lands some milliseconds after the fixture was written, so
    // that boundary point is genuinely ambiguous. 13h is not.
    const { body } = await api.get('ops/status/history?hours=13');
    const data = body.data as any;

    expect(data.windowHours).toBe(13);
    // 6-hourly readings: now, -6h, -12h.
    expect(data.snapshots).toHaveLength(3);
    expect(data.headroom.local.reason).toBe('insufficient_history');
    expect(data.headroom.local.days).toBeNull();
  });

  it('rejects a nonsense hours instead of silently serving a default window', async () => {
    const { status, body } = await api.get('ops/status/history?hours=banana');

    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_HOURS');
  });

  it('reports an empty history with no error when nothing has been captured yet', async () => {
    const missing = path.join(tempDir, 'not-written-yet.jsonl');
    const previous = process.env.OPS_SNAPSHOT_PATH;
    process.env.OPS_SNAPSHOT_PATH = missing;
    try {
      const { status, body } = await api.get('ops/status/history');
      const data = body.data as any;

      expect(status).toBe(200);
      expect(data.snapshots).toEqual([]);
      expect(data.storage.error).toBeNull();
      expect(data.headroom.local).toEqual({
        thresholdPercent: 90,
        days: null,
        reason: 'no_readings',
        basis: null,
      });
    } finally {
      process.env.OPS_SNAPSHOT_PATH = previous;
    }
  });
});
