import type { CombinedOpsStatus } from '../services/combinedOpsStatusService.js';
import type { SideStatus } from '../services/peerOpsStatus.js';
import {
  DISK_WARN_RATIO,
  DISK_ERROR_RATIO,
  DISK_WARN_FREE_BYTES,
  DISK_ERROR_FREE_BYTES,
  type ThresholdState,
} from './opsStatusThresholds.js';

/**
 * Turns one `/api/ops/status/combined` payload into the flat list of per-KPI
 * verdicts the alert engine remembers and compares (ABL-287).
 *
 * Pure and type-only in its imports: `CombinedOpsStatus` and `SideStatus` come
 * in as `import type`, which TypeScript erases, so importing this module never
 * opens the database the way importing `combinedOpsStatusService.js` for real
 * would (`config/database.ts` connects as an import side effect). Same reason
 * `opsStatusThresholds.ts` imports only types.
 *
 * WHY THE LEAF KPIs AND NOT `derived.environment`
 *
 * `environment` is worst-wins over disk and freshness, so alerting on it *and*
 * on its inputs would fire twice for one bad disk — the badge's roll-up is a
 * rendering concern, not an alerting one. This module reads the leaves
 * (`derived.disk`, `derived.freshness`), plus reachability taken straight from
 * `side.reachable` and the cross-lane `derived.commitDrift`. That is exactly
 * the four KPIs the issue names — disk, freshness, peer reachability, commit
 * drift — with no KPI counted twice and no new metric invented here.
 *
 * Every verdict is read from `derived`, never re-derived: the thresholds have
 * one home (`opsStatusThresholds.ts`, ABL-292) and this is a consumer of it.
 * The raw numbers are read only to write the *evidence string* a human sees.
 */
export type AlertLane = 'local' | 'peer' | 'both';

export type AlertKpi = 'disk' | 'freshness' | 'reachability' | 'commitDrift';

export interface AlertObservation {
  /** Stable identity across ticks — this is what the last-fired record is keyed on. */
  key: string;
  lane: AlertLane;
  kpi: AlertKpi;
  state: ThresholdState;
  /** Human-readable evidence, e.g. "91.58% of disk used, 156.8 GiB free (warn; ...)". */
  detail: string;
  /**
   * True for the KPIs the ABL-220 sync blackout can knock over on its own —
   * anything that reaches the database. Held rather than fired inside the
   * window; see `opsAlertEngine.ts`.
   */
  blackoutSensitive: boolean;
}

export function observationKey(lane: AlertLane, kpi: AlertKpi): string {
  return `${lane}:${kpi}`;
}

const LANE_LABEL: Record<AlertLane, string> = {
  local: 'this environment',
  peer: 'the peer environment',
  both: 'both environments',
};

/**
 * Deliberately not "acceptance" / "prod": the same image runs as either side,
 * and this process has no field telling it which one it is (`provenance.runtime`
 * is only container-vs-dev). Naming a lane we cannot identify would put a
 * confident, possibly wrong environment name in an alert.
 */
export function laneLabel(lane: AlertLane): string {
  return LANE_LABEL[lane];
}

const GIB = 1024 ** 3;

const gib = (bytes: number, decimals = 0): string => `${(bytes / GIB).toFixed(decimals)} GiB`;

/**
 * Both halves of the verdict, in the message (ABL-586).
 *
 * The old text named only the percentages, which described a rule the code no
 * longer implements: a reader seeing "91.58% of disk used (warn; warn at 75%,
 * error at 90%)" would reasonably conclude the alert engine was broken. The
 * free-bytes reading is stated beside the percentage, and both floors beside
 * both ratios, so the sentence is checkable against `deriveDiskState` by
 * reading it.
 */
function describeDisk(side: SideStatus, state: ThresholdState): string {
  if (!side.reachable) return `not measured — side unreachable (${side.error})`;
  const disk = side.status.host.disk;
  if (disk === null || disk.totalBytes <= 0) return 'not measured — this host reports no disk usage';
  const pct = ((disk.usedBytes / disk.totalBytes) * 100).toFixed(2);
  const warnPct = (DISK_WARN_RATIO * 100).toFixed(0);
  const errorPct = (DISK_ERROR_RATIO * 100).toFixed(0);
  return (
    `${pct}% of disk used, ${gib(disk.freeBytes, 1)} free ` +
    `(${state}; warn at >=${warnPct}% used with <=${gib(DISK_WARN_FREE_BYTES)} free, ` +
    `error at >=${errorPct}% with <=${gib(DISK_ERROR_FREE_BYTES)} free)`
  );
}

function describeFreshness(side: SideStatus): string {
  if (!side.reachable) return `not measured — side unreachable (${side.error})`;
  const { status, staleCountries, unmeasured } = side.status.freshness;
  // ABL-657: the side answered but its database read failed. Naming the reason
  // is the whole point — "fleet freshness is none" would read as a verdict
  // about the data rather than as a failure to look at it.
  if (unmeasured !== undefined) return `not measured — database read failed (${unmeasured})`;
  const countries = staleCountries.length > 0 ? ` (${staleCountries.join(', ')})` : '';
  return `fleet freshness is ${status}${countries}`;
}

function describeReachability(side: SideStatus, configured: boolean): string {
  if (!configured) return 'no peer configured (OPS_PEER_URL is unset)';
  if (side.reachable) return `reachable in ${side.latencyMs}ms`;
  return `unreachable: ${side.error}`;
}

/**
 * Reachability as its own verdict, rather than reusing `derived.environment`
 * (which folds disk and freshness in). `unknown` for an unconfigured peer is
 * load-bearing: a dev checkout with no `OPS_PEER_URL` has not lost its peer, it
 * never had one, and must not alert every tick forever.
 */
function reachabilityState(side: SideStatus, configured: boolean, blackoutActive: boolean): ThresholdState {
  if (!configured) return 'unknown';
  if (side.reachable) return 'ok';
  return blackoutActive ? 'warn' : 'error';
}

function describeCommitDrift(local: SideStatus, peer: SideStatus, state: ThresholdState): string {
  if (state === 'unknown') return 'not comparable — a side is unreachable or reports no commit';
  const localCommit = local.reachable ? local.status.provenance.commit : null;
  const peerCommit = peer.reachable ? peer.status.provenance.commit : null;
  const shortLocal = localCommit ? localCommit.slice(0, 7) : 'unknown';
  const shortPeer = peerCommit ? peerCommit.slice(0, 7) : 'unknown';
  if (state === 'ok') return `both lanes on ${shortLocal}`;
  return `this environment is on ${shortLocal}, the peer is on ${shortPeer}`;
}

/**
 * The fixed KPI set, evaluated every tick. Always the same seven keys, so the
 * engine's carry-forward never has to reason about a key appearing or vanishing
 * between ticks — an unmeasured KPI comes back `'unknown'`, which is a verdict,
 * not an absence.
 */
export function observeCombinedStatus(status: CombinedOpsStatus): AlertObservation[] {
  const { local, peer, peerConfigured, derived } = status;
  const blackoutActive = status.syncBlackout.active;

  return [
    {
      key: observationKey('local', 'reachability'),
      lane: 'local',
      kpi: 'reachability',
      state: reachabilityState(local, true, blackoutActive),
      detail: describeReachability(local, true),
      blackoutSensitive: true,
    },
    {
      key: observationKey('peer', 'reachability'),
      lane: 'peer',
      kpi: 'reachability',
      state: reachabilityState(peer, peerConfigured, blackoutActive),
      detail: describeReachability(peer, peerConfigured),
      blackoutSensitive: true,
    },
    {
      key: observationKey('local', 'disk'),
      lane: 'local',
      kpi: 'disk',
      state: derived.local.disk,
      detail: describeDisk(local, derived.local.disk),
      // Disk is read off the filesystem (`getDiskUsage`), not the database, so
      // the write-lock window cannot invent a disk breach. Since ABL-657 a
      // locked database does not even cost us the reading: the side answers,
      // and only its freshness rollup degrades. (A side that is genuinely
      // unreachable still renders disk `'unknown'` upstream in
      // `deriveSideState` — held by the unknown rule, not by this flag.)
      blackoutSensitive: false,
    },
    {
      key: observationKey('peer', 'disk'),
      lane: 'peer',
      kpi: 'disk',
      state: derived.peer.disk,
      detail: describeDisk(peer, derived.peer.disk),
      blackoutSensitive: false,
    },
    {
      key: observationKey('local', 'freshness'),
      lane: 'local',
      kpi: 'freshness',
      state: derived.local.freshness,
      detail: describeFreshness(local),
      blackoutSensitive: true,
    },
    {
      key: observationKey('peer', 'freshness'),
      lane: 'peer',
      kpi: 'freshness',
      state: derived.peer.freshness,
      detail: describeFreshness(peer),
      blackoutSensitive: true,
    },
    {
      key: observationKey('both', 'commitDrift'),
      lane: 'both',
      kpi: 'commitDrift',
      state: derived.commitDrift,
      detail: describeCommitDrift(local, peer, derived.commitDrift),
      blackoutSensitive: false,
    },
  ];
}
