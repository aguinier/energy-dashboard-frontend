import { describe, it, expect } from 'vitest';
import { fetchPeerOpsStatus } from './peerOpsStatus.js';
import type { OpsStatus } from './opsStatusService.js';

const SAMPLE_STATUS: OpsStatus = {
  timestamp: '2026-08-11T20:00:00.000Z',
  provenance: { commit: 'abc123', runtime: 'container', db_path: '/data/energy_dashboard.db' },
  host: { platform: 'linux', disk: { totalBytes: 100, freeBytes: 40, usedBytes: 60 }, cpuLoad: { load1: 0.1, load5: 0.2, load15: 0.3 } },
  process: { uptimeSeconds: 100, memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 1 } },
  freshness: { status: 'live', countriesChecked: 7, streamsChecked: 35, counts: { live: 35, stale: 0, ended: 0, none: 0 }, staleCountries: [] },
  visitors: { countingSince: '2026-08-11T00:00:00.000Z', day: '2026-08-11', today: { page: 0, api: 0, asset: 0, automated: 0 }, window: { page: 0, api: 0, asset: 0, automated: 0 }, windowDaysCovered: 1, windowComplete: false, distinctClientsToday: 0 },
};

function fakeFetch(response: Partial<Response> & { json?: () => Promise<unknown> }): typeof fetch {
  return (async () => response as Response) as typeof fetch;
}

describe('fetchPeerOpsStatus', () => {
  it('reports unreachable, without making a request, when no peer URL is configured', async () => {
    const result = await fetchPeerOpsStatus(undefined, fakeFetch({ ok: true }));
    expect(result).toEqual({ reachable: false, latencyMs: null, error: 'OPS_PEER_URL is not configured' });
  });

  it('returns the parsed status on a reachable peer', async () => {
    const result = await fetchPeerOpsStatus(
      'http://192.168.86.36:3001',
      fakeFetch({ ok: true, json: async () => ({ success: true, data: SAMPLE_STATUS }) }),
    );
    expect(result.reachable).toBe(true);
    if (result.reachable) {
      expect(result.status).toEqual(SAMPLE_STATUS);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('strips a trailing slash from the configured peer URL before building the request', async () => {
    let requestedUrl = '';
    const fetchImpl = (async (url: string) => {
      requestedUrl = url;
      return { ok: true, json: async () => ({ success: true, data: SAMPLE_STATUS }) } as Response;
    }) as typeof fetch;

    await fetchPeerOpsStatus('http://192.168.86.36:3001/', fetchImpl);
    expect(requestedUrl).toBe('http://192.168.86.36:3001/api/ops/status');
  });

  it('reports unreachable with the HTTP status on a non-2xx response', async () => {
    const result = await fetchPeerOpsStatus(
      'http://192.168.86.36:3001',
      fakeFetch({ ok: false, status: 500, statusText: 'Internal Server Error' }),
    );
    expect(result.reachable).toBe(false);
    if (!result.reachable) expect(result.error).toBe('peer responded 500 Internal Server Error');
  });

  it('reports unreachable on connection refused, without throwing', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED 192.168.86.237:3001');
    }) as typeof fetch;

    const result = await fetchPeerOpsStatus('http://192.168.86.237:3001', fetchImpl);
    expect(result.reachable).toBe(false);
    if (!result.reachable) {
      expect(result.error).toContain('ECONNREFUSED');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('reports a clear timeout message rather than a raw AbortError', async () => {
    const fetchImpl = (async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }) as typeof fetch;

    const result = await fetchPeerOpsStatus('http://192.168.86.237:3001', fetchImpl, 5000);
    expect(result.reachable).toBe(false);
    if (!result.reachable) expect(result.error).toBe('timed out after 5000ms');
  });

  it('reports unreachable when the peer response is not valid JSON', async () => {
    const result = await fetchPeerOpsStatus(
      'http://192.168.86.36:3001',
      fakeFetch({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      }),
    );
    expect(result.reachable).toBe(false);
    if (!result.reachable) expect(result.error).toBe('peer response was not valid JSON');
  });

  it('reports unreachable when the peer answers 200 without the { success, data } envelope', async () => {
    const result = await fetchPeerOpsStatus(
      'http://192.168.86.36:3001',
      fakeFetch({ ok: true, json: async () => ({ oops: true }) }),
    );
    expect(result.reachable).toBe(false);
    if (!result.reachable) expect(result.error).toContain('envelope');
  });

  it('reports unreachable when success is false even on a 200', async () => {
    const result = await fetchPeerOpsStatus(
      'http://192.168.86.36:3001',
      fakeFetch({ ok: true, json: async () => ({ success: false, error: 'DATABASE_ERROR' }) }),
    );
    expect(result.reachable).toBe(false);
  });
});
