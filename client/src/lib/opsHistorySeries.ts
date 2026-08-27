import type { DiskHeadroom, OpsSideSnapshot, OpsSnapshot, OpsStatusHistory } from '@/types';

/**
 * Turning stored ops snapshots (ABL-288) into what the history section draws
 * and says.
 *
 * Pure, so every sentence the page can render about a projection — including
 * all seven ways of saying "we cannot project this" — is a test case rather
 * than something you have to reproduce a disk trend in a browser to see.
 *
 * The rule this module exists to hold: a missing reading is a hole, never a
 * zero and never a bridged line. `diskSeries` emits `null` for a side that was
 * unreachable or reported no disk, and the chart breaks its stroke there.
 */

export interface DiskSeriesPoint {
  /** ISO instant of the snapshot. */
  t: string;
  /** Used-percent for each side, or `null` where that side reported no disk. */
  local: number | null;
  peer: number | null;
}

/**
 * Used-percent for one side of one snapshot.
 *
 * `null` when the side reported no disk, and also when `totalBytes` is 0 — a
 * filesystem reporting zero total was not measured, and dividing by it would
 * paint an environment as comfortably empty. Mirrors `diskPercent` in
 * `server/src/services/opsSnapshot.ts`.
 */
export function sideDiskPercent(side: OpsSideSnapshot): number | null {
  if (side.diskUsedBytes === null || side.diskTotalBytes === null) return null;
  if (side.diskTotalBytes <= 0) return null;
  return (side.diskUsedBytes / side.diskTotalBytes) * 100;
}

/** Both sides' disk usage over time, oldest first, holes preserved. */
export function diskSeries(snapshots: OpsSnapshot[]): DiskSeriesPoint[] {
  return snapshots.map((s) => ({
    t: s.t,
    local: sideDiskPercent(s.local),
    peer: sideDiskPercent(s.peer),
  }));
}

/** True when a side has at least one real reading — the chart draws nothing for a side that has none. */
export function hasReadings(series: DiskSeriesPoint[], side: 'local' | 'peer'): boolean {
  return series.some((p) => p[side] !== null);
}

/** One dashed rule on the disk chart: the used-percent at which a badge turns red. */
export interface ThresholdLine {
  percent: number;
  /** What the chart prints at the end of the rule. */
  label: string;
}

/**
 * The threshold rules to draw, one per *distinct* threshold (ABL-586).
 *
 * Escalation to `error` now needs a used-ratio breach and a free-bytes floor
 * breach together, so the percent at which a side turns red depends on the size
 * of its volume: 90% on prod's 907 GiB, 94.62% on the 1.86 TiB workstation
 * volume acceptance shares. The chart used to draw a single rule taken from
 * `headroom.local` and label it as "the" threshold, which over two differently
 * sized volumes would have drawn one side's line across the other side's data —
 * a wrong number rendered confidently, in the one place a reader looks to see
 * how close the red line is.
 *
 * Collapsed to a single unlabelled-by-lane rule when the two agree, which is
 * every deployment where both volumes are at or under the reference size, so
 * the common case reads exactly as it did before.
 */
export function thresholdLines(headroom: OpsStatusHistory['headroom']): ThresholdLine[] {
  const { local, peer } = headroom;
  if (local.thresholdPercent === peer.thresholdPercent) {
    return [{ percent: local.thresholdPercent, label: `${local.thresholdPercent}%` }];
  }
  return [
    { percent: local.thresholdPercent, label: `${local.thresholdPercent}% this env` },
    { percent: peer.thresholdPercent, label: `${peer.thresholdPercent}% peer` },
  ];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function formatDays(days: number): string {
  if (days < 1) return 'under a day';
  if (days < 2) return 'about a day';
  return `about ${Math.round(days)} days`;
}

function formatSpan(hours: number): string {
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${(hours / 24).toFixed(1)} days`;
}

/**
 * The sentence the page shows for a headroom verdict.
 *
 * Every `null`-days branch says what was missing instead of falling back to a
 * number or an empty cell, because "disk is 85%" and "disk will cross 90% in
 * ~11 days" are different pieces of information and a blank is neither.
 */
export function describeHeadroom(headroom: DiskHeadroom): string {
  const { thresholdPercent: threshold, basis } = headroom;

  switch (headroom.reason) {
    case 'ok':
      return `Crosses ${threshold}% in ${formatDays(headroom.days ?? 0)}`;
    case 'no_readings':
      return 'No disk readings stored yet';
    case 'insufficient_history':
      return basis
        ? `Not enough history yet — ${plural(basis.points, 'reading')} over ${formatSpan(basis.spanHours)}`
        : 'Not enough history yet';
    case 'insufficient_span':
      // Names the bar as well as the shortfall (ABL-459). Disk usage here is a
      // flat baseline plus a daily backup/sync sawtooth, so a window shorter
      // than a few cycles fits the phase it opened on rather than the trend —
      // and does it with a high R², which is why this refusal has to explain
      // itself rather than read as "not enough data yet".
      return basis
        ? `History too short to project — ${formatSpan(basis.spanHours)} of the ${formatSpan(
            basis.minSpanHours,
          )} needed to average out the daily backup and sync cycle`
        : 'History too short to project';
    case 'not_rising':
      return 'Not rising — no crossing to project';
    case 'noisy_fit':
      return 'Readings are too scattered to project a crossing';
    case 'already_breached':
      return `Already at or above ${threshold}%`;
    case 'beyond_horizon':
      return `Rising too slowly to cross ${threshold}% within a year`;
  }
}

/**
 * The evidence line under the sentence: what the verdict was fitted from.
 *
 * Shown whenever a line could be fitted at all, including for the refusals, so
 * a reader can see a projection is built on 42 readings over six days with an
 * R² of 0.97 — or that a refusal is built on three readings — rather than
 * being asked to trust either.
 */
export function describeHeadroomBasis(headroom: DiskHeadroom): string | null {
  const { basis } = headroom;
  if (!basis) return null;

  const slope = `${basis.slopePercentPerDay >= 0 ? '+' : ''}${basis.slopePercentPerDay.toFixed(2)} pts/day`;
  return `${basis.currentPercent.toFixed(1)}% now · ${slope} · ${plural(basis.points, 'reading')} over ${formatSpan(
    basis.spanHours,
  )} · R²=${basis.r2.toFixed(2)}`;
}

/**
 * The caption for the section: what is stored and how, or why nothing is.
 *
 * `captureEnabled: false` and an unwritable file are reported distinctly from
 * "nothing captured yet" — three states that all render as an empty chart and
 * have three different fixes.
 */
export function describeStorage(history: OpsStatusHistory): string {
  const { storage, snapshots, windowHours } = history;

  if (storage.error !== null) {
    return `History unavailable — the snapshot store could not be read: ${storage.error}`;
  }
  if (!storage.captureEnabled) {
    return 'Snapshot capture is switched off for this environment (OPS_SNAPSHOT_ENABLED), so no new readings are being stored.';
  }
  if (storage.storedSnapshots === 0) {
    return `No snapshots stored yet — the first is written at startup, then every ${storage.intervalMinutes} minutes.`;
  }

  const window = windowHours >= 48 ? `${Math.round(windowHours / 24)}d` : `${Math.round(windowHours)}h`;
  const skipped = storage.skippedLines > 0 ? ` · ${plural(storage.skippedLines, 'damaged line')} skipped` : '';
  return `${plural(snapshots.length, 'reading')} in the last ${window}, of ${storage.storedSnapshots} stored · captured every ${storage.intervalMinutes}m · kept ${storage.retentionDays}d${skipped}`;
}
