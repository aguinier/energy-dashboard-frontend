import { describe, it, expect } from 'vitest';
import { chartTimeTicks, timeTicks, SHORT_SPAN_HOURS, MEDIUM_SPAN_HOURS } from './chartTicks';

const hourly = (n: number, from = '2026-07-26T00:00:00Z') =>
  Array.from({ length: n }, (_, i) =>
    new Date(new Date(from).getTime() + i * 3600_000).toISOString());

const HOUR_RE = /^\d{2}:\d{2}$/;
// Weekday + day-of-month + time, e.g. "Tue 28 06:00". The day-of-month is
// required so weekday abbreviations (which repeat every 7 days) don't collide
// within a single ~9-day medium-tier tick set — see the uniqueness tests below.
const DAY_HOUR_RE = /^[A-Za-z]{3} \d{1,2} \d{2}:\d{2}$/;

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

  it('produces unique day+hour labels across an exact 7-day modular collision', () => {
    // A weekday-only (no day-of-month) format is periodic in 168h (7 days):
    // a tick exactly 168h after another lands on the same weekday *and* the
    // same hour-of-day, rendering byte-identical labels. n=169 spans exactly
    // 168h, so with target=5, step = floor(168/4) = 42 and ticks land at
    // offsets 0, 42, 84, 126, 168 — the first and last collide. This is the
    // sharpest reproduction of the bug: it fails against the pre-fix
    // weekday-only format (both render e.g. "Sun 02:00") and passes once
    // day-of-month is included (e.g. "Sun 26 02:00" vs "Sun 2 02:00").
    const t = timeTicks(hourly(169), '24h');
    const labels = t.map((tick) => tick.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('produces unique labels at the medium-tier boundary, where two ticks share a weekday', () => {
    // hourly(MEDIUM_SPAN_HOURS + 1) — the fixture from the boundary test
    // above — spans 216h, so ticks land at offsets 0/54/108/162/216h. 54h
    // and 216h are each 2 days (mod 7) after the anchor, so those two ticks
    // render the same weekday abbreviation (e.g. both "Tue"); day-of-month
    // is what keeps their full labels distinguishable.
    const t = timeTicks(hourly(MEDIUM_SPAN_HOURS + 1), '24h');
    const labels = t.map((tick) => tick.label);
    expect(new Set(labels).size).toBe(labels.length);
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

describe('chartTimeTicks', () => {
  it('labels Today by hour across the full-day canvas', () => {
    const timestamps = hourly(24, '2026-07-26T00:45:00Z');
    const ticks = chartTimeTicks(timestamps, 'today', 12);

    expect(ticks.length).toBeGreaterThanOrEqual(4);
    expect(ticks.every((tick) => HOUR_RE.test(tick.label))).toBe(true);
    expect(ticks.every((tick) => tick.label.endsWith(':00'))).toBe(true);
  });

  it('labels a 7d hourly series with day markers and keeps now', () => {
    const timestamps = hourly(24 * 7 + 1);
    const ticks = chartTimeTicks(timestamps, '7d', timestamps.length - 1);

    expect(ticks.length).toBeGreaterThanOrEqual(7);
    expect(ticks.some((tick) => tick.label === 'now')).toBe(true);
    expect(ticks.filter((tick) => tick.label !== 'now').every((tick) => !tick.label.includes(':'))).toBe(true);
  });

  it('selects useful date ticks from a daily 30d series', () => {
    const timestamps = Array.from({ length: 30 }, (_, i) =>
      new Date(Date.UTC(2026, 6, i + 1)).toISOString(),
    );
    const ticks = chartTimeTicks(timestamps, '30d', timestamps.length - 1);

    expect(ticks.length).toBeGreaterThanOrEqual(7);
    expect(ticks.length).toBeLessThanOrEqual(10);
    expect(ticks.some((tick) => tick.label === 'now')).toBe(true);
    expect(ticks.filter((tick) => tick.label !== 'now').every((tick) => !tick.label.includes(':'))).toBe(true);
  });
});
