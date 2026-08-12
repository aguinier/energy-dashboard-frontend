import { describe, it, expect, vi } from 'vitest';
import type { OpsStatus } from './opsStatusService.js';
import type { SideStatus } from './peerOpsStatus.js';

/**
 * Every test here injects `getLocalStatus`, so nothing in this file ever
 * touches a real database — but `combinedOpsStatusService.js` still pulls in
 * `opsStatusService.js` -> `countryService.js`/`dataFreshnessService.js` ->
 * `config/database.js`, which opens a real `better-sqlite3` handle at *import*
 * time, not call time. Mocking it out with an inert stub (rather than
 * `test/fixtureDb.ts`'s real in-memory `Database`, which this file has no use
 * for) keeps this a pure-logic suite that does not depend on the native
 * module being ABI-compatible with the running Node version — see CLAUDE.md's
 * "NODE_MODULE_VERSION mismatch" note, which otherwise blocks every
 * `better-sqlite3`-touching test in this shared workstation checkout.
 */
vi.mock('../config/database.js', () => ({ default: {} }));

const { getCombinedOpsStatus } = await import('./combinedOpsStatusService.js');

const SAMPLE_STATUS: OpsStatus = {
  timestamp: '2026-08-11T20:00:00.000Z',
  provenance: { commit: 'abc123', runtime: 'container', db_path: '/data/energy_dashboard.db' },
  host: { platform: 'linux', disk: { totalBytes: 100, freeBytes: 40, usedBytes: 60 }, cpuLoad: { load1: 0.1, load5: 0.2, load15: 0.3 } },
  process: { uptimeSeconds: 100, memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 1 } },
  freshness: { status: 'live', countriesChecked: 7, streamsChecked: 35, counts: { live: 35, stale: 0, ended: 0, none: 0 }, staleCountries: [] },
};

const NOON = new Date(2026, 7, 11, 12, 0, 0);
const DURING_BLACKOUT = new Date(2026, 7, 11, 7, 5, 0);

const reachablePeer = async (): Promise<SideStatus> => ({ reachable: true, latencyMs: 42, status: SAMPLE_STATUS });
const unreachablePeer = async (): Promise<SideStatus> => ({
  reachable: false,
  latencyMs: 5001,
  error: 'timed out after 5000ms',
});

describe('getCombinedOpsStatus', () => {
  it('merges a reachable local and a reachable peer', async () => {
    const result = await getCombinedOpsStatus(NOON, {
      getLocalStatus: () => SAMPLE_STATUS,
      fetchPeer: reachablePeer,
      env: { OPS_PEER_URL: 'http://192.168.86.36:3001' },
    });

    expect(result.local).toEqual({ reachable: true, latencyMs: expect.any(Number), status: SAMPLE_STATUS });
    expect(result.peer).toEqual({ reachable: true, latencyMs: 42, status: SAMPLE_STATUS });
    expect(result.peerConfigured).toBe(true);
    expect(result.timestamp).toBe(NOON.toISOString());
  });

  it('degrades gracefully — and does not throw — when the peer is unreachable, without touching local', async () => {
    const result = await getCombinedOpsStatus(NOON, {
      getLocalStatus: () => SAMPLE_STATUS,
      fetchPeer: unreachablePeer,
      env: { OPS_PEER_URL: 'http://192.168.86.237:3001' },
    });

    expect(result.local.reachable).toBe(true);
    expect(result.peer).toEqual({ reachable: false, latencyMs: 5001, error: 'timed out after 5000ms' });
  });

  it('reports peerConfigured: false, distinct from an unreachable peer, when OPS_PEER_URL is unset', async () => {
    const result = await getCombinedOpsStatus(NOON, {
      getLocalStatus: () => SAMPLE_STATUS,
      fetchPeer: async () => ({ reachable: false, latencyMs: null, error: 'OPS_PEER_URL is not configured' }),
      env: {},
    });

    expect(result.peerConfigured).toBe(false);
    expect(result.peer.reachable).toBe(false);
  });

  it('degrades local to reachable:false when getOpsStatus throws — e.g. the DB write-lock during a sync — instead of rejecting the whole call', async () => {
    const result = await getCombinedOpsStatus(NOON, {
      getLocalStatus: () => {
        throw new Error('SQLITE_BUSY: database is locked');
      },
      fetchPeer: reachablePeer,
      env: { OPS_PEER_URL: 'http://192.168.86.36:3001' },
    });

    expect(result.local).toEqual({
      reachable: false,
      latencyMs: expect.any(Number),
      error: 'SQLITE_BUSY: database is locked',
    });
    // The peer's own KPIs must still be present — one side's DB lock must never blank the other.
    expect(result.peer.reachable).toBe(true);
  });

  it('flags syncBlackout.active when the timestamp falls in the ~07:00 window, alongside a degraded local side', async () => {
    const result = await getCombinedOpsStatus(DURING_BLACKOUT, {
      getLocalStatus: () => {
        throw new Error('SQLITE_BUSY: database is locked');
      },
      fetchPeer: reachablePeer,
      env: {},
    });

    expect(result.syncBlackout).toEqual({ active: true, label: '~07:00 daily DB sync' });
    expect(result.local.reachable).toBe(false);
  });

  it('does not flag syncBlackout outside the known windows, even when local is degraded — a genuine, unexplained failure', async () => {
    const result = await getCombinedOpsStatus(NOON, {
      getLocalStatus: () => {
        throw new Error('unexpected failure');
      },
      fetchPeer: reachablePeer,
      env: {},
    });

    expect(result.syncBlackout).toEqual({ active: false, label: null });
  });
});

/**
 * ABL-292. The verdicts themselves are exhaustively covered in
 * `lib/opsStatusThresholds.test.ts`; what matters here is that the endpoint
 * attaches them for **both** lanes, off each side's own reported numbers, and
 * that adding them changed nothing a consumer already reads.
 */
describe('getCombinedOpsStatus derived state', () => {
  const withDisk = (usedBytes: number, totalBytes: number): OpsStatus => ({
    ...SAMPLE_STATUS,
    host: { ...SAMPLE_STATUS.host, disk: { totalBytes, freeBytes: totalBytes - usedBytes, usedBytes } },
  });

  it('derives each lane independently — a full local disk must not colour the peer, or vice versa', async () => {
    const result = await getCombinedOpsStatus(NOON, {
      getLocalStatus: () => withDisk(95, 100),
      fetchPeer: async () => ({ reachable: true, latencyMs: 42, status: withDisk(10, 100) }),
      env: { OPS_PEER_URL: 'http://192.168.86.36:3001' },
    });

    expect(result.derived.local).toEqual({ environment: 'error', disk: 'error', freshness: 'ok' });
    expect(result.derived.peer).toEqual({ environment: 'ok', disk: 'ok', freshness: 'ok' });
  });

  it('reads the live acceptance disk figure (85.11%) as warn, not error, end to end through the endpoint', async () => {
    const result = await getCombinedOpsStatus(NOON, {
      getLocalStatus: () => withDisk(8511, 10_000),
      fetchPeer: reachablePeer,
      env: { OPS_PEER_URL: 'http://192.168.86.36:3001' },
    });

    expect(result.derived.local).toEqual({ environment: 'warn', disk: 'warn', freshness: 'ok' });
  });

  it('reports an unreachable peer as environment error with unmeasured KPIs, never a clean ok', async () => {
    const result = await getCombinedOpsStatus(NOON, {
      getLocalStatus: () => SAMPLE_STATUS,
      fetchPeer: unreachablePeer,
      env: { OPS_PEER_URL: 'http://192.168.86.237:3001' },
    });

    expect(result.derived.peer).toEqual({ environment: 'error', disk: 'unknown', freshness: 'unknown' });
    expect(result.derived.local.environment).toBe('ok');
  });

  it('applies the same blackout downgrade the page used to apply client-side', async () => {
    const result = await getCombinedOpsStatus(DURING_BLACKOUT, {
      getLocalStatus: () => {
        throw new Error('SQLITE_BUSY: database is locked');
      },
      fetchPeer: reachablePeer,
      env: { OPS_PEER_URL: 'http://192.168.86.36:3001' },
    });

    expect(result.syncBlackout.active).toBe(true);
    expect(result.derived.local.environment).toBe('warn');
  });

  it('is additive — every field the deployed /ops-status page already reads is unchanged', async () => {
    const result = await getCombinedOpsStatus(NOON, {
      getLocalStatus: () => SAMPLE_STATUS,
      fetchPeer: reachablePeer,
      env: { OPS_PEER_URL: 'http://192.168.86.36:3001' },
    });

    expect(Object.keys(result).sort()).toEqual(
      ['derived', 'local', 'peer', 'peerConfigured', 'syncBlackout', 'timestamp'].sort(),
    );
    // The two side objects keep their exact ABL-238 shape — the verdict is a
    // sibling key, not a field grafted into either side.
    expect(result.local).toEqual({ reachable: true, latencyMs: expect.any(Number), status: SAMPLE_STATUS });
    expect(result.peer).toEqual({ reachable: true, latencyMs: 42, status: SAMPLE_STATUS });
  });
});
