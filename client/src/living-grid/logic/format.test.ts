import { describe, it, expect } from 'vitest';
import { dayLabel, euro, gw, hourLabel, MINUS, percent, seriesRange, signedGw } from './format';

describe('signedGw', () => {
  it('always carries a sign, so a column of values lines up', () => {
    expect(signedGw(2_000)).toBe('+2.0');
    expect(signedGw(-2_000)).toBe(`${MINUS}2.0`);
    expect(signedGw(0)).toBe('+0.0');
  });

  it('uses a true minus sign, not a hyphen', () => {
    // In IBM Plex Mono the minus is the width of the plus and the hyphen is
    // not, so a hyphen makes the column jitter as values cross zero.
    expect(signedGw(-1_500)).not.toContain('-');
    expect(signedGw(-1_500).charCodeAt(0)).toBe(0x2212);
  });

  it('renders a missing value as a dash rather than zero', () => {
    expect(signedGw(null)).toBe('—');
    expect(signedGw(undefined)).toBe('—');
  });
});

describe('gw and euro', () => {
  it('converts MW to GW at one decimal', () => {
    expect(gw(62_874)).toBe('62.9');
    expect(gw(null)).toBe('—');
  });

  it('rounds prices and prefixes the symbol', () => {
    expect(euro(113.47)).toBe('€113');
    expect(euro(null)).toBe('—');
  });

  it('keeps a negative price readable', () => {
    // Negative day-ahead prices are ordinary in this market and must not read
    // as "€-12" with the sign stranded after the symbol.
    expect(euro(-12)).toBe(`${MINUS}€12`);
  });
});

describe('hourLabel', () => {
  it('pads to two digits', () => {
    expect(hourLabel(0)).toBe('00:00');
    expect(hourLabel(9)).toBe('09:00');
    expect(hourLabel(23)).toBe('23:00');
  });

  it('clamps out-of-range input', () => {
    expect(hourLabel(-1)).toBe('00:00');
    expect(hourLabel(99)).toBe('23:00');
  });
});

describe('dayLabel', () => {
  it('renders a calendar date the way the design does', () => {
    expect(dayLabel('2026-09-17')).toBe('Thu 17 Sep 2026');
  });

  it('does not shift the day into the viewer timezone', () => {
    // The string names a calendar day. Parsed as local time, anyone west of
    // Greenwich would be shown the day before.
    expect(dayLabel('2026-01-01')).toBe('Thu 1 Jan 2026');
  });

  it('passes an unparseable value through rather than inventing a date', () => {
    expect(dayLabel('nonsense')).toBe('nonsense');
  });
});

describe('percent and seriesRange', () => {
  it('formats a fraction as a percentage', () => {
    expect(percent(0.305)).toBe('30.5%');
    expect(percent(null)).toBe('—');
  });

  it('finds the extremes of a series, ignoring gaps', () => {
    expect(seriesRange([null, 5, 12, null, 3])).toEqual({ min: 3, max: 12 });
  });

  it('returns null when a series holds nothing', () => {
    expect(seriesRange([null, null])).toBeNull();
  });

  it('does not treat a gap as a zero when finding the minimum', () => {
    expect(seriesRange([null, 40, 60])).toEqual({ min: 40, max: 60 });
  });
});
