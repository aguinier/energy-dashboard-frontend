import { describe, it, expect } from 'vitest';
import {
  accruesCharges,
  mergeAdjacent,
  monthDurationMs,
  monthStartIso,
  segmentsForMonth,
  servesTraffic,
  stateAt,
  SUBSCRIPTION_STATUSES,
  type SubscriptionChange,
} from './subscription.js';
import { monthEndExclusive } from '../usage/usageStore.js';

/**
 * The property everything downstream rests on: **the segments of a month sum to
 * exactly that month.**
 *
 * `invoice.ts` prorates by `segment.durationMs / monthMs`. If the segments left
 * a gap the customer would be under-charged for it; if they overlapped they
 * would be charged twice. Neither would be visible in a total — a €249 plan
 * billed at €248.99 reads as a rounding decision — so the property is asserted
 * directly rather than inferred from an invoice.
 */

let sequence = 0;

function change(overrides: Partial<SubscriptionChange> = {}): SubscriptionChange {
  sequence += 1;
  return {
    id: `sub_chg_${String(sequence).padStart(4, '0')}`,
    accountId: 'acct_test',
    effectiveAt: '2026-07-01T00:00:00.000Z',
    plan: 'developer',
    status: 'active',
    reason: null,
    recordedAt: '2026-06-30T12:00:00.000Z',
    ...overrides,
  };
}

const MONTHS = ['2026-01', '2026-02', '2026-04', '2026-07', '2028-02'];

describe('month arithmetic', () => {
  it.each(MONTHS)('%s durations sum to the month, whatever the changes', (yearMonth) => {
    const changes = [
      change({ effectiveAt: `${yearMonth}-01T00:00:00.000Z`, plan: 'explorer' }),
      change({ effectiveAt: `${yearMonth}-05T13:47:11.123Z`, plan: 'developer' }),
      change({ effectiveAt: `${yearMonth}-19T00:00:00.000Z`, plan: 'professional' }),
      change({ effectiveAt: `${yearMonth}-19T00:00:00.000Z`, status: 'past_due' }),
    ];

    const segments = segmentsForMonth(changes, yearMonth);
    const total = segments.reduce((sum, segment) => sum + segment.durationMs, 0);

    expect(total).toBe(monthDurationMs(yearMonth));
  });

  it.each(MONTHS)('%s segments are contiguous with no gap and no overlap', (yearMonth) => {
    const segments = segmentsForMonth(
      [change({ effectiveAt: `${yearMonth}-11T06:00:00.000Z`, plan: 'professional' })],
      yearMonth
    );

    expect(segments[0].fromIso).toBe(monthStartIso(yearMonth));
    expect(segments[segments.length - 1].toIso).toBe(monthEndExclusive(yearMonth).toISOString());
    for (let i = 0; i < segments.length - 1; i += 1) {
      expect(segments[i].toIso).toBe(segments[i + 1].fromIso);
    }
  });

  it('measures February in a leap year as 29 days, not as 30 or as 30.44', () => {
    // A month is not a constant. Prorating against an average would over- or
    // under-charge every February and every 31-day month, forever.
    expect(monthDurationMs('2028-02') / 86_400_000).toBe(29);
    expect(monthDurationMs('2026-02') / 86_400_000).toBe(28);
    expect(monthDurationMs('2026-07') / 86_400_000).toBe(31);
  });
});

describe('stateAt', () => {
  it('is the latest change at or before the instant', () => {
    const changes = [
      change({ effectiveAt: '2026-07-01T00:00:00.000Z', plan: 'explorer' }),
      change({ effectiveAt: '2026-07-15T00:00:00.000Z', plan: 'developer' }),
    ];

    expect(stateAt(changes, '2026-07-14T23:59:59.999Z')?.plan).toBe('explorer');
    expect(stateAt(changes, '2026-07-15T00:00:00.000Z')?.plan).toBe('developer');
  });

  it('is null before the first change, so a month before the subscription charges nothing', () => {
    const changes = [change({ effectiveAt: '2026-07-01T00:00:00.000Z' })];
    expect(stateAt(changes, '2026-06-30T23:59:59.999Z')).toBeNull();
  });

  it('resolves two changes at the same instant to the one recorded later', () => {
    // This is what a correction is: the same effective instant, entered again.
    // Ordering on `effectiveAt` alone would leave the answer dependent on the
    // order rows came back from SQLite in.
    const changes = [
      change({
        effectiveAt: '2026-07-10T00:00:00.000Z',
        plan: 'developer',
        recordedAt: '2026-07-10T09:00:00.000Z',
      }),
      change({
        effectiveAt: '2026-07-10T00:00:00.000Z',
        plan: 'professional',
        recordedAt: '2026-07-11T09:00:00.000Z',
      }),
    ];

    expect(stateAt(changes, '2026-07-20T00:00:00.000Z')?.plan).toBe('professional');
    // And the same answer from the reversed list.
    expect(stateAt([...changes].reverse(), '2026-07-20T00:00:00.000Z')?.plan).toBe('professional');
  });
});

describe('segmentsForMonth', () => {
  it('collapses everything before the month into the opening state', () => {
    const segments = segmentsForMonth(
      [
        change({ effectiveAt: '2026-01-01T00:00:00.000Z', plan: 'explorer' }),
        change({ effectiveAt: '2026-03-01T00:00:00.000Z', plan: 'developer' }),
      ],
      '2026-07'
    );

    expect(segments).toHaveLength(1);
    expect(segments[0].plan).toBe('developer');
    expect(segments[0].durationMs).toBe(monthDurationMs('2026-07'));
  });

  it('ignores a change effective after the month', () => {
    // A downgrade agreed in July for August must not touch July's invoice.
    const segments = segmentsForMonth(
      [
        change({ effectiveAt: '2026-07-01T00:00:00.000Z', plan: 'professional' }),
        change({ effectiveAt: '2026-08-01T00:00:00.000Z', plan: 'developer' }),
      ],
      '2026-07'
    );

    expect(segments).toHaveLength(1);
    expect(segments[0].plan).toBe('professional');
  });

  it('marks the stretch before a first mid-month change as having no subscription', () => {
    // Not "the plan they later took". Traffic here is a finding, not a free
    // fortnight, and `invoice.ts` blocks on it.
    const segments = segmentsForMonth(
      [change({ effectiveAt: '2026-07-15T00:00:00.000Z', plan: 'developer' })],
      '2026-07'
    );

    expect(segments).toHaveLength(2);
    expect(segments[0].plan).toBeNull();
    expect(segments[0].status).toBeNull();
    expect(segments[1].plan).toBe('developer');
  });

  it('treats two changes at one instant as one boundary, not a zero-length segment', () => {
    const at = '2026-07-15T00:00:00.000Z';
    const segments = segmentsForMonth(
      [
        change({ effectiveAt: '2026-07-01T00:00:00.000Z', plan: 'developer' }),
        change({ effectiveAt: at, plan: 'professional', recordedAt: '2026-07-15T08:00:00.000Z' }),
        change({
          effectiveAt: at,
          plan: 'professional',
          status: 'past_due',
          recordedAt: '2026-07-15T09:00:00.000Z',
        }),
      ],
      '2026-07'
    );

    expect(segments).toHaveLength(2);
    expect(segments.every((segment) => segment.durationMs > 0)).toBe(true);
    expect(segments[1].status).toBe('past_due');
  });
});

describe('mergeAdjacent', () => {
  it('folds a change that changed nothing back into one segment', () => {
    // Two identical segments each round their prorated fee down, so the customer
    // pays a cent for a row somebody entered twice. Merging first makes the fee
    // depend on the state history rather than on how often it was written down.
    const merged = mergeAdjacent(
      segmentsForMonth(
        [
          change({ effectiveAt: '2026-07-01T00:00:00.000Z', plan: 'developer' }),
          change({ effectiveAt: '2026-07-15T00:00:00.000Z', plan: 'developer' }),
        ],
        '2026-07'
      )
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].durationMs).toBe(monthDurationMs('2026-07'));
  });

  it('keeps a genuine change and preserves the total duration', () => {
    const segments = segmentsForMonth(
      [
        change({ effectiveAt: '2026-07-01T00:00:00.000Z', plan: 'developer' }),
        change({ effectiveAt: '2026-07-15T00:00:00.000Z', plan: 'professional' }),
      ],
      '2026-07'
    );
    const merged = mergeAdjacent(segments);

    expect(merged).toHaveLength(2);
    expect(merged.reduce((sum, s) => sum + s.durationMs, 0)).toBe(monthDurationMs('2026-07'));
  });
});

describe('the two predicates', () => {
  it('serves and charges on active and past_due, and neither on paused or canceled', () => {
    // past_due serves, and that is ABL-297 §6.5 rather than leniency: suspension
    // is never fully automated, so a card that expired must not become an
    // outage the customer learns about from their own monitoring.
    expect(servesTraffic('active')).toBe(true);
    expect(servesTraffic('past_due')).toBe(true);
    expect(servesTraffic('paused')).toBe(false);
    expect(servesTraffic('canceled')).toBe(false);

    for (const status of SUBSCRIPTION_STATUSES) {
      expect(accruesCharges(status)).toBe(servesTraffic(status));
    }
  });

  it('has no trialing status — a trial is a plan priced at zero', () => {
    // Asserted so that adding one is a deliberate decision with this comment
    // read again: a status that suppressed a fee would put a commercial rule in
    // a state machine, where the price book cannot see it.
    expect(SUBSCRIPTION_STATUSES).not.toContain('trialing');
  });
});
