import { describe, it, expect } from 'vitest';
import { isMeasuredLoad, measuredLoadClause } from './loadQuality.js';

describe('isMeasuredLoad', () => {
  it('rejects exactly zero — the whole point of the rule', () => {
    // 543 rows in energy_load are exactly this, across 11 countries, and a
    // national grid never draws 0 MW.
    expect(isMeasuredLoad(0)).toBe(false);
    expect(isMeasuredLoad(-0)).toBe(false);
    expect(isMeasuredLoad(0.0)).toBe(false);
  });

  it('accepts ordinary loads', () => {
    expect(isMeasuredLoad(543.3)).toBe(true);
    expect(isMeasuredLoad(716.9)).toBe(true);
    expect(isMeasuredLoad(19632)).toBe(true);
  });

  it('accepts the small-but-real end of the range rather than rounding it away', () => {
    // The grey zone is deliberately served: MK's smallest positive stored load
    // is 0.01 MW and BA's is 0.44. They look wrong, but nothing has calibrated
    // a floor that would exclude them without also risking a genuine small
    // country's reading, so the rule stays at "provably not a measurement".
    expect(isMeasuredLoad(0.01)).toBe(true);
    expect(isMeasuredLoad(0.44)).toBe(true);
    expect(isMeasuredLoad(3.8)).toBe(true);
  });

  it('rejects absent and non-finite values instead of treating them as zero', () => {
    expect(isMeasuredLoad(null)).toBe(false);
    expect(isMeasuredLoad(undefined)).toBe(false);
    expect(isMeasuredLoad(NaN)).toBe(false);
    expect(isMeasuredLoad(Infinity)).toBe(false);
    expect(isMeasuredLoad(-Infinity)).toBe(false);
  });

  it('rejects negatives — none exist today, but they are the same artifact', () => {
    expect(isMeasuredLoad(-1)).toBe(false);
    expect(isMeasuredLoad(-500)).toBe(false);
  });
});

describe('measuredLoadClause', () => {
  it('is the same rule the predicate applies', () => {
    // Guards the pairing rather than the spelling: if the SQL is ever widened
    // to a magnitude floor, isMeasuredLoad has to move with it.
    expect(measuredLoadClause()).toBe('load_mw > 0');
  });

  it('qualifies an aliased column so a joined query can use it', () => {
    expect(measuredLoadClause('e.load_mw')).toBe('e.load_mw > 0');
  });

  it('compares the bare column, keeping the predicate sargable', () => {
    // A function wrapper here (COALESCE/ABS/…) would forfeit the index seek
    // that rangeClause is carefully built to preserve.
    expect(measuredLoadClause()).not.toMatch(/\(/);
  });
});
