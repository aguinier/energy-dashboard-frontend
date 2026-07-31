import { describe, it, expect } from 'vitest';
import { summarizeSeries } from './chartSummary';
import type { AbleSeriesPoint } from '@/components/charts/AbleLineChart';

function point(overrides: Partial<AbleSeriesPoint> & { ts: string }): AbleSeriesPoint {
  return { future: false, value: null, forecast: null, ...overrides };
}

// 24 hourly points, values ramping 33 -> 45 and back down a touch, matching
// the "load ranged 33–45 GW over 24 hours" example from the task brief.
function hourlySeries(values: number[], from = '2026-07-27T00:00:00Z'): AbleSeriesPoint[] {
  return values.map((v, i) =>
    point({ ts: new Date(new Date(from).getTime() + i * 3_600_000).toISOString(), value: v }),
  );
}

describe('summarizeSeries', () => {
  it('reports no data for an empty series', () => {
    expect(summarizeSeries([], 0, { label: 'Load' })).toBe('Load: no data in this window.');
  });

  it('reports no data when every point is null (future-only placeholder grid)', () => {
    const series = [point({ ts: '2026-07-27T00:00:00Z' }), point({ ts: '2026-07-27T01:00:00Z' })];
    expect(summarizeSeries(series, 0, { label: 'Load' })).toBe('Load: no data in this window.');
  });

  it('ranges over actual values and names the latest reading, matching the brief\'s example shape', () => {
    const values = [33, 35, 38, 40, 42, 45, 44, 41];
    const series = hourlySeries(values);
    // now = exactly the last point's timestamp, so no staleness note.
    const now = new Date(series[series.length - 1].ts);
    const summary = summarizeSeries(series, series.length - 1, { label: 'Load', unit: 'GW', now });
    expect(summary).toBe('Load ranged 33.0–45.0 GW over 8 hours. Currently 41.0 GW.');
  });

  it('uses days once the window reaches 48 hours', () => {
    const values = Array.from({ length: 72 }, (_, i) => 30 + (i % 10));
    const series = hourlySeries(values);
    const now = new Date(series[series.length - 1].ts);
    const summary = summarizeSeries(series, series.length - 1, { label: 'Load', unit: 'GW', now });
    expect(summary).toContain('over 3 days.');
  });

  it('notes staleness once the latest actual is 2+ hours behind now', () => {
    const values = [33, 35, 38];
    const series = hourlySeries(values);
    // now is 5 hours after the last point.
    const now = new Date(new Date(series[series.length - 1].ts).getTime() + 5 * 3_600_000);
    const summary = summarizeSeries(series, series.length - 1, { label: 'Load', unit: 'GW', now });
    expect(summary).toContain('as of 5 hours ago');
  });

  it('does not note staleness for a sub-2-hour gap', () => {
    const values = [33, 35, 38];
    const series = hourlySeries(values);
    const now = new Date(new Date(series[series.length - 1].ts).getTime() + 1 * 3_600_000);
    const summary = summarizeSeries(series, series.length - 1, { label: 'Load', unit: 'GW', now });
    expect(summary).not.toContain('as of');
    expect(summary).toContain('Currently 38.0 GW.');
  });

  it('describes how far a forecast reaches beyond now', () => {
    const series: AbleSeriesPoint[] = [
      point({ ts: '2026-07-27T00:00:00Z', value: 40 }),
      point({ ts: '2026-07-27T01:00:00Z', value: 42 }),
      point({ ts: '2026-07-27T02:00:00Z', forecast: 44 }),
      point({ ts: '2026-07-27T03:00:00Z', forecast: 46 }),
      point({ ts: '2026-07-27T04:00:00Z', forecast: 48 }),
    ];
    const now = new Date('2026-07-27T01:30:00Z'); // between index 1 (actual) and 2 (forecast)
    const summary = summarizeSeries(series, 1, { label: 'Load', unit: 'GW', now });
    expect(summary).toContain('Forecast continues 3 more hours, reaching 48.0 GW.');
  });

  it('omits the forecast sentence when there is no forecast data', () => {
    const series = hourlySeries([10, 12, 14]);
    const now = new Date(series[series.length - 1].ts);
    const summary = summarizeSeries(series, series.length - 1, { label: 'Price', unit: '€/MWh', now });
    expect(summary).not.toContain('Forecast');
  });

  it('includes forecast-only values (no actuals yet) in the range and skips the "currently" sentence', () => {
    const series: AbleSeriesPoint[] = [
      point({ ts: '2026-07-27T00:00:00Z', forecast: 50 }),
      point({ ts: '2026-07-27T01:00:00Z', forecast: 55 }),
    ];
    const now = new Date('2026-07-27T00:00:00Z');
    const summary = summarizeSeries(series, 0, { label: 'Net position', unit: 'MW', now });
    expect(summary).toContain('ranged 50.0–55.0 MW');
    expect(summary).not.toContain('Currently');
  });

  it('formats large magnitudes with the default formatter when no formatValue is given', () => {
    const series = hourlySeries([12000, 15000, 9000]);
    const now = new Date(series[series.length - 1].ts);
    const summary = summarizeSeries(series, series.length - 1, { label: 'Load', unit: 'MW', now });
    expect(summary).toContain('9.0k–15.0k MW');
  });

  it('falls back to a generic label and no unit when neither is supplied', () => {
    const series = hourlySeries([1, 2, 3]);
    const now = new Date(series[series.length - 1].ts);
    const summary = summarizeSeries(series, series.length - 1, { now });
    expect(summary.startsWith('Value ranged 1.0–3.0 over 3 hours.')).toBe(true);
    expect(summary).toContain('Currently 3.0.');
  });

  it('clamps an out-of-range nowIndex instead of throwing', () => {
    const series = hourlySeries([5, 6, 7]);
    expect(() => summarizeSeries(series, 999, { label: 'Load', unit: 'GW' })).not.toThrow();
    expect(() => summarizeSeries(series, -5, { label: 'Load', unit: 'GW' })).not.toThrow();
  });
});
