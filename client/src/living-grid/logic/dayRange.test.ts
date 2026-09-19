import { describe, it, expect } from 'vitest';
import {
  canStepDay,
  dayOffset,
  dayRelation,
  DAY_REACH_BACK,
  DAY_REACH_FORWARD,
  relativeDayLabel,
  shiftDate,
  withinReach,
} from './dayRange';

describe('shiftDate', () => {
  it('steps within a month', () => {
    expect(shiftDate('2026-09-19', 1)).toBe('2026-09-20');
    expect(shiftDate('2026-09-19', -1)).toBe('2026-09-18');
    expect(shiftDate('2026-09-19', 0)).toBe('2026-09-19');
  });

  it('rolls over month and year boundaries', () => {
    expect(shiftDate('2026-09-30', 1)).toBe('2026-10-01');
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDate('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('handles a leap day', () => {
    expect(shiftDate('2028-02-28', 1)).toBe('2028-02-29');
    expect(shiftDate('2028-02-29', 1)).toBe('2028-03-01');
    expect(shiftDate('2026-02-28', 1)).toBe('2026-03-01');
  });

  /**
   * The reason the arithmetic goes through Date.UTC rather than a local parse.
   * Both European DST transitions fall on these days, and a local-timezone
   * implementation lands on the same date twice or skips one outright.
   */
  it('steps cleanly across both DST transitions', () => {
    expect(shiftDate('2026-10-24', 1)).toBe('2026-10-25');
    expect(shiftDate('2026-10-25', 1)).toBe('2026-10-26');
    expect(shiftDate('2026-03-28', 1)).toBe('2026-03-29');
    expect(shiftDate('2026-03-29', 1)).toBe('2026-03-30');
  });

  it('leaves a malformed date alone rather than inventing one', () => {
    expect(shiftDate('', 1)).toBe('');
    expect(shiftDate('not-a-date', 1)).toBe('not-a-date');
  });
});

describe('dayOffset', () => {
  it('counts whole days in both directions', () => {
    expect(dayOffset('2026-09-19', '2026-09-19')).toBe(0);
    expect(dayOffset('2026-09-19', '2026-09-26')).toBe(7);
    expect(dayOffset('2026-09-19', '2026-09-12')).toBe(-7);
  });

  it('counts across a DST boundary as whole days, not 23 or 25 hours', () => {
    expect(dayOffset('2026-10-24', '2026-10-26')).toBe(2);
    expect(dayOffset('2026-03-28', '2026-03-30')).toBe(2);
  });
});

describe('withinReach', () => {
  const today = '2026-09-19';

  it('admits both bounds', () => {
    expect(withinReach(shiftDate(today, DAY_REACH_FORWARD), today)).toBe(true);
    expect(withinReach(shiftDate(today, -DAY_REACH_BACK), today)).toBe(true);
  });

  it('refuses one step beyond either bound', () => {
    expect(withinReach(shiftDate(today, DAY_REACH_FORWARD + 1), today)).toBe(false);
    expect(withinReach(shiftDate(today, -DAY_REACH_BACK - 1), today)).toBe(false);
  });
});

describe('canStepDay', () => {
  const today = '2026-09-19';

  it('allows a step that stays inside the reach', () => {
    expect(canStepDay(today, today, 1)).toBe(true);
    expect(canStepDay(today, today, -1)).toBe(true);
  });

  it('refuses the step that would leave it', () => {
    const far = shiftDate(today, DAY_REACH_FORWARD);
    expect(canStepDay(far, today, 1)).toBe(false);
    expect(canStepDay(far, today, -1)).toBe(true);

    const back = shiftDate(today, -DAY_REACH_BACK);
    expect(canStepDay(back, today, -1)).toBe(false);
    expect(canStepDay(back, today, 1)).toBe(true);
  });
});

describe('dayRelation', () => {
  it('compares lexicographically', () => {
    expect(dayRelation('2026-09-19', '2026-09-19')).toBe('today');
    expect(dayRelation('2026-09-20', '2026-09-19')).toBe('future');
    expect(dayRelation('2026-09-18', '2026-09-19')).toBe('past');
  });

  it('orders correctly across a year boundary, where a string compare could not be assumed', () => {
    expect(dayRelation('2027-01-01', '2026-12-31')).toBe('future');
    expect(dayRelation('2026-12-31', '2027-01-01')).toBe('past');
  });
});

describe('relativeDayLabel', () => {
  const today = '2026-09-19';

  it('names the three days that have names', () => {
    expect(relativeDayLabel(today, today)).toBe('Today');
    expect(relativeDayLabel('2026-09-20', today)).toBe('Tomorrow');
    expect(relativeDayLabel('2026-09-18', today)).toBe('Yesterday');
  });

  it('counts the rest, with the house minus rather than a hyphen', () => {
    expect(relativeDayLabel('2026-09-22', today)).toBe('+3 days');
    expect(relativeDayLabel('2026-09-16', today)).toBe('−3 days');
    expect(relativeDayLabel('2026-09-16', today)).not.toContain('-');
  });
});
