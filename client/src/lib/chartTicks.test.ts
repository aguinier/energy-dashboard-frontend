import { describe, it, expect } from 'vitest';
import { timeTicks, SHORT_SPAN_HOURS, MEDIUM_SPAN_HOURS } from './chartTicks';

const hourly = (n: number, from = '2026-07-26T00:00:00Z') =>
  Array.from({ length: n }, (_, i) =>
    new Date(new Date(from).getTime() + i * 3600_000).toISOString());

const HOUR_RE = /^\d{2}:\d{2}$/;
const DAY_HOUR_RE = /^[A-Za-z]{3} \d{2}:\d{2}$/;

describe('timeTicks', () => {
  it('labels a 24h window by hour (short tier)', () => {
    const t = timeTicks(hourly(24), '24h');
    expect(t.length).toBeGreaterThanOrEqual(4);
    expect(t[0].label).toMatch(HOUR_RE);
  });

  it('stays hour-only exactly at the short-tier boundary', () => {
    // n points span (n-1) hours, so n = SHORT_SPAN_HOURS + 1 spans exactly
    // SHORT_SPAN_HOURS — the inclusive edge of the "hour" tier.
    const t = timeTicks(hourly(SHORT_SPAN_HOURS + 1), '24h');
    expect(t.every((tick) => HOUR_RE.test(tick.label))).toBe(true);
  });

  it('switches to day+hour just past the short-tier boundary', () => {
    const t = timeTicks(hourly(SHORT_SPAN_HOURS + 2), '24h');
    expect(t.every((tick) => DAY_HOUR_RE.test(tick.label))).toBe(true);
  });

  it('labels a forecast-stretched multi-day window (e.g. ML/TSO overlay) with day + hour', () => {
    // ~4 days, representative of a Load 24h chart with a forecast layer on.
    const t = timeTicks(hourly(96), '24h');
    expect(t.length).toBeGreaterThanOrEqual(4);
    expect(t.every((tick) => DAY_HOUR_RE.test(tick.label))).toBe(true);
  });

  it('stays day+hour exactly at the medium-tier boundary', () => {
    const t = timeTicks(hourly(MEDIUM_SPAN_HOURS + 1), '24h');
    expect(t.every((tick) => DAY_HOUR_RE.test(tick.label))).toBe(true);
  });

  it('falls back to date-only just past the medium-tier boundary', () => {
    const t = timeTicks(hourly(MEDIUM_SPAN_HOURS + 2), '24h');
    expect(t.every((tick) => !tick.label.includes(':'))).toBe(true);
  });

  it('labels a multi-day window by date for non-hourly presets regardless of span', () => {
    const t = timeTicks(hourly(24 * 7), '7d');
    expect(t[0].label).not.toMatch(HOUR_RE);
    expect(t[0].label).not.toContain(':');
  });

  it('returns no ticks for an empty series', () => {
    expect(timeTicks([], '24h')).toEqual([]);
  });

  it('keeps every tick index inside the series', () => {
    const ts = hourly(24);
    expect(timeTicks(ts, '24h').every((t) => t.index >= 0 && t.index < ts.length)).toBe(true);
  });
});
