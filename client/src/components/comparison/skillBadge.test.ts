import { describe, expect, it } from 'vitest';
import { describeSkill, formatSkillPct } from './skillBadge';

describe('describeSkill', () => {
  it('is a win when skill is positive', () => {
    expect(describeSkill({ n: 12, skillPct: 23.4, baselineWape: 5.1 }))
      .toEqual({ kind: 'win', n: 12, skillPct: 23.4, label: '+23.4%' });
  });

  it('is a loss — never a neutral number — when skill is negative', () => {
    expect(describeSkill({ n: 4, skillPct: -500, baselineWape: 1.59 }))
      .toEqual({ kind: 'loss', n: 4, skillPct: -500, label: '-500.0%' });
  });

  it('is insufficient data, not 0%, when there are no baseline pairs', () => {
    expect(describeSkill({ n: 0, skillPct: null, baselineWape: null }))
      .toEqual({ kind: 'insufficient', n: 0 });
  });

  it('is insufficient data when the baseline WAPE itself is unmeasurable', () => {
    // e.g. every actual in the intersection summed to zero.
    expect(describeSkill({ n: 3, skillPct: null, baselineWape: null }))
      .toEqual({ kind: 'insufficient', n: 3 });
  });

  it('is insufficient data, not a crash, for a stale response missing the field entirely', () => {
    expect(describeSkill(undefined)).toEqual({ kind: 'insufficient', n: 0 });
    expect(describeSkill(null)).toEqual({ kind: 'insufficient', n: 0 });
  });

  it('treats exactly-zero skill as a win, not a loss (tied, not behind)', () => {
    expect(describeSkill({ n: 5, skillPct: 0, baselineWape: 8 }).kind).toBe('win');
  });
});

describe('formatSkillPct', () => {
  it('signs a positive value explicitly', () => {
    expect(formatSkillPct(23.4)).toBe('+23.4%');
  });

  it('carries the negative sign through', () => {
    expect(formatSkillPct(-500)).toBe('-500.0%');
  });

  it('does not sign zero', () => {
    expect(formatSkillPct(0)).toBe('0.0%');
  });
});
