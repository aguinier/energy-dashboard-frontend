import { describe, it, expect } from 'vitest';
import {
  deriveDiskState,
  deriveFreshnessState,
  deriveEnvironmentState,
  deriveSideState,
  diskErrorPercentForVolume,
  DISK_WARN_RATIO,
  DISK_ERROR_RATIO,
  DISK_WARN_FREE_BYTES,
  DISK_ERROR_FREE_BYTES,
} from './opsStatusThresholds.js';
import type { OpsStatus } from '../services/opsStatusService.js';
import type { SideStatus } from '../services/peerOpsStatus.js';
import {
  unmeasuredFreshnessRollup,
  type FreshnessRollup,
} from '../services/freshnessRollup.js';

/**
 * Pure — `opsStatusThresholds.ts` imports only *types* from
 * `opsStatusService.js`/`peerOpsStatus.js`, which erase at compile time, so
 * nothing here pulls in `config/database.js` and this suite runs regardless of
 * whether `better-sqlite3` is ABI-compatible with the running Node (CLAUDE.md,
 * "NODE_MODULE_VERSION mismatch"). Ported from the client's
 * `lib/opsStatusThresholds.test.ts`, which ABL-292 deleted along with the
 * client copy of the derivation.
 *
 * `unmeasuredFreshnessRollup` is imported as a *value* and does not break that
 * (ABL-657): `freshnessRollup.ts` has no runtime imports at all — both of its
 * imports are `import type` and erase — so it is a pure function module, not a
 * door into `config/database.js`.
 */

const disk = (usedBytes: number, totalBytes: number) => ({ totalBytes, freeBytes: totalBytes - usedBytes, usedBytes });

const GIB = 1024 ** 3;

/**
 * The two real volumes, byte-exact off `/api/ops/status/combined` on prod at
 * 2026-08-27T18:06Z. Prod's is a provisioned server volume; acceptance's is a
 * workstation `C:` the containers are one tenant on, ~92% of whose used space
 * belongs to a third party (ABL-586).
 */
const PROD_VOLUME_BYTES = 974_021_873_664; // 907.13 GiB
const ACCEPTANCE_VOLUME_BYTES = 1_999_203_463_168; // 1861.90 GiB

/** Used-bytes at a given used-percent, rounded up so the ratio is at or above it. */
const atPercent = (totalBytes: number, percent: number) =>
  disk(Math.ceil((totalBytes * percent) / 100), totalBytes);

describe('deriveDiskState', () => {
  it('is unknown when disk usage could not be measured', () => {
    expect(deriveDiskState(null)).toBe('unknown');
  });

  it('is ok well under the warn threshold', () => {
    expect(deriveDiskState(disk(50, 100))).toBe('ok');
  });

  it('is ok just below the warn threshold', () => {
    expect(deriveDiskState(disk(74_999, 100_000))).toBe('ok');
  });

  it('is warn at exactly the 75% threshold', () => {
    expect(deriveDiskState(disk(75, 100))).toBe('warn');
  });

  it('is warn just below the error threshold', () => {
    expect(deriveDiskState(disk(89_999, 100_000))).toBe('warn');
  });

  it('is error at exactly the 90% threshold', () => {
    expect(deriveDiskState(disk(90, 100))).toBe('error');
  });

  it('is error above the error threshold', () => {
    expect(deriveDiskState(disk(99, 100))).toBe('error');
  });

  it('is unknown rather than dividing by zero when totalBytes is 0', () => {
    expect(deriveDiskState(disk(0, 0))).toBe('unknown');
  });

  it('is unknown, not ok, when a byte count is not a finite number', () => {
    // `NaN >= 0.9` is false, so before ABL-586 this fell out of the bottom of
    // the ladder as 'ok' — an unmeasured disk rendering as a clean bill.
    expect(deriveDiskState(disk(Number.NaN, 100))).toBe('unknown');
    expect(deriveDiskState({ totalBytes: Number.NaN, freeBytes: 1, usedBytes: 1 })).toBe('unknown');
  });

  it('holds the ratio thresholds — ABL-292 moved them, ABL-586 did not re-tune them either', () => {
    expect(DISK_WARN_RATIO).toBe(0.75);
    expect(DISK_ERROR_RATIO).toBe(0.9);
  });

  it('holds the free-bytes floors at 250 GiB (warn) and 100 GiB (error)', () => {
    expect(DISK_WARN_FREE_BYTES).toBe(250 * GIB);
    expect(DISK_ERROR_FREE_BYTES).toBe(100 * GIB);
  });
});

/**
 * ABL-586: escalation needs the volume to be *both* proportionally full and
 * absolutely low.
 *
 * The two describe blocks below are the pair this change has to be judged on
 * together. The first is the suppression the issue asked for; the second is the
 * positive control that the suppression did not swallow a real one. Deleting
 * either half of the conjunction in `deriveDiskState` turns one of them red.
 */
describe('deriveDiskState — the free-bytes floor', () => {
  /**
   * The exhaustive form of "prod's behaviour is unchanged" — not a spot check
   * at the two lines, but every 0.01% of prod's real volume compared against a
   * local re-implementation of the pre-ABL-586 ratio-only rule. Zero
   * disagreements across 10,001 points.
   *
   * It holds because both floors sit *below* their ratio lines on a volume this
   * size: prod crosses 250 GiB free at 72.44% used and 100 GiB free at 88.98%,
   * so by the time either ratio line is reached its floor is long since
   * breached and the ratio is still the binding constraint. Anything at or
   * under the 1,000 GiB reference volume behaves this way; prod is 907.13 GiB.
   */
  it('is bit-identical to the ratio-only rule at every point of prod’s real volume', () => {
    const ratioOnly = (used: number, total: number) => {
      const ratio = used / total;
      if (ratio >= DISK_ERROR_RATIO) return 'error';
      if (ratio >= DISK_WARN_RATIO) return 'warn';
      return 'ok';
    };

    const disagreements: number[] = [];
    for (let i = 0; i <= 10_000; i += 1) {
      const used = Math.round((PROD_VOLUME_BYTES * i) / 10_000);
      if (deriveDiskState(disk(used, PROD_VOLUME_BYTES)) !== ratioOnly(used, PROD_VOLUME_BYTES)) {
        disagreements.push(i / 100);
      }
    }

    expect(disagreements).toEqual([]);
  });

  it('shows why: prod is already under both floors when it reaches each ratio line', () => {
    expect(atPercent(PROD_VOLUME_BYTES, 75).freeBytes).toBeLessThanOrEqual(DISK_WARN_FREE_BYTES);
    expect(atPercent(PROD_VOLUME_BYTES, 90).freeBytes).toBeLessThanOrEqual(DISK_ERROR_FREE_BYTES);
    // 226.78 GiB and 90.71 GiB respectively — the floors do not bind here.
    expect(deriveDiskState(atPercent(PROD_VOLUME_BYTES, 74.99))).toBe('ok');
    expect(deriveDiskState(atPercent(PROD_VOLUME_BYTES, 75))).toBe('warn');
    expect(deriveDiskState(atPercent(PROD_VOLUME_BYTES, 89.99))).toBe('warn');
    expect(deriveDiskState(atPercent(PROD_VOLUME_BYTES, 90))).toBe('error');
  });

  /**
   * The defect, in the numbers that were live when it was filed. 91.58% of a
   * 1861.90 GiB workstation volume left 156.83 GiB free — 73% more headroom
   * than prod holds at the moment prod first turns red (90.71 GiB) — and read
   * `error` on the strength of the denominator alone.
   *
   * **This is the test that goes red if the floor is deleted from the error
   * branch**, so it is also the guard on the whole change.
   */
  it('reads the live acceptance breach (91.58%, 156.83 GiB free) as warn, not error', () => {
    const acceptance = disk(1_830_809_317_376, ACCEPTANCE_VOLUME_BYTES);

    expect(acceptance.freeBytes).toBeGreaterThan(DISK_ERROR_FREE_BYTES);
    expect(acceptance.freeBytes).toBeGreaterThan(PROD_VOLUME_BYTES * (1 - DISK_ERROR_RATIO));
    expect(deriveDiskState(acceptance)).toBe('warn');
  });

  /**
   * Deliberately replaces ABL-292's "85.11% is warn" pin, which expressed the
   * acceptance reading as a ratio on a 10,000-byte volume and so kept passing
   * unchanged through ABL-586 while no longer describing the reading it named.
   * On the real volume 85.11% left 277.27 GiB free — more absolute headroom
   * than prod's *entire* warn line (226.78 GiB) — so it is `ok` now, and the
   * warn floor is what says so.
   *
   * ABL-292's comment invited an objection if a re-tuning moved
   * `DISK_ERROR_RATIO` below 0.8511. That objection is not owed here: neither
   * ratio moved, and this reading changed lane because a second, absolute
   * condition was added, not because the percentage line did.
   */
  it('reads ABL-292’s 85.11% acceptance reading as ok on the real volume — 277 GiB free', () => {
    const abl292 = disk(1_701_490_991_104, ACCEPTANCE_VOLUME_BYTES);

    expect(abl292.freeBytes).toBeGreaterThan(DISK_WARN_FREE_BYTES);
    expect(abl292.freeBytes).toBeGreaterThan(PROD_VOLUME_BYTES * (1 - DISK_WARN_RATIO));
    expect(deriveDiskState(abl292)).toBe('ok');
  });

  it('still warns on the acceptance volume — the floor suppresses the red, not the signal', () => {
    // 86.58% is the first point past the 250 GiB warn floor on that volume.
    expect(deriveDiskState(atPercent(ACCEPTANCE_VOLUME_BYTES, 86.58))).toBe('warn');
    expect(deriveDiskState(atPercent(ACCEPTANCE_VOLUME_BYTES, 94.63))).toBe('error');
  });
});

describe('deriveDiskState — positive control: a genuinely exhausting volume still escalates', () => {
  /** 200 GiB volume at 95% used: 10 GiB left. Small, proportionally full, and actually nearly gone. */
  const small = disk(Math.ceil(200 * GIB * 0.95), 200 * GIB);

  it('is error at 95% of a 200 GiB volume with 10 GiB free', () => {
    expect(small.freeBytes).toBeLessThanOrEqual(10 * GIB);
    expect(deriveDiskState(small)).toBe('error');
  });

  it('escalates a small volume through ok -> warn -> error as it fills', () => {
    expect(deriveDiskState(atPercent(200 * GIB, 50))).toBe('ok');
    expect(deriveDiskState(atPercent(200 * GIB, 80))).toBe('warn');
    expect(deriveDiskState(atPercent(200 * GIB, 91))).toBe('error');
  });

  it('escalates on a volume with only bytes left, whatever its size', () => {
    expect(deriveDiskState(disk(999_999, 1_000_000))).toBe('error');
    expect(deriveDiskState(disk(9_999 * GIB, 10_000 * GIB))).toBe('error');
  });

  /**
   * The floor is read from `freeBytes`, which arrives from an unvalidated peer
   * payload (`peerOpsStatus.ts` casts `envelope.data`). A peer that omitted it
   * must not silently suppress the escalation — the fallback recomputes it from
   * the two fields the ratio already needs.
   */
  it('falls back to total-minus-used when a peer reports no freeBytes', () => {
    const missing = { totalBytes: 200 * GIB, usedBytes: Math.ceil(200 * GIB * 0.95) } as {
      totalBytes: number;
      freeBytes: number;
      usedBytes: number;
    };

    expect(deriveDiskState(missing)).toBe('error');
  });
});

describe('diskErrorPercentForVolume', () => {
  it('is the ratio line on any volume at or under the 1,000 GiB reference', () => {
    expect(diskErrorPercentForVolume(PROD_VOLUME_BYTES)).toBe(90);
    expect(diskErrorPercentForVolume(200 * GIB)).toBe(90);
    expect(diskErrorPercentForVolume(1000 * GIB)).toBe(90);
  });

  it('is the floor crossing on a larger volume — 94.62% on acceptance, not 90%', () => {
    expect(diskErrorPercentForVolume(ACCEPTANCE_VOLUME_BYTES)).toBe(94.62);
  });

  it('agrees with deriveDiskState about where the badge turns red', () => {
    const percent = diskErrorPercentForVolume(ACCEPTANCE_VOLUME_BYTES);
    expect(deriveDiskState(atPercent(ACCEPTANCE_VOLUME_BYTES, percent - 0.01))).not.toBe('error');
    // Floored to 2 dp, so the named percent can sit a sliver under the true
    // crossing; a hundredth of a point past it is red on both sides.
    expect(deriveDiskState(atPercent(ACCEPTANCE_VOLUME_BYTES, percent + 0.01))).toBe('error');
  });

  it('never returns less than the ratio line, and returns exactly it for an unmeasurable volume', () => {
    expect(diskErrorPercentForVolume(0)).toBe(90);
    expect(diskErrorPercentForVolume(-1)).toBe(90);
    expect(diskErrorPercentForVolume(Number.NaN)).toBe(90);
    for (const total of [1, GIB, 900 * GIB, 5000 * GIB, 1e15]) {
      expect(diskErrorPercentForVolume(total)).toBeGreaterThanOrEqual(90);
    }
  });
});

const rollup = (status: FreshnessRollup['status']): FreshnessRollup => ({
  status,
  countriesChecked: 7,
  streamsChecked: 35,
  counts: { live: 0, stale: 0, ended: 0, none: 0 },
  staleCountries: [],
});

describe('deriveFreshnessState', () => {
  it('maps stale to warn — the one actionable verdict', () => {
    expect(deriveFreshnessState(rollup('stale'), false)).toBe('warn');
  });

  it('maps live to ok', () => {
    expect(deriveFreshnessState(rollup('live'), false)).toBe('ok');
  });

  it('maps ended to unknown, not ok — a terminal non-alarm is not evidence of health', () => {
    expect(deriveFreshnessState(rollup('ended'), false)).toBe('unknown');
  });

  it('maps none to unknown', () => {
    expect(deriveFreshnessState(rollup('none'), false)).toBe('unknown');
  });

  it('a blackout does not soften a *measured* verdict — a stale fleet at 07:05 is still stale', () => {
    expect(deriveFreshnessState(rollup('stale'), true)).toBe('warn');
    expect(deriveFreshnessState(rollup('live'), true)).toBe('ok');
  });

  /**
   * ABL-657. The rollup that could not be measured is the case that used to
   * arrive as an unreachable side; it now arrives here, and must not read as
   * any of the four verdicts above.
   */
  it('is error when the rollup is unmeasured outside the sync window', () => {
    expect(deriveFreshnessState(unmeasuredFreshnessRollup('database is locked'), false)).toBe('error');
  });

  it('is warn, not error, when the rollup is unmeasured inside the sync window', () => {
    expect(deriveFreshnessState(unmeasuredFreshnessRollup('database is locked'), true)).toBe('warn');
  });

  it('is never unknown for an unmeasured rollup — the alert engine holds unknown, and a dead DB must reach someone', () => {
    for (const blackout of [false, true]) {
      expect(deriveFreshnessState(unmeasuredFreshnessRollup('boom'), blackout)).not.toBe('unknown');
    }
  });

  it('reads `unmeasured` and not `status`: the same empty `none` shape derives differently once it carries a reason', () => {
    const empty = unmeasuredFreshnessRollup('attempt to write a readonly database');
    expect(empty.status).toBe('none');
    expect(deriveFreshnessState({ ...empty, unmeasured: undefined }, false)).toBe('unknown');
    expect(deriveFreshnessState(empty, false)).toBe('error');
  });
});

const SAMPLE_STATUS: OpsStatus = {
  timestamp: '2026-08-11T20:00:00.000Z',
  provenance: { commit: 'abc123', runtime: 'container', db_path: '/data/energy_dashboard.db' },
  host: { platform: 'linux', disk: disk(50, 100), cpuLoad: { load1: 0.1, load5: 0.2, load15: 0.3 } },
  process: { uptimeSeconds: 100, memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 1 } },
  freshness: { status: 'live', countriesChecked: 7, streamsChecked: 35, counts: { live: 35, stale: 0, ended: 0, none: 0 }, staleCountries: [] },
  visitors: { countingSince: '2026-08-11T00:00:00.000Z', day: '2026-08-11', today: { page: 0, api: 0, asset: 0, automated: 0 }, window: { page: 0, api: 0, asset: 0, automated: 0 }, windowDaysCovered: 1, windowComplete: false, distinctClientsToday: 0 },
};

function reachable(overrides: Partial<OpsStatus> = {}): SideStatus {
  return { reachable: true, latencyMs: 10, status: { ...SAMPLE_STATUS, ...overrides } };
}

describe('deriveEnvironmentState', () => {
  it('is error when unreachable outside the sync blackout window', () => {
    const side: SideStatus = { reachable: false, latencyMs: null, error: 'connection refused' };
    expect(deriveEnvironmentState(side, false)).toBe('error');
  });

  it('is warn, not error, when unreachable during the known sync blackout window', () => {
    const side: SideStatus = { reachable: false, latencyMs: null, error: 'DATABASE_ERROR' };
    expect(deriveEnvironmentState(side, true)).toBe('warn');
  });

  it('is ok when reachable with healthy disk and live freshness', () => {
    expect(deriveEnvironmentState(reachable(), false)).toBe('ok');
  });

  it('is warn when reachable but disk usage crosses the warn threshold', () => {
    const side = reachable({ host: { platform: 'linux', disk: disk(80, 100), cpuLoad: null } });
    expect(deriveEnvironmentState(side, false)).toBe('warn');
  });

  it('worst-wins: an error disk state outranks a warn freshness state', () => {
    const side = reachable({
      host: { platform: 'linux', disk: disk(95, 100), cpuLoad: null },
      freshness: { status: 'stale', countriesChecked: 7, streamsChecked: 35, counts: { live: 30, stale: 5, ended: 0, none: 0 }, staleCountries: ['GB'] },
    });
    expect(deriveEnvironmentState(side, false)).toBe('error');
  });

  it('is unknown, not ok, when reachable but every metric is unmeasured', () => {
    const side = reachable({
      host: { platform: 'win32', disk: null, cpuLoad: null },
      freshness: { status: 'none', countriesChecked: 0, streamsChecked: 0, counts: { live: 0, stale: 0, ended: 0, none: 0 }, staleCountries: [] },
    });
    expect(deriveEnvironmentState(side, false)).toBe('unknown');
  });

  it('a blackout never softens a *measured* KPI — a full disk at 07:05 is still a full disk', () => {
    const side = reachable({ host: { platform: 'linux', disk: disk(95, 100), cpuLoad: null } });
    expect(deriveEnvironmentState(side, true)).toBe('error');
  });

  /**
   * ABL-657's badge case, end to end through the roll-up. Before the fix the
   * sync lock made the side *unreachable*, which the first two cases above
   * cover; now the side answers and only its freshness rollup is unmeasured,
   * so the softening has to reach it there or the badge flaps red anyway.
   */
  it('is error when reachable but the freshness rollup could not be measured', () => {
    const side = reachable({ freshness: unmeasuredFreshnessRollup('attempt to write a readonly database') });
    expect(deriveEnvironmentState(side, false)).toBe('error');
  });

  it('is warn when that same unmeasured rollup lands inside the sync blackout window', () => {
    const side = reachable({ freshness: unmeasuredFreshnessRollup('attempt to write a readonly database') });
    expect(deriveEnvironmentState(side, true)).toBe('warn');
  });
});

describe('deriveSideState', () => {
  it('reports each KPI alongside the worst-wins environment verdict', () => {
    const side = reachable({
      host: { platform: 'linux', disk: disk(76, 100), cpuLoad: null },
      freshness: { status: 'live', countriesChecked: 7, streamsChecked: 35, counts: { live: 35, stale: 0, ended: 0, none: 0 }, staleCountries: [] },
    });

    expect(deriveSideState(side, false)).toEqual({ environment: 'warn', disk: 'warn', freshness: 'ok' });
  });

  it('reports unknown per KPI for an unreachable side — a peer that timed out has no measured disk', () => {
    const side: SideStatus = { reachable: false, latencyMs: 5001, error: 'timed out after 5000ms' };

    expect(deriveSideState(side, false)).toEqual({ environment: 'error', disk: 'unknown', freshness: 'unknown' });
  });

  it('keeps the per-KPI unknowns while the environment softens to warn inside the blackout window', () => {
    const side: SideStatus = { reachable: false, latencyMs: null, error: 'SQLITE_BUSY: database is locked' };

    expect(deriveSideState(side, true)).toEqual({ environment: 'warn', disk: 'unknown', freshness: 'unknown' });
  });

  it('does not let a stale-freshness warn leak into the disk verdict, or vice versa', () => {
    const side = reachable({
      host: { platform: 'linux', disk: disk(10, 100), cpuLoad: null },
      freshness: { status: 'stale', countriesChecked: 7, streamsChecked: 35, counts: { live: 30, stale: 5, ended: 0, none: 0 }, staleCountries: ['GB'] },
    });

    expect(deriveSideState(side, false)).toEqual({ environment: 'warn', disk: 'ok', freshness: 'warn' });
  });

  /**
   * ABL-657: an unreadable database must not cost us the disk reading. The
   * side answered — its host metrics are as measured as they ever were — so
   * only `freshness` degrades, unlike the unreachable case two tests up where
   * every KPI is honestly `unknown`.
   */
  it('degrades only freshness when the side answers but its database read failed', () => {
    const side = reachable({
      host: { platform: 'linux', disk: disk(10, 100), cpuLoad: null },
      freshness: unmeasuredFreshnessRollup('attempt to write a readonly database'),
    });

    expect(deriveSideState(side, false)).toEqual({ environment: 'error', disk: 'ok', freshness: 'error' });
    expect(deriveSideState(side, true)).toEqual({ environment: 'warn', disk: 'ok', freshness: 'warn' });
  });
});
