import { describe, it, expect } from 'vitest';
import { observeCombinedStatus, observationKey, laneLabel } from './opsAlertRules.js';
import type { CombinedOpsStatus } from '../services/combinedOpsStatusService.js';
import type { SideStatus } from './../services/peerOpsStatus.js';
import type { OpsStatus } from '../services/opsStatusService.js';
import { deriveSideState, deriveCommitDriftState } from './opsStatusThresholds.js';

function opsStatus(overrides: {
  usedBytes?: number;
  totalBytes?: number;
  diskNull?: boolean;
  freshness?: 'live' | 'stale' | 'ended' | 'none';
  staleCountries?: string[];
  commit?: string | null;
} = {}): OpsStatus {
  const {
    usedBytes = 100,
    totalBytes = 1000,
    diskNull = false,
    freshness = 'live',
    staleCountries = [],
    commit = 'abc1234567',
  } = overrides;

  return {
    timestamp: '2026-08-12T12:36:00.000Z',
    provenance: { commit, runtime: 'container', db_path: '/data/energy_dashboard.db' },
    host: {
      platform: 'linux',
      disk: diskNull ? null : { usedBytes, totalBytes, freeBytes: totalBytes - usedBytes },
      cpuLoad: null,
      network: null,
    },
    process: {
      uptimeSeconds: 100,
      memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 1 },
    },
    freshness: {
      status: freshness,
      countriesChecked: 3,
      streamsChecked: 12,
      counts: { live: 8, stale: staleCountries.length, ended: 0, none: 0 },
      staleCountries,
    },
  } as OpsStatus;
}

function reachable(status: OpsStatus, latencyMs = 3): SideStatus {
  return { reachable: true, latencyMs, status };
}

function unreachable(error = 'connect ECONNREFUSED'): SideStatus {
  return { reachable: false, latencyMs: 12, error };
}

/**
 * Builds the payload the way the real endpoint does — running the same
 * `deriveSideState`/`deriveCommitDriftState` the service calls — so these tests
 * cannot pass against a hand-written `derived` block that the endpoint would
 * never actually produce.
 */
function combined(
  local: SideStatus,
  peer: SideStatus,
  opts: { peerConfigured?: boolean; blackoutActive?: boolean } = {},
): CombinedOpsStatus {
  const { peerConfigured = true, blackoutActive = false } = opts;
  return {
    timestamp: '2026-08-12T12:36:00.000Z',
    local,
    peer,
    peerConfigured,
    syncBlackout: { active: blackoutActive, label: blackoutActive ? 'evening DB sync' : null },
    derived: {
      local: deriveSideState(local, blackoutActive),
      peer: deriveSideState(peer, blackoutActive),
      commitDrift: deriveCommitDriftState(local, peer),
    },
  } as CombinedOpsStatus;
}

function byKey(observations: ReturnType<typeof observeCombinedStatus>, key: string) {
  const found = observations.find((o) => o.key === key);
  if (!found) throw new Error(`no observation for ${key}`);
  return found;
}

describe('observeCombinedStatus — KPI set', () => {
  it('always returns the same seven keys, so the engine never sees a key appear or vanish', () => {
    const observations = observeCombinedStatus(combined(reachable(opsStatus()), reachable(opsStatus())));
    expect(observations.map((o) => o.key)).toEqual([
      'local:reachability',
      'peer:reachability',
      'local:disk',
      'peer:disk',
      'local:freshness',
      'peer:freshness',
      'both:commitDrift',
    ]);
  });

  it('returns the same seven keys even when both sides are unreachable', () => {
    const observations = observeCombinedStatus(combined(unreachable(), unreachable()));
    expect(observations).toHaveLength(7);
  });

  it('does not observe the environment roll-up — that would double-count a bad disk', () => {
    const observations = observeCombinedStatus(combined(reachable(opsStatus()), reachable(opsStatus())));
    expect(observations.map((o) => o.kpi)).not.toContain('environment');
  });

  it('marks only the database-backed KPIs blackout-sensitive', () => {
    const observations = observeCombinedStatus(combined(reachable(opsStatus()), reachable(opsStatus())));
    const sensitive = observations.filter((o) => o.blackoutSensitive).map((o) => o.key);
    expect(sensitive).toEqual([
      'local:reachability',
      'peer:reachability',
      'local:freshness',
      'peer:freshness',
    ]);
  });

  it('builds keys with the shared helper', () => {
    expect(observationKey('peer', 'disk')).toBe('peer:disk');
    expect(laneLabel('both')).toBe('both environments');
  });
});

describe('observeCombinedStatus — disk', () => {
  /**
   * The message has to name both halves of the rule (ABL-586). Text that said
   * only "warn at 75%, error at 90%" described a rule the code stopped
   * implementing the moment a free-bytes floor was added to the conjunction —
   * a reader seeing 91.58% beside a `warn` would have concluded the engine was
   * broken rather than that 156.8 GiB is above the error floor.
   */
  it('reads the verdict from derived and names both halves of the rule', () => {
    // The exact numbers observed on acceptance at 18:06 UTC on 2026-08-27.
    const status = opsStatus({ usedBytes: 1_830_809_317_376, totalBytes: 1_999_203_463_168 });
    const observations = observeCombinedStatus(combined(reachable(status), reachable(opsStatus())));
    const disk = byKey(observations, 'local:disk');

    expect(disk.state).toBe('warn');
    expect(disk.detail).toBe(
      '91.58% of disk used, 156.8 GiB free ' +
        '(warn; warn at >=75% used with <=250 GiB free, error at >=90% with <=100 GiB free)',
    );
  });

  it('is error above the 90% threshold once the volume is genuinely low', () => {
    const status = opsStatus({ usedBytes: 950, totalBytes: 1000 });
    const disk = byKey(
      observeCombinedStatus(combined(reachable(status), reachable(opsStatus()))),
      'local:disk',
    );
    expect(disk.state).toBe('error');
    expect(disk.detail).toContain('95.00% of disk used, 0.0 GiB free');
  });

  it('is unknown — not ok — for an unreachable side, and says why', () => {
    const disk = byKey(
      observeCombinedStatus(combined(unreachable('timed out after 5000ms'), reachable(opsStatus()))),
      'local:disk',
    );
    expect(disk.state).toBe('unknown');
    expect(disk.detail).toBe('not measured — side unreachable (timed out after 5000ms)');
  });

  it('is unknown when the host reports no disk at all', () => {
    const disk = byKey(
      observeCombinedStatus(combined(reachable(opsStatus({ diskNull: true })), reachable(opsStatus()))),
      'local:disk',
    );
    expect(disk.state).toBe('unknown');
    expect(disk.detail).toBe('not measured — this host reports no disk usage');
  });
});

describe('observeCombinedStatus — freshness', () => {
  it('reports stale as warn and names the countries', () => {
    const status = opsStatus({ freshness: 'stale', staleCountries: ['AL', 'CH', 'MK'] });
    const freshness = byKey(
      observeCombinedStatus(combined(reachable(status), reachable(opsStatus()))),
      'local:freshness',
    );
    expect(freshness.state).toBe('warn');
    expect(freshness.detail).toBe('fleet freshness is stale (AL, CH, MK)');
  });

  it('reports live as ok', () => {
    const freshness = byKey(
      observeCombinedStatus(combined(reachable(opsStatus()), reachable(opsStatus()))),
      'local:freshness',
    );
    expect(freshness.state).toBe('ok');
  });

  it.each(['ended', 'none'] as const)('reports %s as unknown, never ok', (status) => {
    const freshness = byKey(
      observeCombinedStatus(combined(reachable(opsStatus({ freshness: status })), reachable(opsStatus()))),
      'local:freshness',
    );
    expect(freshness.state).toBe('unknown');
  });
});

describe('observeCombinedStatus — reachability', () => {
  it('is ok with the latency when the side answers', () => {
    const reach = byKey(
      observeCombinedStatus(combined(reachable(opsStatus(), 42), reachable(opsStatus()))),
      'local:reachability',
    );
    expect(reach.state).toBe('ok');
    expect(reach.detail).toBe('reachable in 42ms');
  });

  it('is error with the reason when the peer is down', () => {
    const reach = byKey(
      observeCombinedStatus(combined(reachable(opsStatus()), unreachable('peer responded 502 Bad Gateway'))),
      'peer:reachability',
    );
    expect(reach.state).toBe('error');
    expect(reach.detail).toBe('unreachable: peer responded 502 Bad Gateway');
  });

  it('downgrades an unreachable side to warn inside the blackout window', () => {
    const reach = byKey(
      observeCombinedStatus(combined(reachable(opsStatus()), unreachable(), { blackoutActive: true })),
      'peer:reachability',
    );
    expect(reach.state).toBe('warn');
  });

  it('is unknown — never error — when no peer is configured', () => {
    // A dev checkout with no OPS_PEER_URL has not lost its peer; it never had
    // one. Alerting here would fire on every developer machine forever.
    const reach = byKey(
      observeCombinedStatus(
        combined(reachable(opsStatus()), unreachable('OPS_PEER_URL is not configured'), {
          peerConfigured: false,
        }),
      ),
      'peer:reachability',
    );
    expect(reach.state).toBe('unknown');
    expect(reach.detail).toBe('no peer configured (OPS_PEER_URL is unset)');
  });
});

describe('observeCombinedStatus — commit drift', () => {
  it('is warn with both short shas when the lanes are on different builds', () => {
    const drift = byKey(
      observeCombinedStatus(
        combined(
          reachable(opsStatus({ commit: 'aaaaaaa1111' })),
          reachable(opsStatus({ commit: 'bbbbbbb2222' })),
        ),
      ),
      'both:commitDrift',
    );
    expect(drift.state).toBe('warn');
    expect(drift.detail).toBe('this environment is on aaaaaaa, the peer is on bbbbbbb');
  });

  it('is ok when both lanes report the same commit', () => {
    const drift = byKey(
      observeCombinedStatus(
        combined(reachable(opsStatus({ commit: 'same999x' })), reachable(opsStatus({ commit: 'same999x' }))),
      ),
      'both:commitDrift',
    );
    expect(drift.state).toBe('ok');
    expect(drift.detail).toBe('both lanes on same999');
  });

  it('is unknown when a side reports no commit — a dev server is not evidence of agreement', () => {
    const drift = byKey(
      observeCombinedStatus(
        combined(reachable(opsStatus({ commit: null })), reachable(opsStatus({ commit: 'abc1234' }))),
      ),
      'both:commitDrift',
    );
    expect(drift.state).toBe('unknown');
    expect(drift.detail).toBe('not comparable — a side is unreachable or reports no commit');
  });

  it('is unknown when a side is unreachable', () => {
    const drift = byKey(
      observeCombinedStatus(combined(reachable(opsStatus()), unreachable())),
      'both:commitDrift',
    );
    expect(drift.state).toBe('unknown');
  });
});
