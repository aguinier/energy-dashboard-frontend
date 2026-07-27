import { describe, it, expect } from 'vitest';
import { timeTicks } from './chartTicks';

const hourly = (n: number, from = '2026-07-26T00:00:00Z') =>
  Array.from({ length: n }, (_, i) =>
    new Date(new Date(from).getTime() + i * 3600_000).toISOString());

describe('timeTicks', () => {
  it('labels a 24h window by hour', () => {
    const t = timeTicks(hourly(24), '24h');
    expect(t.length).toBeGreaterThanOrEqual(4);
    expect(t[0].label).toMatch(/^\d{2}:\d{2}$/);
  });

  it('labels a multi-day window by date', () => {
    const t = timeTicks(hourly(24 * 7), '7d');
    expect(t[0].label).not.toMatch(/^\d{2}:\d{2}$/);
  });

  it('returns no ticks for an empty series', () => {
    expect(timeTicks([], '24h')).toEqual([]);
  });

  it('keeps every tick index inside the series', () => {
    const ts = hourly(24);
    expect(timeTicks(ts, '24h').every((t) => t.index >= 0 && t.index < ts.length)).toBe(true);
  });
});
