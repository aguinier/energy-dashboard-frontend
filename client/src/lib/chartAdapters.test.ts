import { describe, it, expect } from 'vitest';
import { adaptNetPositionSeries, buildSeriesGrid } from './chartAdapters';
import type { NetPositionResponse } from '@/types';

const NOW = new Date('2026-07-28T10:00:00Z');

function point(hourIso: string, value: number) {
  return { timestamp: hourIso, net_position_mw: value };
}

function forecastPoint(
  hourIso: string,
  p50: number,
  generated_at: string,
  horizon_hours: number,
  band?: { p10: number; p90: number },
) {
  return {
    timestamp: hourIso,
    p50,
    p10: band?.p10 ?? null,
    p90: band?.p90 ?? null,
    generated_at,
    horizon_hours,
  };
}

describe('buildSeriesGrid', () => {
  it('keeps a selected Brussels market day through its final hour, without plotting preloaded tomorrow rows', () => {
    const { series } = buildSeriesGrid({
      actual: [
        { timestamp: '2026-08-04T22:00:00.000Z', price: 100 }, // 00:00 CEST
        { timestamp: '2026-08-05T21:00:00.000Z', price: 110 }, // 23:00 CEST
        { timestamp: '2026-08-05T22:00:00.000Z', price: 120 }, // tomorrow
      ],
      actualValue: (point) => point.price,
      forecast: [],
      window: {
        start: new Date('2026-08-04T22:00:00.000Z'),
        end: new Date('2026-08-05T21:59:59.999Z'),
      },
      now: NOW,
    });

    expect(series).toHaveLength(24);
    expect(series[0].ts).toBe('2026-08-04T22:00:00.000Z');
    expect(series.at(-1)?.ts).toBe('2026-08-05T21:00:00.000Z');
    expect(series.at(-1)?.value).toBe(110);
    expect(series.some((point) => point.value === 120)).toBe(false);
  });
});

describe('adaptNetPositionSeries', () => {
  it('tags each forecast point with the day label of the vintage that produced it', () => {
    const data: NetPositionResponse = {
      actual: [point('2026-07-28T00:00:00Z', 100)],
      forecast: [
        forecastPoint('2026-07-28T01:00:00Z', 50, '2026-07-26T07:06:28.960696', 41),
        forecastPoint('2026-07-29T01:00:00Z', 60, '2026-07-27T06:00:35.035825', 42),
      ],
      meta: {
        bidding_zone: 'FR',
        model_name: 'chronos-2-V010',
        has_band: false,
        last_seen: null,
        forecast_coverage: 'served',
        degenerate_forecast: null,
        actual_coverage: 'served',
        degenerate_actual: null,
        vintages: [
          {
            generated_at: '2026-07-26T07:06:28.960696',
            model_version: '20260726_070628',
            horizon_hours_min: 40,
            horizon_hours_max: 63,
            target_count: 24,
            first_target: '2026-07-28T00:00:00',
            last_target: '2026-07-28T23:00:00',
          },
          {
            generated_at: '2026-07-27T06:00:35.035825',
            model_version: '20260727_060035',
            horizon_hours_min: 41,
            horizon_hours_max: 64,
            target_count: 24,
            first_target: '2026-07-29T00:00:00',
            last_target: '2026-07-29T23:00:00',
          },
        ],
      },
    };

    const { series } = adaptNetPositionSeries(data, NOW);
    const jul28 = series.find((p) => p.ts === '2026-07-28T01:00:00.000Z')!;
    const jul29 = series.find((p) => p.ts === '2026-07-29T01:00:00.000Z')!;

    expect(jul28.forecast).toBe(50);
    expect(jul28.forecastGeneratedAt).toBe('2026-07-26T07:06:28.960696');
    expect(jul28.forecastDayLabel).toBe('D+2');

    expect(jul29.forecast).toBe(60);
    expect(jul29.forecastGeneratedAt).toBe('2026-07-27T06:00:35.035825');
    expect(jul29.forecastDayLabel).toBe('D+2');
  });

  it('still labels a single-vintage forecast — the simple case is not regressed', () => {
    const data: NetPositionResponse = {
      actual: [],
      forecast: [forecastPoint('2026-07-28T00:00:00Z', -57.2, '2026-07-26T07:06:28.960696', 40)],
      meta: {
        bidding_zone: 'BE',
        model_name: 'chronos-2-V010',
        has_band: false,
        last_seen: null,
        forecast_coverage: 'served',
        degenerate_forecast: null,
        actual_coverage: 'served',
        degenerate_actual: null,
        vintages: [
          {
            generated_at: '2026-07-26T07:06:28.960696',
            model_version: '20260726_070628',
            horizon_hours_min: 40,
            horizon_hours_max: 40,
            target_count: 1,
            first_target: '2026-07-28T00:00:00',
            last_target: '2026-07-28T00:00:00',
          },
        ],
      },
    };

    const { series } = adaptNetPositionSeries(data, NOW);
    const p = series.find((pt) => pt.forecast != null)!;
    expect(p.forecastDayLabel).toBe('D+2');
    expect(p.forecastGeneratedAt).toBe('2026-07-26T07:06:28.960696');
  });

  it('leaves the band and provenance untouched when there is no forecast at all', () => {
    const data: NetPositionResponse = {
      actual: [point('2026-07-28T00:00:00Z', 100)],
      forecast: [],
      meta: {
        bidding_zone: 'GR',
        model_name: null,
        has_band: false,
        last_seen: null,
        forecast_coverage: 'served',
        degenerate_forecast: null,
        actual_coverage: 'served',
        degenerate_actual: null,
        vintages: [],
      },
    };

    const { series } = adaptNetPositionSeries(data, NOW);
    expect(series.every((p) => p.forecast == null)).toBe(true);
    expect(series.every((p) => p.forecastDayLabel == null || p.forecastDayLabel === undefined)).toBe(
      true,
    );
  });
});
