import { describe, it, expect } from 'vitest';
import {
  applyCoverage,
  computeCoverage,
  coverageWindowDays,
  resolveExpectedDailyRows,
  COVERAGE_MIN_RATIO,
  COVERAGE_WINDOW_DAYS,
  type DailyRowCount,
} from './freshnessCoverage.js';
import type { FreshnessStream } from '../types/index.js';

/**
 * ABL-632. Coverage consults no clock, so every case here is a fixed fixture
 * and none of it changes meaning as the suite ages — unlike `freshness.test.ts`,
 * whose age rules have to build their rows relative to `Date.now()`.
 */

const days = (spec: Record<string, number>): DailyRowCount[] =>
  Object.entries(spec).map(([day, rows]) => ({ day, rows }));

const live = (latest: string): FreshnessStream => ({ latest, ageHours: 2, status: 'live' });

/**
 * The real degradation, verbatim.
 *
 * DE `energy_load` read-only from prod
 * (`/home/clavain/energy-dashboard/data/energy_dashboard.db`) on 2026-09-02
 * 21:00 UTC. DE is 15-minute, so a complete UTC day is 96 rows. These gaps have
 * not backfilled, which is what makes this a fixture rather than a story: the
 * 08-30..09-01 days are the positive control and 08-27..08-29 the negative one,
 * from the same table, the same country, five days apart.
 */
const DE_LOAD_PROD = {
  '2026-08-24': 96,
  '2026-08-25': 96,
  '2026-08-26': 96,
  '2026-08-27': 96,
  '2026-08-28': 96,
  '2026-08-29': 96,
  '2026-08-30': 41,
  '2026-08-31': 81,
  '2026-09-01': 53,
  '2026-09-02': 26,
};

describe('resolveExpectedDailyRows', () => {
  it('reads each ENTSO-E resolution off the country’s own best day', () => {
    expect(resolveExpectedDailyRows(days({ '2026-08-28': 96 }))).toBe(96);
    expect(resolveExpectedDailyRows(days({ '2026-08-28': 48 }))).toBe(48);
    expect(resolveExpectedDailyRows(days({ '2026-08-28': 24 }))).toBe(24);
  });

  it('takes the maximum, so a sustained outage cannot redefine "complete"', () => {
    // Four broken days outnumber one healthy one; a mode or a median would call
    // 41 the norm and score the wreckage 1.00.
    expect(
      resolveExpectedDailyRows(
        days({
          '2026-08-29': 96,
          '2026-08-30': 41,
          '2026-08-31': 41,
          '2026-09-01': 41,
          '2026-09-02': 41,
        }),
      ),
    ).toBe(96);
  });

  it('snaps IE, which never publishes a whole 30-minute day, to 48', () => {
    // Measured on prod 2026-08-20..29: IE's best `energy_load` day was 46 of 48.
    expect(resolveExpectedDailyRows(days({ '2026-08-26': 46, '2026-08-27': 30 }))).toBe(48);
  });

  it('absorbs a handful of duplicate rows rather than raising the bar', () => {
    // ABL-211's residual two-separator duplicates inflate a count by a few.
    expect(resolveExpectedDailyRows(days({ '2026-08-28': 100 }))).toBe(96);
    expect(resolveExpectedDailyRows(days({ '2026-08-28': 26 }))).toBe(24);
  });

  it('returns null rather than guessing when no day resembles a resolution', () => {
    expect(resolveExpectedDailyRows(days({ '2026-08-28': 11 }))).toBeNull();
    // Gross duplication is not a resolution either.
    expect(resolveExpectedDailyRows(days({ '2026-08-28': 192 }))).toBeNull();
    expect(resolveExpectedDailyRows([])).toBeNull();
    expect(resolveExpectedDailyRows(days({ '2026-08-28': 0 }))).toBeNull();
  });
});

describe('coverageWindowDays', () => {
  it('ends the day before the newest day with rows, and is COVERAGE_WINDOW_DAYS long', () => {
    const window = coverageWindowDays(days(DE_LOAD_PROD));
    expect(window).toEqual(['2026-08-31', '2026-09-01']);
    expect(window).toHaveLength(COVERAGE_WINDOW_DAYS);
  });

  it('skips the newest day, which is partial by construction', () => {
    // A day-ahead market day runs 22:00-22:00 UTC, so a perfectly healthy
    // stream's terminal UTC day holds 88 of 96. Counting it would accuse every
    // country every day.
    const window = coverageWindowDays(
      days({ '2026-09-01': 96, '2026-09-02': 96, '2026-09-03': 88 }),
    );
    expect(window).toEqual(['2026-09-01', '2026-09-02']);
  });

  it('crosses a month boundary by UTC day arithmetic, not string juggling', () => {
    expect(coverageWindowDays(days({ '2026-09-01': 24 }))).toEqual(['2026-08-30', '2026-08-31']);
  });

  it('ignores days that exist with zero rows', () => {
    expect(coverageWindowDays(days({ '2026-08-28': 96, '2026-08-29': 0 }))).toEqual([
      '2026-08-26',
      '2026-08-27',
    ]);
  });

  it('is null when the stream holds nothing', () => {
    expect(coverageWindowDays([])).toBeNull();
    expect(coverageWindowDays(days({ '2026-08-28': 0 }))).toBeNull();
  });
});

describe('computeCoverage', () => {
  it('measures the prod degradation at 134 of 192', () => {
    expect(computeCoverage(days(DE_LOAD_PROD))).toEqual({
      windowStart: '2026-08-31',
      windowEnd: '2026-09-01',
      expectedDailyRows: 96,
      observed: 81 + 53,
      expected: 192,
      ratio: 0.6979,
    });
  });

  it('publishes observed: 0 with a real denominator, never a null-as-zero', () => {
    // "We know what complete looks like and hold none of it" is a measurement.
    const coverage = computeCoverage(
      days({ '2026-08-27': 96, '2026-08-31': 0, '2026-09-01': 0, '2026-09-02': 4 }),
    );
    expect(coverage).toMatchObject({ observed: 0, expected: 192, ratio: 0 });
  });

  it('is null, not zero, when the resolution cannot be read', () => {
    expect(computeCoverage(days({ '2026-08-31': 11, '2026-09-01': 9, '2026-09-02': 7 }))).toBeNull();
  });

  it('never divides by zero and never publishes NaN or Infinity', () => {
    for (const counts of [[], days({ '2026-08-28': 0 }), days({ '2026-08-28': 3 })]) {
      const coverage = computeCoverage(counts);
      if (coverage) {
        expect(coverage.expected).toBeGreaterThan(0);
        expect(Number.isFinite(coverage.ratio)).toBe(true);
      }
    }
  });

  it('reports a ratio above 1 rather than clamping a duplicate away', () => {
    const coverage = computeCoverage(
      days({ '2026-08-30': 96, '2026-08-31': 100, '2026-09-01': 100, '2026-09-02': 4 }),
    );
    expect(coverage?.ratio).toBeCloseTo(200 / 192, 4);
  });
});

describe('applyCoverage', () => {
  /**
   * The whole point of ABL-632: this stream's newest row is two hours old, so
   * every age rule in `freshness.ts` calls it live, and it is Swiss cheese.
   */
  it('degrades a recent-but-holey load stream to stale', () => {
    const result = applyCoverage(live('2026-09-02 06:15:00'), days(DE_LOAD_PROD), 'load');
    expect(result.status).toBe('stale');
    expect(result.coverage?.ratio).toBe(0.6979);
    expect(result.ageHours).toBe(2);
    expect(result.latest).toBe('2026-09-02 06:15:00');
  });

  /**
   * The negative control every suppression fix on this surface has needed. Same
   * country, same table, same resolution — five days earlier, when prod was
   * healthy.
   */
  it('leaves a genuinely complete window alone', () => {
    const healthy = Object.fromEntries(
      Object.entries(DE_LOAD_PROD).filter(([day]) => day <= '2026-08-29'),
    );
    const result = applyCoverage(live('2026-08-29 23:45:00'), days(healthy), 'load');
    expect(result.status).toBe('live');
    expect(result.coverage).toEqual({
      windowStart: '2026-08-27',
      windowEnd: '2026-08-28',
      expectedDailyRows: 96,
      observed: 192,
      expected: 192,
      ratio: 1,
    });
  });

  it('leaves IE alone on an ordinary ragged fortnight', () => {
    // Prod 2026-08-16..29: IE `energy_load` runs 30-minute and routinely drops a
    // few half-hours. Its worst healthy two-day window in the fleet sweep was
    // 0.81, which is what the 0.75 measured threshold is placed below.
    const result = applyCoverage(
      live('2026-08-28 11:30:00'),
      days({
        '2026-08-24': 44,
        '2026-08-25': 46,
        '2026-08-26': 48,
        '2026-08-27': 30,
        '2026-08-28': 22,
      }),
      'load',
    );
    // The window is 08-26..08-27, IE's worst healthy pair on prod.
    expect(result.coverage).toMatchObject({ observed: 78, expected: 96, ratio: 0.8125 });
    expect(result.status).toBe('live');
  });

  it('holds day-ahead streams to a stricter bar than measured ones', () => {
    // A whole market day missing scores ~0.5 and is unambiguous; the measured
    // streams need room for publication jitter that day-ahead documents do not
    // have. Same counts, opposite verdicts.
    const oneMarketDayMissing = days({
      '2026-08-29': 96,
      '2026-08-31': 8,
      '2026-09-01': 96,
      '2026-09-02': 88,
    });
    expect(applyCoverage(live('2026-09-02 21:45:00'), oneMarketDayMissing, 'tsoLoadForecast').status)
      .toBe('stale');

    const jitter = days({ '2026-08-29': 96, '2026-08-31': 82, '2026-09-01': 78, '2026-09-02': 40 });
    expect(applyCoverage(live('2026-09-02 09:45:00'), jitter, 'generation').status).toBe('live');
    expect(applyCoverage(live('2026-09-02 09:45:00'), jitter, 'price').status).toBe('stale');
  });

  it('publishes a low ratio beside a live status when it sits above the threshold', () => {
    // The number is the evidence; the status is the judgement. ABL-632 happened
    // because the evidence was not on the wire at all.
    const result = applyCoverage(
      live('2026-09-02 09:45:00'),
      days({ '2026-08-29': 96, '2026-08-31': 80, '2026-09-01': 76, '2026-09-02': 40 }),
      'load',
    );
    expect(result.status).toBe('live');
    expect(result.coverage?.ratio).toBeCloseTo(156 / 192, 4);
    expect(result.coverage!.ratio).toBeGreaterThan(COVERAGE_MIN_RATIO.load);
  });

  it('never upgrades, and never overrides ended or none', () => {
    const complete = days({ '2026-08-30': 24, '2026-08-31': 24, '2026-09-01': 24 });

    // `ended` and `none` are terminal, non-alarm verdicts (`freshness.ts`).
    // Measured consequence: AL `generation` and HR `tsoGenerationForecast` both
    // score 0.00 over the baseline sweep and both keep the verdict they had.
    const empty = days({ '2026-08-27': 24, '2026-08-31': 0, '2026-09-01': 0, '2026-09-02': 1 });
    for (const status of ['ended', 'none', 'stale'] as const) {
      expect(applyCoverage({ latest: 'x', ageHours: 9000, status }, empty, 'generation').status).toBe(
        status,
      );
    }

    // A full window does not turn a stale stream live either — coverage only
    // ever removes a liveness claim.
    expect(
      applyCoverage({ latest: 'x', ageHours: 40, status: 'stale' }, complete, 'load').status,
    ).toBe('stale');
  });

  it('attaches coverage: null rather than dropping the field', () => {
    const result = applyCoverage(live('2026-09-02 06:15:00'), [], 'load');
    expect(result).toHaveProperty('coverage', null);
    expect(result.status).toBe('live');
  });
});
