import { diskPercent, type OpsSnapshot } from './opsSnapshot.js';
import {
  readSnapshots,
  resolveSnapshotConfig,
  type OpsSnapshotConfig,
} from './opsSnapshotStore.js';
import { computeDiskHeadroom, type DiskHeadroom, type DiskPoint } from '../lib/diskHeadroom.js';

/**
 * The `/api/ops/status/history` payload (ABL-288): the stored snapshots inside
 * a window, plus the disk headroom projection derived from them.
 *
 * `storage` is part of the contract, not debug decoration. A history view that
 * renders nothing is ambiguous — no snapshots yet, capture switched off, or an
 * unreadable file all look identical — and this codebase's rule is that an
 * absent number has to say why it is absent.
 */
export interface OpsStatusHistory {
  timestamp: string;
  /** Hours of history actually returned (the request's `hours`, clamped to retention). */
  windowHours: number;
  snapshots: OpsSnapshot[];
  headroom: {
    local: DiskHeadroom;
    peer: DiskHeadroom;
  };
  storage: {
    /** False when `OPS_SNAPSHOT_ENABLED` is off — no new snapshots are being taken. */
    captureEnabled: boolean;
    intervalMinutes: number;
    retentionDays: number;
    /** Snapshots held on disk, before the window filter. */
    storedSnapshots: number;
    /** Damaged/unparseable lines skipped on read — 0 in the normal case. */
    skippedLines: number;
    /** Why the history is unavailable, or `null`. A missing file is not an error. */
    error: string | null;
  };
}

const DEFAULT_WINDOW_HOURS = 7 * 24;
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Pure: the window a request gets, clamped to what is actually retained.
 *
 * Asking for 90 days of a 14-day retention returns 14 days *and says so* via
 * the echoed `windowHours`, rather than returning 14 days labelled 90 — the
 * label is what a reader would use to decide the trend is flat over a quarter.
 */
export function resolveWindowHours(
  requested: number | undefined,
  retentionDays: number,
  defaultHours: number = DEFAULT_WINDOW_HOURS,
): number {
  const maxHours = retentionDays * 24;
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return Math.min(defaultHours, maxHours);
  }
  return Math.min(requested, maxHours);
}

/** Pure: disk readings for one side, dropping the snapshots where that side reported no disk. */
export function toDiskPoints(snapshots: OpsSnapshot[], side: 'local' | 'peer'): DiskPoint[] {
  const points: DiskPoint[] = [];
  for (const snapshot of snapshots) {
    const percent = diskPercent(snapshot[side]);
    if (percent === null) continue;
    points.push({ atMs: Date.parse(snapshot.t), percent });
  }
  return points;
}

export interface OpsHistoryDeps {
  config?: OpsSnapshotConfig;
  read?: typeof readSnapshots;
}

/**
 * Snapshots inside the window plus the headroom projection for each side.
 *
 * The projection is computed from the *windowed* snapshots, so what the page
 * charts and what it projects from are the same readings — a headroom figure
 * fitted to history the reader cannot see would be unfalsifiable by the chart
 * next to it.
 */
export function getOpsStatusHistory(
  now: Date = new Date(),
  requestedHours?: number,
  deps: OpsHistoryDeps = {},
): OpsStatusHistory {
  const config = deps.config ?? resolveSnapshotConfig();
  const read = deps.read ?? readSnapshots;

  const { snapshots, skippedLines, error } = read(config);
  const windowHours = resolveWindowHours(requestedHours, config.retentionDays);
  const cutoff = now.getTime() - windowHours * MS_PER_HOUR;
  const windowed = snapshots.filter((s) => Date.parse(s.t) >= cutoff);

  return {
    timestamp: now.toISOString(),
    windowHours,
    snapshots: windowed,
    headroom: {
      local: computeDiskHeadroom(toDiskPoints(windowed, 'local')),
      peer: computeDiskHeadroom(toDiskPoints(windowed, 'peer')),
    },
    storage: {
      captureEnabled: config.enabled,
      intervalMinutes: config.intervalMinutes,
      retentionDays: config.retentionDays,
      storedSnapshots: snapshots.length,
      skippedLines,
      error,
    },
  };
}
