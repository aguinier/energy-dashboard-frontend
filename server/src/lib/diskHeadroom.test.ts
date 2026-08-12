import { describe, it, expect } from 'vitest';
import { computeDiskHeadroom, DISK_THRESHOLD_PERCENT, type DiskPoint } from './diskHeadroom.js';

const HOUR_MS = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 7, 1, 0, 0, 0);

/** `count` readings, `everyHours` apart, rising `perDay` percentage points a day from `startPercent`. */
function ramp(startPercent: number, perDay: number, count: number, everyHours = 6): DiskPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    atMs: T0 + i * everyHours * HOUR_MS,
    percent: startPercent + (perDay * i * everyHours) / 24,
  }));
}

describe('computeDiskHeadroom', () => {
  it('projects the crossing from a clean upward ramp', () => {
    // 80% rising 1 point/day, sampled 6-hourly for 3 days: 10 points to go.
    const result = computeDiskHeadroom(ramp(80, 1, 13));

    expect(result.reason).toBe('ok');
    expect(result.thresholdPercent).toBe(90);
    expect(result.basis?.slopePercentPerDay).toBeCloseTo(1, 3);
    expect(result.basis?.r2).toBeCloseTo(1, 3);
    // Last measured reading is 83%, so 7 points at 1/day.
    expect(result.basis?.currentPercent).toBeCloseTo(83, 2);
    expect(result.days).toBeCloseTo(7, 1);
  });

  it('projects off the last MEASURED reading, not the fitted value at that instant', () => {
    // A noisy-but-well-correlated ramp whose final sample sits below the fit
    // line. Using the fit would understate the headroom.
    const points = ramp(80, 1, 13);
    points[points.length - 1].percent -= 0.5;

    const result = computeDiskHeadroom(points);

    expect(result.reason).toBe('ok');
    expect(result.basis?.currentPercent).toBeCloseTo(82.5, 2);
    expect(result.days!).toBeGreaterThan(7);
  });

  it('returns null with no_readings on an empty series rather than a default figure', () => {
    expect(computeDiskHeadroom([])).toEqual({
      thresholdPercent: DISK_THRESHOLD_PERCENT,
      days: null,
      reason: 'no_readings',
      basis: null,
    });
  });

  it('refuses to project from fewer than four readings', () => {
    const result = computeDiskHeadroom(ramp(80, 1, 3, 12));

    expect(result.days).toBeNull();
    expect(result.reason).toBe('insufficient_history');
    // Two-plus readings over a real span still report what they were, so the
    // page can say "3 readings over 24h — not enough yet" instead of nothing.
    expect(result.basis?.points).toBe(3);
    expect(result.basis?.spanHours).toBe(24);
  });

  it('refuses to project from a span under 12 hours, however many readings', () => {
    // 12 readings 30 minutes apart: dense, but only 5.5h of history.
    const result = computeDiskHeadroom(ramp(80, 1, 12, 0.5));

    expect(result.days).toBeNull();
    expect(result.reason).toBe('insufficient_span');
    expect(result.basis?.points).toBe(12);
  });

  it('reports not_rising for a flat disk instead of an enormous or infinite countdown', () => {
    const result = computeDiskHeadroom(ramp(80, 0, 13));

    expect(result.days).toBeNull();
    expect(result.reason).toBe('not_rising');
    expect(result.basis?.slopePercentPerDay).toBe(0);
    expect(Number.isFinite(result.basis!.r2)).toBe(true);
  });

  it('reports not_rising for a shrinking disk rather than a negative countdown', () => {
    const result = computeDiskHeadroom(ramp(80, -2, 13));

    expect(result.days).toBeNull();
    expect(result.reason).toBe('not_rising');
    expect(result.basis!.slopePercentPerDay).toBeLessThan(0);
  });

  it('reports noisy_fit when the readings are scatter, not a trend', () => {
    // Same start and end, but sawtoothing hard in between: a slope exists, and
    // it explains almost none of the variance.
    const points = ramp(80, 0.5, 25, 6).map((p, i) => ({
      atMs: p.atMs,
      percent: p.percent + (i % 2 === 0 ? -6 : 6),
    }));

    const result = computeDiskHeadroom(points);

    expect(result.days).toBeNull();
    expect(result.reason).toBe('noisy_fit');
    expect(result.basis!.r2).toBeLessThan(0.5);
  });

  it('reports already_breached rather than a countdown once usage is at the threshold', () => {
    const result = computeDiskHeadroom(ramp(89, 1, 13));

    expect(result.days).toBeNull();
    expect(result.reason).toBe('already_breached');
    expect(result.basis!.currentPercent).toBeGreaterThanOrEqual(90);
  });

  it('reports beyond_horizon rather than extrapolating years from days of history', () => {
    // 10 points of headroom creeping at 0.02/day is a ~500-day crossing.
    const result = computeDiskHeadroom(ramp(80, 0.02, 41, 12));

    expect(result.days).toBeNull();
    expect(result.reason).toBe('beyond_horizon');
    expect(result.basis!.slopePercentPerDay).toBeGreaterThan(0);
  });

  it('sorts unordered readings so an out-of-order append cannot invert the slope', () => {
    const ordered = ramp(80, 1, 13);
    const shuffled = [...ordered].reverse();

    expect(computeDiskHeadroom(shuffled)).toEqual(computeDiskHeadroom(ordered));
  });

  it('drops non-finite readings instead of poisoning the fit with NaN', () => {
    const points = [...ramp(80, 1, 13), { atMs: Number.NaN, percent: 85 }, { atMs: T0, percent: Number.NaN }];

    const result = computeDiskHeadroom(points);

    expect(result.reason).toBe('ok');
    expect(result.basis!.points).toBe(13);
    expect(Number.isFinite(result.days!)).toBe(true);
  });

  it('honours a custom threshold', () => {
    const result = computeDiskHeadroom(ramp(80, 1, 13), { thresholdPercent: 95 });

    expect(result.thresholdPercent).toBe(95);
    expect(result.days).toBeCloseTo(12, 1);
  });
});
