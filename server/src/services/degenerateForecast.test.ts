import { describe, it, expect } from 'vitest';
import {
  classifyActualSeries,
  classifyForecastSeries,
  DEGENERATE_SERIES_MAX_ABS_MW,
} from './degenerateForecast.js';

/**
 * GR's real medians, sampled from `forecasts` on 2026-08-06
 * (country_code='GR', forecast_type='net_position', model_name='chronos-2-V010').
 * Note none is exactly 0.0 - that is the whole reason a `= 0` guard misses this.
 */
const GR_MEDIANS = [
  4.582052497426048e-7,
  -1.7743546720794257e-7,
  2.3065367324437425e-11,
  -8.861614553268282e-9,
  1.1990963777464003e-9,
];

/** GR's stored band, same query: p10 floor and p90 ceiling over 168 rows. */
const GR_P10 = -0.0000034854574550990947;
const GR_P90 = 0.003754783421754837;

describe('classifyForecastSeries', () => {
  it("calls GR's measured net-position series degenerate", () => {
    const rows = GR_MEDIANS.map((p50) => ({ p50, p10: GR_P10, p90: GR_P90 }));
    expect(classifyForecastSeries(rows)).toEqual({
      coverage: 'degenerate_zero',
      points: 5,
      max_abs_mw: GR_P90,
    });
  });

  it('is not fooled by values that are near zero but never exactly zero', () => {
    // The guard someone reaches for first - `every(v => v === 0)` - classifies
    // this series as fine, because not one of GR's 168 rows is exactly 0.0.
    expect(GR_MEDIANS.some((v) => v === 0)).toBe(false);
    expect(classifyForecastSeries(GR_MEDIANS.map((p50) => ({ p50 }))).coverage).toBe(
      'degenerate_zero'
    );
  });

  it('serves the quietest genuine day-window in the table', () => {
    // SI, 2026-07-29: the lowest per-country-per-day maximum across every
    // net_position forecast row, 16.7 MW. Nothing real sits below this.
    const rows = [{ p50: 16.716278076171875 }, { p50: -3.2 }, { p50: 0.5 }];
    expect(classifyForecastSeries(rows).coverage).toBe('served');
  });

  it('never suppresses a real series because individual points sit near zero', () => {
    // A net position crosses zero on its way from importing to exporting, and
    // genuine rows go as low as 0.0094 MW (ES). Judging point-by-point would
    // delete exactly the part of the chart worth looking at.
    const rows = [{ p50: -900 }, { p50: 0.0093994140625 }, { p50: 880 }];
    const out = classifyForecastSeries(rows);
    expect(out.coverage).toBe('served');
    expect(out.max_abs_mw).toBe(900);
  });

  it('keeps a zero-centred forecast that carries a real uncertainty band', () => {
    // "Could go either way by ±3 GW" is a genuine statement about a hard
    // window, not a collapsed series - the band is what makes it one.
    const rows = [
      { p50: 0.2, p10: -3000, p90: 3000 },
      { p50: -0.1, p10: -2800, p90: 2900 },
    ];
    expect(classifyForecastSeries(rows).coverage).toBe('served');
  });

  it('judges a median-only series on its median alone', () => {
    // p10/p90 are null when the deployment has no forecast_quantiles table.
    const rows = [{ p50: 1.0e-7, p10: null, p90: null }];
    expect(classifyForecastSeries(rows)).toEqual({
      coverage: 'degenerate_zero',
      points: 1,
      max_abs_mw: 1.0e-7,
    });
  });

  it('reports max_abs_mw as null, never 0, when there are no rows at all', () => {
    // No rows is a different fact from "the rows are zero". A 0 here would be
    // a measurement of a series that was never measured.
    expect(classifyForecastSeries([])).toEqual({
      coverage: 'no_forecast',
      points: 0,
      max_abs_mw: null,
    });
  });

  it('treats the threshold as exclusive, so a series peaking at the floor is served', () => {
    expect(
      classifyForecastSeries([{ p50: DEGENERATE_SERIES_MAX_ABS_MW }]).coverage
    ).toBe('served');
    expect(
      classifyForecastSeries([{ p50: DEGENERATE_SERIES_MAX_ABS_MW - 1e-9 }]).coverage
    ).toBe('degenerate_zero');
  });

  it('ignores non-finite values rather than letting them decide the maximum', () => {
    const out = classifyForecastSeries([
      { p50: NaN, p10: null, p90: null },
      { p50: 5000, p10: Infinity, p90: null },
    ]);
    expect(out.coverage).toBe('served');
    expect(out.max_abs_mw).toBe(5000);
  });

  it('accepts a caller-supplied threshold', () => {
    const rows = [{ p50: 12 }];
    expect(classifyForecastSeries(rows, 100).coverage).toBe('degenerate_zero');
    expect(classifyForecastSeries(rows, 10).coverage).toBe('served');
  });
});

describe('classifyActualSeries', () => {
  it("calls GR's published net position degenerate", () => {
    // Every net_position row GR has published since 2025-10-01 is this value:
    // 192 of 192, across 7 separate fetch batches (measured 2026-08-06).
    expect(classifyActualSeries([0, 0, 0, 0])).toEqual({
      coverage: 'degenerate_zero',
      points: 4,
      max_abs_mw: 0,
    });
  });

  it('serves the quietest genuine day in the whole table', () => {
    // IE 2023-09-01, the lowest daily max|net_position_mw| of all 26,882
    // country-days with >= 20 hours, excluding the 9 degenerate ones. It clears
    // the 1 MW floor by two orders of magnitude - the threshold is not tuned to
    // an edge.
    const out = classifyActualSeries([12.4, -40.1, 92.3, -8.0]);
    expect(out.coverage).toBe('served');
    expect(out.max_abs_mw).toBe(92.3);
  });

  it('judges the series maximum, never a single point', () => {
    // A real net position crosses zero several times a day. Judging point by
    // point would punch holes through exactly the interesting part.
    const out = classifyActualSeries([-900, 0, 0.0, 1200]);
    expect(out.coverage).toBe('served');
    expect(out.points).toBe(4);
  });

  it('reports no_actuals for an empty window, with a null measurement', () => {
    // Not `max_abs_mw: 0` - there was nothing to measure, and a 0 here is the
    // absent-read-as-measured mistake this module exists to stop.
    expect(classifyActualSeries([])).toEqual({
      coverage: 'no_actuals',
      points: 0,
      max_abs_mw: null,
    });
  });

  it('treats the threshold as exclusive, matching the forecast rule', () => {
    expect(classifyActualSeries([DEGENERATE_SERIES_MAX_ABS_MW]).coverage).toBe('served');
    expect(classifyActualSeries([DEGENERATE_SERIES_MAX_ABS_MW - 1e-9]).coverage).toBe(
      'degenerate_zero'
    );
  });

  it('skips nulls rather than counting them as zero', () => {
    // net_position_mw is REAL NOT NULL, so a null means a caller mapped
    // something wrong. Skipping can only raise the maximum, never lower it, so
    // it can never turn a real series degenerate.
    const out = classifyActualSeries([null, undefined, NaN, -500]);
    expect(out.coverage).toBe('served');
    expect(out.max_abs_mw).toBe(500);
    expect(out.points).toBe(4);
  });
});
