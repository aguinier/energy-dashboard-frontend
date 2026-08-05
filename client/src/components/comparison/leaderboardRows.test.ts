import { describe, it, expect } from 'vitest';
import type { CrossCountryMetrics } from '@/types';
import { buildLeaderboardRows, wapeRanks } from './leaderboardRows';

// Shaped after the real /cross-country/metrics response, measured 2026-08-05
// over the default 30-day window: most countries carry {load, price} only,
// FR and BE carry all eight types. That asymmetry is the whole point.
const DATA: CrossCountryMetrics = {
  IT: {
    load: { mae: 2185.5, wape: 8.11, rmse: 2802.1, bias: -120.4, dataPoints: 701 },
    price: { mae: 12.4, wape: 11.71, rmse: 17.9, bias: 1.2, dataPoints: 700 },
  },
  BE: {
    load: { mae: 512.3, wape: 5.61, rmse: 690.2, bias: -30.1, dataPoints: 701 },
    price: { mae: 30.9, wape: 39.24, rmse: 44.8, bias: 4.6, dataPoints: 700 },
    wind_onshore: { mae: 402.2, wape: 191.2, rmse: 511.7, bias: 88.0, dataPoints: 690 },
    wind_offshore: { mae: 611.4, wape: 156.4, rmse: 802.5, bias: 101.3, dataPoints: 690 },
  },
  NO: {
    load: { mae: 328.9, wape: 2.14, rmse: 441.0, bias: -8.8, dataPoints: 701 },
    price: { mae: 9.8, wape: 28.1, rmse: 15.2, bias: 0.9, dataPoints: 700 },
  },
  // A country whose price WAPE was not measurable — the window's actuals
  // summed to zero, so WAPE is null rather than 0.
  XX: {
    price: { mae: 4.1, wape: null, rmse: 6.0, bias: 0.2, dataPoints: 12 },
  },
};

describe('buildLeaderboardRows', () => {
  it('builds one row per country that has the requested type', () => {
    const rows = buildLeaderboardRows(DATA, 'load');
    expect(rows.map((r) => r.country).sort()).toEqual(['BE', 'IT', 'NO']);
  });

  it('omits countries with no entry for the type rather than zero-filling them', () => {
    const rows = buildLeaderboardRows(DATA, 'wind_offshore');
    expect(rows).toHaveLength(1);
    expect(rows[0].country).toBe('BE');
  });

  it('carries each metric through unchanged — no averaging across types', () => {
    // The defect this replaces averaged every metric over whatever types a
    // country had, which added EUR/MWh price error to MW load error. IT's row
    // must be exactly IT's load numbers.
    const row = buildLeaderboardRows(DATA, 'load').find((r) => r.country === 'IT')!;
    expect(row.wape).toBe(8.11);
    expect(row.mae).toBe(2185.5);
    expect(row.rmse).toBe(2802.1);
    expect(row.bias).toBe(-120.4);
    expect(row.dataPoints).toBe(701);
  });

  it('never ranks a country on forecast types it is not measured on', () => {
    // BE's average WAPE across its 8 types was 76.8% and IT's across 2 was
    // 9.9%, which put IT 20 places above BE for wind forecasts IT does not
    // have at all. Per type, BE actually forecasts load better than IT.
    const load = buildLeaderboardRows(DATA, 'load');
    const be = load.find((r) => r.country === 'BE')!;
    const it = load.find((r) => r.country === 'IT')!;
    expect(be.wape!).toBeLessThan(it.wape!);
  });

  it('returns nothing for "all" — there is no single well-defined row', () => {
    expect(buildLeaderboardRows(DATA, 'all')).toEqual([]);
  });

  it('keeps an unmeasurable WAPE as null instead of coercing it to 0', () => {
    const row = buildLeaderboardRows(DATA, 'price').find((r) => r.country === 'XX')!;
    expect(row.wape).toBeNull();
    expect(row.mae).toBe(4.1);
  });
});

describe('wapeRanks', () => {
  it('ranks best (lowest) WAPE first', () => {
    const ranks = wapeRanks(buildLeaderboardRows(DATA, 'load'));
    expect(ranks.get('NO')).toBe(1);
    expect(ranks.get('BE')).toBe(2);
    expect(ranks.get('IT')).toBe(3);
  });

  it('gives tied countries the same rank and skips the next (1,2,2,4)', () => {
    const ranks = wapeRanks([
      { country: 'A', wape: 5, mae: null, rmse: null, bias: null, dataPoints: 1 },
      { country: 'B', wape: 7, mae: null, rmse: null, bias: null, dataPoints: 1 },
      { country: 'C', wape: 7, mae: null, rmse: null, bias: null, dataPoints: 1 },
      { country: 'D', wape: 9, mae: null, rmse: null, bias: null, dataPoints: 1 },
    ]);
    expect([...ranks.values()]).toEqual([1, 2, 2, 4]);
  });

  it('leaves an unmeasurable country unranked rather than placing it last', () => {
    const ranks = wapeRanks(buildLeaderboardRows(DATA, 'price'));
    expect(ranks.has('XX')).toBe(false);
    // ...and it is excluded from the denominator, so "#3 of 3" counts only
    // the countries actually in the running.
    expect(ranks.size).toBe(3);
  });

  it('handles an empty set', () => {
    expect(wapeRanks([]).size).toBe(0);
  });
});
