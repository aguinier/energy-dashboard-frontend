import type { DiskUsage } from '../services/hostMetrics.js';
import type { FreshnessRollup } from '../services/freshnessRollup.js';
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
 * Kept to the two metrics with a defensible, universal threshold — disk
 * exhaustion risk and the existing freshness severity ranking
 * (`services/freshnessRollup.ts`) — rather than inventing a CPU-load or memory
 * threshold with no known capacity to measure against on this host. Disk is
 * two numbers, not one: a used-*ratio* and a free-*bytes* floor, both of which
 * must breach before the verdict escalates (see `DISK_WARN_FREE_BYTES`).
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

const GIB = 1024 ** 3;

/**
 * Absolute free-space floors, the second half of the escalation condition
 * (ABL-586).
 *
 * WHY A RATIO ALONE IS THE WRONG TEST
 *
 * Percentage-used is a sound proxy for exhaustion risk on a volume provisioned
 * *for us*: the denominator is then a statement about how much room we were
 * given. It is not a proxy at all on a volume whose size has nothing to do with
 * what we store on it. The acceptance lane is the second kind — a workstation
 * `C:` the acceptance containers are one tenant on, where Able's whole
 * footprint is ~7.6% of what is used and the rest is a third party's data we
 * neither control nor should be alarming on. Measured 2026-08-27T18:06Z off
 * `/api/ops/status/combined` on prod:
 *
 *   lane          volume       used     free    free at *its own* 90% line
 *   prod          907.13 GiB   58.47%   376.77 GiB   90.71 GiB
 *   acceptance   1861.90 GiB   91.58%   156.83 GiB  186.19 GiB
 *
 * Acceptance was reporting `error` while holding 73% more free space than prod
 * has at the moment prod first turns red. That badge was not describing a
 * tighter condition than prod's; it was describing a larger denominator.
 *
 * HOW THESE TWO NUMBERS WERE PICKED
 *
 * They are what a **1,000 GiB reference volume** — prod's 907.13 GiB rounded up
 * to a round figure — has left at the 75% and 90% lines. Reading the rule that
 * way makes both of its properties provable rather than asserted:
 *
 *  - On any volume **at or under 1,000 GiB the floors are inert**: the floor is
 *    crossed at a *lower* used-percent than its ratio line, so the ratio is
 *    still the binding constraint at every point of that volume's trajectory.
 *    On prod's 907.13 GiB the floors are crossed at 72.44% and 88.98% used,
 *    below the 75%/90% lines — so prod's verdicts are bit-identical to before
 *    (pinned in `opsStatusThresholds.test.ts`, which sweeps prod's real volume
 *    size across both lines).
 *  - Above it, escalation additionally demands the absolute headroom be at
 *    least as tight as the reference volume's. A bigger denominator can no
 *    longer buy a redder badge.
 *
 * Sanity check in the units that actually matter: prod's measured baseline
 * growth is 1.96 GiB/day (`diskHeadroom.ts`, ABL-459), so the error floor is
 * ~51 days of runway and the warn floor ~127. Those are an act-now and a
 * look-at-it horizon respectively, which is what the two verdicts mean.
 *
 * Stated as literals rather than computed from a reference constant: the
 * arithmetic `(1 - DISK_ERROR_RATIO) * 1000 GiB` lands on 107374182399.99998
 * in binary floating point, and a threshold that is a ULP away from the round
 * number everything else calls it is a worse defect than a restated constant.
 */
export const DISK_WARN_FREE_BYTES = 250 * GIB;
export const DISK_ERROR_FREE_BYTES = 100 * GIB;

/**
 * `error`/`warn` require the volume to be **both** proportionally full and
 * absolutely low; `ok` is the else-branch of that conjunction, not a third
 * threshold.
 *
 * The `unknown` rule is untouched and is not what ABL-586 relaxed: a missing
 * reading, a zero total, or a non-finite byte count is `'unknown'`. That last
 * clause is new — `usedBytes: NaN` used to divide to `NaN`, fail both `>=`
 * comparisons and fall out of the bottom as `'ok'`, which is this codebase's
 * cardinal sin (an unmeasured metric rendering as a clean bill of health).
 */
export function deriveDiskState(disk: DiskUsage | null): ThresholdState {
  if (disk === null) return 'unknown';
  const { totalBytes, usedBytes } = disk;
  if (!Number.isFinite(totalBytes) || !Number.isFinite(usedBytes) || totalBytes <= 0) return 'unknown';

  const ratio = usedBytes / totalBytes;
  // `freeBytes` arrives from a peer whose payload is cast, not validated
  // (`peerOpsStatus.ts` hands `envelope.data` straight through), so a peer on a
  // build without the field would otherwise make every `free <= floor` test
  // false and silently suppress the escalation this guard is gating. Falling
  // back to the identity `getDiskUsage` computes it from keeps a suppression
  // rule from ever being fed an absent number.
  const freeBytes = Number.isFinite(disk.freeBytes) ? disk.freeBytes : totalBytes - usedBytes;

  if (ratio >= DISK_ERROR_RATIO && freeBytes <= DISK_ERROR_FREE_BYTES) return 'error';
  if (ratio >= DISK_WARN_RATIO && freeBytes <= DISK_WARN_FREE_BYTES) return 'warn';
  return 'ok';
}

/**
 * The used-percent at which a volume of `totalBytes` actually escalates to
 * `error` — i.e. where *both* halves of `deriveDiskState`'s error condition
 * hold.
 *
 * Exists because the headroom projection (`diskHeadroom.ts`) counts days until
 * a *percentage* is crossed, and once the error condition is a conjunction the
 * ratio line stops being that percentage on any volume over the reference
 * size: acceptance's 1861.90 GiB volume passes 90% with 186.19 GiB still free
 * and does not turn red until 94.63%. Without this, the trend card would read
 * "Already at or above 90%" in alarm red beside a `warn` badge — the page
 * contradicting itself, which is the exact failure the single-home rule at the
 * top of this file exists to prevent.
 *
 * Never returns less than the ratio line, and returns exactly it for an
 * unmeasurable total: an unknown volume size must move the projection earlier
 * or not at all, never later.
 *
 * Floored, not rounded, to 2 dp for the same reason — a hundredth of a point is
 * noise against a least-squares fit, but the rounding that is safe to apply to
 * a threshold is the one that cannot push it past the real crossing.
 */
export function diskErrorPercentForVolume(totalBytes: number): number {
  const ratioPercent = DISK_ERROR_RATIO * 100;
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return ratioPercent;
  const floorPercent = ((totalBytes - DISK_ERROR_FREE_BYTES) / totalBytes) * 100;
  return Math.floor(Math.max(ratioPercent, floorPercent) * 100) / 100;
}

/**
 * `stale` is the only one of the four freshness verdicts that names an
 * actionable problem (see `freshnessRollup.ts`'s `SEVERITY` ranking, which
 * this mirrors) — `ended`/`none` are documented non-alarm verdicts, so they
 * read `'unknown'` here rather than `'ok'` (a country we've never held data
 * for is not evidence the environment is healthy) or `'warn'` (it is not an
 * alarm either).
 *
 * A rollup marked `unmeasured` (ABL-657) is none of those four: the database
 * could not be read at all. It is `'error'` — every data endpoint on this
 * environment is failing at that moment, which is the definition of an outage
 * — *unless* `blackoutActive`, where it is `'warn'` for exactly the reason an
 * unreachable side is softened in `deriveEnvironmentState`: the twice-daily
 * replica write lock is a scheduled, known state (`syncBlackoutWindow.ts`).
 *
 * Not `'unknown'`, which would be the tempting reading of "we did not measure
 * it". `'unknown'` is *held* by the alert engine's unknown rule
 * (`opsAlertEngine.ts`), so a genuinely unreadable database outside the sync
 * window would then reach nobody at all — trading a noisy false alarm for a
 * silent real one.
 */
export function deriveFreshnessState(
  freshness: FreshnessRollup,
  blackoutActive: boolean,
): ThresholdState {
  if (freshness.unmeasured !== undefined) return blackoutActive ? 'warn' : 'error';
  if (freshness.status === 'stale') return 'warn';
  if (freshness.status === 'live') return 'ok';
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
    deriveFreshnessState(side.status.freshness, blackoutActive),
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
 *
 * A *reachable* side whose freshness rollup came back unmeasured is a
 * different case and reports it as one (ABL-657): the side answered, so its
 * disk reading is real, and only `freshness` degrades.
 */
export function deriveSideState(side: SideStatus, blackoutActive: boolean): OpsSideDerived {
  return {
    environment: deriveEnvironmentState(side, blackoutActive),
    disk: side.reachable ? deriveDiskState(side.status.host.disk) : 'unknown',
    freshness: side.reachable
      ? deriveFreshnessState(side.status.freshness, blackoutActive)
      : 'unknown',
  };
}
