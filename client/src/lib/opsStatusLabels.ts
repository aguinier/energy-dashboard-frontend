import type { CombinedOpsStatus, FreshnessRollup } from '@/types';

/**
 * The two readings of `/api/ops/status/combined` that have to tell a *failure
 * to measure* apart from a measurement (ABL-657). Pure and separate from
 * `OpsStatusView` for the same reason `networkRows.ts` is: the cases worth
 * pinning are the absences, and an absence rendered as a verdict is this
 * dashboard's oldest failure mode.
 *
 * Nothing here decides a threshold — `data.derived` arrives already computed
 * from `server/src/lib/opsStatusThresholds.ts` (ABL-292). These are labels and
 * one banner predicate.
 */

/**
 * What the freshness row reads.
 *
 * `unmeasured` is checked before the four verdicts and is not one of them. The
 * server sets it when its database read threw — during the twice-daily replica
 * write lock, that is every request for 30-80 minutes — and the rollup it comes
 * with is the empty shape. Falling through to `status` would print "no data
 * held", a statement about the database's contents, for a database whose
 * contents we did not manage to look at.
 */
export function describeFreshnessRollup(freshness: FreshnessRollup): string {
  if (freshness.unmeasured !== undefined) return 'not measured — database read failed';
  if (freshness.status === 'stale') return `stale (${freshness.counts.stale}/${freshness.streamsChecked} streams)`;
  if (freshness.status === 'live') return 'live';
  if (freshness.status === 'ended') return 'ended (not an alarm)';
  return 'no data held';
}

/**
 * Whether to explain the degradation below as the scheduled DB-sync window.
 *
 * Requires the window to be active **and** a side to actually be showing
 * damage — an unremarkable 07:00 is not worth a banner, and one that appeared
 * on every quiet morning would be ignored by the time it mattered.
 *
 * "Showing damage" grew a second form in ABL-657. The sync lock used to take
 * `/api/ops/status` down outright, so an unreachable side was the only symptom
 * there was; now the side answers and reports its freshness rollup as
 * unmeasured instead. Without the second clause the page would show a degraded
 * freshness row inside a scheduled window with nothing saying why — which is
 * the whole point of the banner.
 */
export function shouldShowBlackoutBanner(data: CombinedOpsStatus): boolean {
  if (!data.syncBlackout.active) return false;
  return [data.local, data.peer].some(
    (side) => !side.reachable || side.status.freshness.unmeasured !== undefined,
  );
}
