import { describe, it, expect } from 'vitest';
import { adaptNetPositionSeries, adaptNetPositionMultiSeries, adaptWindSeries, buildSeriesGrid } from './chartAdapters';
import type { NetPositionModelSeriesInput } from './chartAdapters';
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

describe('adaptWindSeries', () => {
  const windData = [
    { timestamp: '2026-08-04T10:00:00', wind_onshore: 200, wind_offshore: 50 },
    { timestamp: '2026-08-04T11:00:00', wind_onshore: null, wind_offshore: 60 },
  ];
  const tsoForecast = [
    { timestamp: '2026-08-04T10:00:00', solar_mw: 10, wind_onshore_mw: 300, wind_offshore_mw: 80, total_forecast_mw: 390 },
  ];

  it('reads the onshore column when windType is wind_onshore, not offshore', () => {
    const { series } = adaptWindSeries({ windData, windType: 'wind_onshore' });

    expect(series[0].value).toBe(200);
    // Second bucket's onshore reading is unreported (null), never a
    // fabricated 0 - even though offshore has a real 60 that hour.
    expect(series[1].value).toBeNull();
  });

  it('reads the offshore column when windType is wind_offshore', () => {
    const { series } = adaptWindSeries({ windData, windType: 'wind_offshore' });

    expect(series[0].value).toBe(50);
    expect(series[1].value).toBe(60);
  });

  it('picks the matching column out of the bundled TSO forecast response', () => {
    const onshore = adaptWindSeries({ windData, windType: 'wind_onshore', tsoForecast });
    const offshore = adaptWindSeries({ windData, windType: 'wind_offshore', tsoForecast });

    expect(onshore.series[0].forecast).toBe(300);
    expect(offshore.series[0].forecast).toBe(80);
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

describe('adaptNetPositionMultiSeries', () => {
  function response(opts: {
    actual?: NetPositionResponse['actual'];
    forecast?: NetPositionResponse['forecast'];
    vintages?: NetPositionResponse['meta']['vintages'];
  }): NetPositionResponse {
    return {
      actual: opts.actual ?? [],
      forecast: opts.forecast ?? [],
      meta: {
        bidding_zone: 'FR',
        model_name: 'chronos-2-V010',
        has_band: false,
        last_seen: null,
        forecast_coverage: (opts.forecast?.length ?? 0) > 0 ? 'served' : 'no_forecast',
        degenerate_forecast: null,
        actual_coverage: (opts.actual?.length ?? 0) > 0 ? 'served' : 'no_actuals',
        degenerate_actual: null,
        vintages: opts.vintages ?? [],
      },
    };
  }

  const ACTUAL = [point('2026-07-28T00:00:00Z', 100), point('2026-07-28T01:00:00Z', 110)];

  it('draws one entry per model, each under its own key in forecasts', () => {
    const v010: NetPositionModelSeriesInput = {
      id: 'chronos-2-V010',
      label: 'Chronos-2 · V010',
      color: '#2a78d6',
      response: response({
        actual: ACTUAL,
        forecast: [forecastPoint('2026-07-28T00:00:00Z', 50, '2026-07-27T06:00:00', 24)],
      }),
    };
    const v012: NetPositionModelSeriesInput = {
      id: 'baseline-V012',
      label: 'Baseline · V012',
      color: '#c98500',
      response: response({
        actual: ACTUAL,
        forecast: [forecastPoint('2026-07-28T00:00:00Z', 65, '2026-07-27T06:00:00', 24)],
      }),
    };

    const { series, forecastSeries } = adaptNetPositionMultiSeries([v010, v012], NOW);

    expect(forecastSeries.map((s) => s.id)).toEqual(['chronos-2-V010', 'baseline-V012']);
    const p0 = series.find((p) => p.ts === '2026-07-28T00:00:00.000Z')!;
    expect(p0.value).toBe(100);
    expect(p0.forecasts).toEqual({ 'chronos-2-V010': 50, 'baseline-V012': 65 });
  });

  it('draws no band and no single-vintage label when more than one model is active', () => {
    const a: NetPositionModelSeriesInput = {
      id: 'a',
      label: 'A',
      color: '#111',
      response: response({
        forecast: [forecastPoint('2026-07-28T00:00:00Z', 10, '2026-07-27T06:00:00', 24, { p10: 5, p90: 15 })],
      }),
    };
    const b: NetPositionModelSeriesInput = {
      id: 'b',
      label: 'B',
      color: '#222',
      response: response({
        forecast: [forecastPoint('2026-07-28T00:00:00Z', 20, '2026-07-27T06:00:00', 24)],
      }),
    };

    const { series } = adaptNetPositionMultiSeries([a, b], NOW);
    const p0 = series.find((p) => p.ts === '2026-07-28T00:00:00.000Z')!;

    // Both values still land in the per-model map...
    expect(p0.forecasts).toEqual({ a: 10, b: 20 });
    // ...but nothing claims the single-series fields, which AbleLineChart
    // reads only when `forecastSeries` is absent — a stray band or vintage
    // label here would misattribute A's p10-p90 to the whole multi-line chart.
    expect(p0.forecast).toBeNull();
    expect(p0.min).toBeUndefined();
    expect(p0.max).toBeUndefined();
    expect(p0.forecastDayLabel).toBeUndefined();
  });

  it('reproduces the single-response band and day label when exactly one model is active', () => {
    const solo: NetPositionModelSeriesInput = {
      id: 'chronos-2-V010',
      label: 'Chronos-2 · V010',
      color: '#2a78d6',
      response: response({
        forecast: [forecastPoint('2026-07-28T00:00:00Z', 10, '2026-07-27T06:00:00', 40, { p10: -5, p90: 25 })],
        vintages: [
          {
            generated_at: '2026-07-27T06:00:00',
            model_version: 'v1',
            horizon_hours_min: 40,
            horizon_hours_max: 40,
            target_count: 1,
            first_target: '2026-07-28T00:00:00',
            last_target: '2026-07-28T00:00:00',
          },
        ],
      }),
    };

    const { series } = adaptNetPositionMultiSeries([solo], NOW);
    const p0 = series.find((p) => p.ts === '2026-07-28T00:00:00.000Z')!;

    expect(p0.forecast).toBe(10);
    expect(p0.min).toBe(-5);
    expect(p0.max).toBe(25);
    expect(p0.forecastDayLabel).toBe('D+2');
  });

  it('names a selected model with no rows nowhere in forecastSeries, without dropping the others', () => {
    const empty: NetPositionModelSeriesInput = {
      id: 'xgboost-V014',
      label: 'XGBoost · V014',
      color: '#008300',
      response: response({ actual: ACTUAL, forecast: [] }),
    };
    const served: NetPositionModelSeriesInput = {
      id: 'chronos-2-V010',
      label: 'Chronos-2 · V010',
      color: '#2a78d6',
      response: response({
        actual: ACTUAL,
        forecast: [forecastPoint('2026-07-28T00:00:00Z', 50, '2026-07-27T06:00:00', 24)],
      }),
    };

    const { series, forecastSeries } = adaptNetPositionMultiSeries([empty, served], NOW);

    expect(forecastSeries.map((s) => s.id)).toEqual(['chronos-2-V010']);
    const p0 = series.find((p) => p.ts === '2026-07-28T00:00:00.000Z')!;
    expect(p0.value).toBe(100); // actual still drawn
  });

  it('takes the actuals from whichever entry has them, when some are still empty', () => {
    const noActual: NetPositionModelSeriesInput = {
      id: 'a',
      label: 'A',
      color: '#111',
      response: response({ actual: [], forecast: [] }),
    };
    const withActual: NetPositionModelSeriesInput = {
      id: 'b',
      label: 'B',
      color: '#222',
      response: response({ actual: ACTUAL, forecast: [] }),
    };

    const { series } = adaptNetPositionMultiSeries([noActual, withActual], NOW);
    expect(series.find((p) => p.ts === '2026-07-28T00:00:00.000Z')?.value).toBe(100);
  });

  it('ignores an entry whose query has not resolved yet', () => {
    const stillLoading: NetPositionModelSeriesInput = {
      id: 'a',
      label: 'A',
      color: '#111',
      response: undefined,
    };
    const ready: NetPositionModelSeriesInput = {
      id: 'b',
      label: 'B',
      color: '#222',
      response: response({
        actual: ACTUAL,
        forecast: [forecastPoint('2026-07-28T00:00:00Z', 50, '2026-07-27T06:00:00', 24)],
      }),
    };

    const { series, forecastSeries } = adaptNetPositionMultiSeries([stillLoading, ready], NOW);
    expect(forecastSeries.map((s) => s.id)).toEqual(['b']);
    expect(series.find((p) => p.ts === '2026-07-28T00:00:00.000Z')?.value).toBe(100);
  });

  it('returns an empty series when nothing has any rows', () => {
    const a: NetPositionModelSeriesInput = {
      id: 'a',
      label: 'A',
      color: '#111',
      response: response({}),
    };
    expect(adaptNetPositionMultiSeries([a], NOW)).toEqual({ series: [], nowIndex: 0, forecastSeries: [] });
  });
});
