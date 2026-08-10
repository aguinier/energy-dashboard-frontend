import { describe, expect, it } from 'vitest';
import type { CrossCountryMetrics } from '@/types';
import { buildPortfolioRows } from './portfolioRows';

const DATA: CrossCountryMetrics = {
  BE: {
    load: { mae: 4, wape: 12.5, rmse: 5, bias: 0, dataPoints: 20 },
    price: { mae: 2, wape: null, rmse: 3, bias: 0, dataPoints: 20 },
  },
  FR: {
    load: { mae: 3, wape: 4.2, rmse: 4, bias: 0, dataPoints: 20 },
    price: { mae: 3, wape: null, rmse: 4, bias: 0, dataPoints: 20 },
  },
};

describe('buildPortfolioRows', () => {
  it('surfaces every supported variable, including net position without a cross-country metric', () => {
    const rows = buildPortfolioRows(DATA);
    expect(rows.map((row) => row.type)).toEqual([
      'load', 'price', 'renewable', 'solar', 'wind_onshore', 'wind_offshore', 'hydro_total', 'biomass', 'net_position',
    ]);
    expect(rows.find((row) => row.type === 'net_position')).toMatchObject({
      coverage: 'unavailable', pairedCountries: 0, minWape: null,
    });
  });

  it('reports the observed country WAPE range without averaging unlike units or filling coverage gaps', () => {
    const load = buildPortfolioRows(DATA).find((row) => row.type === 'load')!;
    expect(load).toMatchObject({
      coverage: 'measured', pairedCountries: 2, measuredCountries: 2, minWape: 4.2, maxWape: 12.5,
    });
  });

  it('keeps paired but unmeasurable WAPE distinct from no paired data', () => {
    const price = buildPortfolioRows(DATA).find((row) => row.type === 'price')!;
    const solar = buildPortfolioRows(DATA).find((row) => row.type === 'solar')!;
    expect(price).toMatchObject({
      coverage: 'unmeasurable', pairedCountries: 2, measuredCountries: 0, minWape: null, maxWape: null,
    });
    expect(solar).toMatchObject({ coverage: 'unavailable', pairedCountries: 0, measuredCountries: 0 });
  });
});
