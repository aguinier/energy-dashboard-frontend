import { describe, it, expect } from 'vitest';
import {
  describeHeadroom,
  describeHeadroomBasis,
  describeStorage,
  diskSeries,
  hasReadings,
  sideDiskPercent,
  thresholdLines,
} from './opsHistorySeries';
import type { DiskHeadroom, OpsSideSnapshot, OpsSnapshot, OpsStatusHistory } from '@/types';

function side(overrides: Partial<OpsSideSnapshot> = {}): OpsSideSnapshot {
  return {
    reachable: true,
    latencyMs: 5,
    diskUsedBytes: 800,
    diskTotalBytes: 1000,
    rssBytes: 100,
    uptimeSeconds: 60,
    freshnessStatus: 'live',
    staleCountryCount: 0,
    commit: 'abc1234',
    ...overrides,
  };
}

const DOWN: OpsSideSnapshot = {
  reachable: false,
  latencyMs: null,
  diskUsedBytes: null,
  diskTotalBytes: null,
  rssBytes: null,
  uptimeSeconds: null,
  freshnessStatus: null,
  staleCountryCount: null,
  commit: null,
};

function snapshot(t: string, local: OpsSideSnapshot, peer: OpsSideSnapshot): OpsSnapshot {
  return { t, local, peer };
}

function headroom(overrides: Partial<DiskHeadroom> = {}): DiskHeadroom {
  return {
    thresholdPercent: 90,
    days: null,
    reason: 'no_readings',
    basis: null,
    ...overrides,
  };
}

function history(overrides: Partial<OpsStatusHistory> = {}): OpsStatusHistory {
  return {
    timestamp: '2026-08-15T00:00:00.000Z',
    windowHours: 168,
    snapshots: [],
    headroom: { local: headroom(), peer: headroom() },
    storage: {
      captureEnabled: true,
      intervalMinutes: 15,
      retentionDays: 14,
      storedSnapshots: 0,
      skippedLines: 0,
      error: null,
    },
    ...overrides,
  };
}

describe('sideDiskPercent', () => {
  it('computes used percent from a real reading', () => {
    expect(sideDiskPercent(side())).toBe(80);
  });

  it('is null for a side that reported no disk', () => {
    expect(sideDiskPercent(DOWN)).toBeNull();
  });

  it('is null — not 0% — for a filesystem reporting zero total bytes', () => {
    expect(sideDiskPercent(side({ diskUsedBytes: 0, diskTotalBytes: 0 }))).toBeNull();
  });
});

describe('diskSeries', () => {
  it('keeps an unmeasured side as a hole rather than plotting it at zero', () => {
    const series = diskSeries([
      snapshot('2026-08-14T00:00:00.000Z', side(), side({ diskUsedBytes: 500 })),
      snapshot('2026-08-14T00:15:00.000Z', side(), DOWN),
      snapshot('2026-08-14T00:30:00.000Z', side(), side({ diskUsedBytes: 505 })),
    ]);

    expect(series.map((p) => p.peer)).toEqual([50, null, 50.5]);
    expect(series.map((p) => p.local)).toEqual([80, 80, 80]);
  });

  it('preserves order and timestamps', () => {
    const series = diskSeries([
      snapshot('2026-08-14T00:00:00.000Z', side(), side()),
      snapshot('2026-08-14T00:15:00.000Z', side(), side()),
    ]);

    expect(series.map((p) => p.t)).toEqual(['2026-08-14T00:00:00.000Z', '2026-08-14T00:15:00.000Z']);
  });
});

describe('hasReadings', () => {
  it('is false for a side that was never measured, so the chart draws no line for it', () => {
    const series = diskSeries([snapshot('2026-08-14T00:00:00.000Z', side(), DOWN)]);

    expect(hasReadings(series, 'local')).toBe(true);
    expect(hasReadings(series, 'peer')).toBe(false);
  });
});

describe('describeHeadroom', () => {
  it('states the crossing when there is one', () => {
    expect(describeHeadroom(headroom({ reason: 'ok', days: 11.4 }))).toBe('Crosses 90% in about 11 days');
  });

  it('does not round a sub-day crossing away to "0 days"', () => {
    expect(describeHeadroom(headroom({ reason: 'ok', days: 0.4 }))).toBe('Crosses 90% in under a day');
    expect(describeHeadroom(headroom({ reason: 'ok', days: 1.2 }))).toBe('Crosses 90% in about a day');
  });

  it.each([
    ['no_readings' as const, 'No disk readings stored yet'],
    ['not_rising' as const, 'Not rising — no crossing to project'],
    ['noisy_fit' as const, 'Readings are too scattered to project a crossing'],
    ['already_breached' as const, 'Already at or above 90%'],
    ['beyond_horizon' as const, 'Rising too slowly to cross 90% within a year'],
  ])('says why it cannot project for %s, rather than showing a number', (reason, expected) => {
    expect(describeHeadroom(headroom({ reason }))).toBe(expected);
  });

  it('names how little history it has when that is the blocker', () => {
    const result = describeHeadroom(
      headroom({
        reason: 'insufficient_history',
        basis: { points: 3, spanHours: 18, slopePercentPerDay: 1, r2: 0.99, currentPercent: 80, minSpanHours: 72 },
      }),
    );

    expect(result).toBe('Not enough history yet — 3 readings over 18h');
  });

  it('names both the span it has and the span it needs when the window is too short', () => {
    const result = describeHeadroom(
      headroom({
        reason: 'insufficient_span',
        basis: { points: 12, spanHours: 5.5, slopePercentPerDay: 1, r2: 0.99, currentPercent: 80, minSpanHours: 72 },
      }),
    );

    expect(result).toBe(
      'History too short to project — 6h of the 3.0 days needed to average out the daily backup and sync cycle',
    );
  });

  it('takes the required span from the server rather than restating it (ABL-459)', () => {
    // The bar lives in `MIN_SPAN_HOURS` on the server. If it moves, the sentence
    // moves with it — a hardcoded "3 days" here would be a confidently wrong
    // number on the one page whose job is to be trustworthy (the ABL-292 rule).
    const result = describeHeadroom(
      headroom({
        reason: 'insufficient_span',
        basis: { points: 400, spanHours: 100, slopePercentPerDay: 1, r2: 0.99, currentPercent: 80, minSpanHours: 168 },
      }),
    );

    expect(result).toContain('7.0 days needed');
    expect(result).not.toContain('3.0 days');
  });

  it('never renders a headroom sentence as an empty string', () => {
    const reasons: DiskHeadroom['reason'][] = [
      'ok',
      'no_readings',
      'insufficient_history',
      'insufficient_span',
      'not_rising',
      'noisy_fit',
      'already_breached',
      'beyond_horizon',
    ];

    for (const reason of reasons) {
      expect(describeHeadroom(headroom({ reason, days: reason === 'ok' ? 5 : null }))).not.toBe('');
    }
  });
});

describe('describeHeadroomBasis', () => {
  it('shows what the verdict was fitted from', () => {
    const result = describeHeadroomBasis(
      headroom({
        reason: 'ok',
        days: 7,
        basis: { points: 42, spanHours: 149, slopePercentPerDay: 1.234, r2: 0.9712, currentPercent: 83.25, minSpanHours: 72 },
      }),
    );

    expect(result).toBe('83.3% now · +1.23 pts/day · 42 readings over 6.2 days · R²=0.97');
  });

  it('signs a falling slope', () => {
    const result = describeHeadroomBasis(
      headroom({
        reason: 'not_rising',
        basis: { points: 20, spanHours: 24, slopePercentPerDay: -0.5, r2: 0.8, currentPercent: 60, minSpanHours: 72 },
      }),
    );

    expect(result).toContain('-0.50 pts/day');
  });

  it('is null when no line could be fitted, so the page shows no evidence line', () => {
    expect(describeHeadroomBasis(headroom({ reason: 'no_readings' }))).toBeNull();
  });
});

describe('describeStorage', () => {
  it('distinguishes an unreadable store from an empty one', () => {
    const result = describeStorage(
      history({
        storage: { ...history().storage, error: 'EACCES: permission denied' },
      }),
    );

    expect(result).toContain('could not be read');
    expect(result).toContain('EACCES');
  });

  it('distinguishes capture being switched off from nothing captured yet', () => {
    const off = describeStorage(history({ storage: { ...history().storage, captureEnabled: false } }));
    const empty = describeStorage(history());

    expect(off).toContain('switched off');
    expect(empty).toContain('No snapshots stored yet');
    expect(empty).toContain('every 15 minutes');
  });

  it('summarises what is charted against what is stored', () => {
    const result = describeStorage(
      history({
        snapshots: Array.from({ length: 96 }, (_, i) => snapshot(`2026-08-14T00:${i}`, side(), side())),
        storage: { ...history().storage, storedSnapshots: 1300 },
      }),
    );

    expect(result).toBe('96 readings in the last 7d, of 1300 stored · captured every 15m · kept 14d');
  });

  it('reports damaged lines rather than hiding the loss', () => {
    const result = describeStorage(
      history({
        snapshots: [snapshot('2026-08-14T00:00:00.000Z', side(), side())],
        storage: { ...history().storage, storedSnapshots: 10, skippedLines: 2 },
      }),
    );

    expect(result).toContain('2 damaged lines skipped');
  });
});

describe('thresholdLines', () => {
  it('draws one unqualified rule when both sides turn red at the same percent', () => {
    expect(thresholdLines({ local: headroom(), peer: headroom() })).toEqual([
      { percent: 90, label: '90%' },
    ]);
  });

  it('draws a labelled rule per side when the volumes escalate at different percents', () => {
    // Acceptance's 1.86 TiB workstation volume passes 90% with 186 GiB still
    // free and does not escalate until 94.62% (ABL-586); prod's 907 GiB volume
    // still turns red at 90%. One rule labelled "90%" across both series would
    // be a wrong number in the place a reader looks to judge the gap.
    const lines = thresholdLines({
      local: headroom({ thresholdPercent: 94.62 }),
      peer: headroom({ thresholdPercent: 90 }),
    });

    expect(lines).toEqual([
      { percent: 94.62, label: '94.62% this env' },
      { percent: 90, label: '90% peer' },
    ]);
  });
});
