import type { DiskUsage } from '../services/hostMetrics.js';
import type { FreshnessStatus } from '../types/index.js';
import type { SideStatus } from '../services/peerOpsStatus.js';

/**
 * The one place the ops-status warn/error thresholds live (ABL-292).
 *
 * This derivation started life in `client/src/lib/opsStatusThresholds.ts` for
 * the ABL-238 status page, which meant the only thing that could turn a KPI
 * into a verdict was a browser. The alert engine (ABL-287) is a server-side
 * scheduled job and cannot import browser code, so rather than let it grow a
 * second copy of `DISK_ERROR_RATIO` — thresholds that silently disagree are
 * how a page says "fine" while a pager says "critical" — the derivation moved
 * here and `/api/ops/status/combined` now ships the verdict alongside the raw
 * numbers. Three consumers read it: the alert engine, the trend view
 * (ABL-288), and the `/ops-status` page, which no longer derives anything.
 *
 * **Server-side, not a `shared/` workspace.** The repo has exactly two npm
 * workspaces (`package.json:6`), and the client already hand-mirrors every
 * server response type into `client/src/types/index.ts` (see that file's
 * "Ops status" block) rather than importing across the boundary. A third
 * workspace would need its own package, its own build step, and two more
 * `COPY` layers in `docker/Dockerfile` — real cost for a module whose only
 * client-side need is a four-member string union. The thresholds and the
 * logic live here once; the client consumes the computed verdict over HTTP
 * and mirrors only the type, exactly as it does for `FreshnessRollup`.
 *
 * Kept to the two metrics with a defensible, universal threshold — disk usage
 * ratio and the existing freshness severity ranking
 * (`services/freshnessRollup.ts`) — rather than inventing a CPU-load or memory
 * threshold with no known capacity to measure against on this host.
 * `ended`/`none` freshness and a missing disk reading are `'unknown'`, not
 * `'ok'`: this codebase's rule is that an unmeasured metric must never render
 * as a clean bill of health.
 */
export type ThresholdState = 'ok' | 'warn' | 'error' | 'unknown';

/**
 * Relocated verbatim from the client module (ABL-292 is a move plus an
 * additive field, not a re-tuning). Exported so a consumer that wants to say
 * *why* it fired — "85.11% of disk, warn at 75%" — reads the number from here
 * instead of restating it.
 */
export const DISK_WARN_RATIO = 0.75;
export const DISK_ERROR_RATIO = 0.9;

export function deriveDiskState(disk: DiskUsage | null): ThresholdState {
  if (disk === null || disk.totalBytes <= 0) return 'unknown';
  const ratio = disk.usedBytes / disk.totalBytes;
  if (ratio >= DISK_ERROR_RATIO) return 'error';
  if (ratio >= DISK_WARN_RATIO) return 'warn';
  return 'ok';
}

/**
 * `stale` is the only one of the four freshness verdicts that names an
 * actionable problem (see `freshnessRollup.ts`'s `SEVERITY` ranking, which
 * this mirrors) — `ended`/`none` are documented non-alarm verdicts, so they
 * read `'unknown'` here rather than `'ok'` (a country we've never held data
 * for is not evidence the environment is healthy) or `'warn'` (it is not an
 * alarm either).
 */
export function deriveFreshnessState(status: FreshnessStatus): ThresholdState {
  if (status === 'stale') return 'warn';
  if (status === 'live') return 'ok';
  return 'unknown';
}

/** Worst-wins, but "unknown" never outranks a real "ok" — only an all-unknown input reports unknown. */
function worstOf(states: ThresholdState[]): ThresholdState {
  if (states.includes('error')) return 'error';
  if (states.includes('warn')) return 'warn';
  if (states.every((s) => s === 'unknown')) return 'unknown';
  return 'ok';
}

/**
 * One environment's overall badge state. An unreachable side is `'error'` —
 * unless `blackoutActive`, in which case it is downgraded to `'warn'`: the
 * known ABL-220 DB-sync lock window, not a genuine outage (see
 * `syncBlackoutWindow.ts`). A reachable side combines disk usage and the
 * fleet-wide freshness verdict, worst-wins.
 */
export function deriveEnvironmentState(side: SideStatus, blackoutActive: boolean): ThresholdState {
  if (!side.reachable) return blackoutActive ? 'warn' : 'error';
  return worstOf([
    deriveDiskState(side.status.host.disk),
    deriveFreshnessState(side.status.freshness.status),
  ]);
}

/**
 * Commit drift between the two lanes — the one verdict that is a *comparison*
 * rather than a property of either side, which is why it lives beside the
 * per-side verdicts instead of inside `OpsSideDerived`.
 *
 * `warn`, never `error`: two environments on different builds is worth telling
 * someone about, but it is a normal state for the minutes between deploying one
 * lane and the other, and paging on it would page on every rollout.
 *
 * `unknown` — not `ok` — whenever there is nothing to compare: either side
 * unreachable, or either `commit` null. A null `commit` means a dev server that
 * never had `COMMIT_SHA` baked in (`healthProvenance.ts:23`), so "they match"
 * would be a fabricated clean bill of health for two hosts whose builds we
 * simply did not measure.
 */
export function deriveCommitDriftState(local: SideStatus, peer: SideStatus): ThresholdState {
  if (!local.reachable || !peer.reachable) return 'unknown';
  const localCommit = local.status.provenance.commit;
  const peerCommit = peer.status.provenance.commit;
  if (!localCommit || !peerCommit) return 'unknown';
  return localCommit === peerCommit ? 'ok' : 'warn';
}

/** Per-KPI verdicts for one environment, plus the worst-wins roll-up the badge renders. */
export interface OpsSideDerived {
  /** Worst-wins over the KPIs below, with the unreachable/blackout rule applied first. */
  environment: ThresholdState;
  disk: ThresholdState;
  freshness: ThresholdState;
}

/**
 * Every verdict one side of `/api/ops/status/combined` supports.
 *
 * An unreachable side reports `'unknown'` per KPI rather than inheriting the
 * environment's `'error'`: we did not measure its disk at 100%, we did not
 * measure it at all, and an alert rule keyed on `disk === 'error'` must not
 * fire on a peer that merely timed out. The environment verdict is where
 * "unreachable" is expressed, and it is the field a reachability alert reads.
 */
export function deriveSideState(side: SideStatus, blackoutActive: boolean): OpsSideDerived {
  return {
    environment: deriveEnvironmentState(side, blackoutActive),
    disk: side.reachable ? deriveDiskState(side.status.host.disk) : 'unknown',
    freshness: side.reachable ? deriveFreshnessState(side.status.freshness.status) : 'unknown',
  };
}
