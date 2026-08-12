/**
 * "How many days until this disk crosses its threshold?" — a *projection* off
 * stored ops snapshots (ABL-288), not a measurement.
 *
 * This module exists because the honest answer is very often "we cannot say",
 * and the failure this codebase keeps having is rendering a confident number
 * anyway. So every guard below returns `days: null` with a machine-readable
 * `reason` the UI states out loud, and never a fallback figure:
 *
 *   - fewer than `MIN_POINTS` readings, or a span under `MIN_SPAN_HOURS`
 *     → we are fitting a line to noise; no projection.
 *   - usage flat or falling → no crossing to project. Not "never", not a huge
 *     number — `not_rising`, which the UI says in words.
 *   - a poor fit (R² below `MIN_R2`) → the readings do not describe a trend,
 *     they describe scatter.
 *   - already at or above the threshold → `already_breached`; the alarm is the
 *     current reading, not a countdown.
 *   - a crossing further out than `MAX_HORIZON_DAYS` → `beyond_horizon`.
 *     Extrapolating years from days of history is fabrication with a decimal
 *     point on it.
 *
 * `basis` is returned whenever a line could be fitted at all — even when
 * `days` is null — so the page can show what the verdict was made from
 * (readings, span, slope, R²) instead of asking anyone to trust it.
 *
 * Pure and clock-free: `points` carry their own timestamps and nothing here
 * reads `Date.now()`.
 */

/** A disk reading: when it was taken, and used-percent of the filesystem at that moment. */
export interface DiskPoint {
  atMs: number;
  percent: number;
}

export type DiskHeadroomReason =
  | 'ok'
  | 'no_readings'
  | 'insufficient_history'
  | 'insufficient_span'
  | 'not_rising'
  | 'noisy_fit'
  | 'already_breached'
  | 'beyond_horizon';

export interface DiskHeadroomBasis {
  /** Readings the fit used. */
  points: number;
  /** Wall-clock hours between the first and last reading. */
  spanHours: number;
  /** Least-squares slope, in percentage points of disk usage per day. */
  slopePercentPerDay: number;
  /** Coefficient of determination of that fit, 0-1. */
  r2: number;
  /** The most recent *measured* percent — never the fitted value at `now`. */
  currentPercent: number;
}

export interface DiskHeadroom {
  thresholdPercent: number;
  /** Days until the threshold is crossed, or `null` — see `reason`. */
  days: number | null;
  reason: DiskHeadroomReason;
  /** Present whenever a line could be fitted (>= 2 readings over a non-zero span). */
  basis: DiskHeadroomBasis | null;
}

/**
 * Mirrors `DISK_ERROR_RATIO` in `client/src/lib/opsStatusThresholds.ts:15` —
 * the ratio the status page already paints a side red at. The countdown and
 * the badge have to agree on what "full" means, or the page says the disk is
 * fine and that it crosses "full" tomorrow.
 */
export const DISK_THRESHOLD_PERCENT = 90;

const MIN_POINTS = 4;
const MIN_SPAN_HOURS = 12;
/** Below this the crossing is always past `MAX_HORIZON_DAYS` anyway; it also keeps the divide well away from zero. */
const MIN_SLOPE_PERCENT_PER_DAY = 0.01;
const MIN_R2 = 0.5;
const MAX_HORIZON_DAYS = 365;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface Fit {
  slopePerDay: number;
  r2: number;
}

/**
 * Ordinary least squares of percent against days elapsed.
 *
 * `r2` is 0 when the readings have no variance at all (a perfectly flat disk):
 * the fit explains nothing, and the `not_rising` guard is what such a series
 * should trip, not a divide by zero.
 */
function fitLine(points: DiskPoint[]): Fit {
  const t0 = points[0].atMs;
  const xs = points.map((p) => (p.atMs - t0) / MS_PER_DAY);
  const ys = points.map((p) => p.percent);
  const n = points.length;

  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }

  if (sxx === 0) return { slopePerDay: 0, r2: 0 };

  const slopePerDay = sxy / sxx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slopePerDay, r2 };
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export interface DiskHeadroomOptions {
  thresholdPercent?: number;
}

/**
 * Days until `points` cross `thresholdPercent`, or `null` and why not.
 *
 * `points` need not be sorted; they are sorted here so a store that appended
 * out of order (a clock step, a merged file) cannot silently invert the slope.
 */
export function computeDiskHeadroom(
  points: DiskPoint[],
  { thresholdPercent = DISK_THRESHOLD_PERCENT }: DiskHeadroomOptions = {},
): DiskHeadroom {
  const usable = points
    .filter((p) => Number.isFinite(p.atMs) && Number.isFinite(p.percent))
    .sort((a, b) => a.atMs - b.atMs);

  const none = (reason: DiskHeadroomReason): DiskHeadroom => ({
    thresholdPercent,
    days: null,
    reason,
    basis: null,
  });

  if (usable.length === 0) return none('no_readings');

  const currentPercent = usable[usable.length - 1].percent;
  const spanHours = (usable[usable.length - 1].atMs - usable[0].atMs) / (60 * 60 * 1000);

  // Below two readings, or with every reading at the same instant, there is no
  // line to fit and therefore no basis to report either.
  if (usable.length < 2 || spanHours <= 0) {
    return none(usable.length < MIN_POINTS ? 'insufficient_history' : 'insufficient_span');
  }

  const { slopePerDay, r2 } = fitLine(usable);
  const basis: DiskHeadroomBasis = {
    points: usable.length,
    spanHours: round(spanHours, 2),
    slopePercentPerDay: round(slopePerDay, 4),
    r2: round(r2, 4),
    currentPercent: round(currentPercent, 2),
  };
  const withBasis = (reason: DiskHeadroomReason, days: number | null = null): DiskHeadroom => ({
    thresholdPercent,
    days,
    reason,
    basis,
  });

  if (usable.length < MIN_POINTS) return withBasis('insufficient_history');
  if (spanHours < MIN_SPAN_HOURS) return withBasis('insufficient_span');

  // Checked before the trend guards: a disk already over the line needs
  // attention now, and "crosses in -3 days" is not a sentence anyone should
  // have to read off a monitor.
  if (currentPercent >= thresholdPercent) return withBasis('already_breached');

  if (slopePerDay < MIN_SLOPE_PERCENT_PER_DAY) return withBasis('not_rising');
  if (r2 < MIN_R2) return withBasis('noisy_fit');

  const days = (thresholdPercent - currentPercent) / slopePerDay;
  if (days > MAX_HORIZON_DAYS) return withBasis('beyond_horizon');

  return withBasis('ok', round(days, 1));
}
