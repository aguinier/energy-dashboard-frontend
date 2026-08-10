import { describe, expect, it } from 'vitest';
import { buildPortfolioRows, summarizePortfolio } from './portfolioSummary';

describe('summarizePortfolio', () => {
  it('counts only series measurable for the selected metric', () => {
    const summary = summarizePortfolio({
      DE: {
        load: { wape: 3.4, mae: 120, rmse: 150, bias: 0, dataPoints: 48 },
        price: { wape: null, mae: 12, rmse: 14, bias: 0, dataPoints: 48 },
      },
      FR: { load: { wape: 0, mae: 0, rmse: 0, bias: 0, dataPoints: 24 } },
    }, 'wape');

    expect(summary).toEqual({ countries: 2, forecastTypes: 1, measuredSeries: 2, pairedObservations: 72 });
  });
});

describe('buildPortfolioRows', () => {
  const data = {
    DE: {
      load: { wape: 3.4, mae: 120, rmse: 150, bias: 0, dataPoints: 48 },
      price: { wape: null, mae: 12, rmse: 14, bias: 0, dataPoints: 48 },
    },
    FR: {
      load: { wape: 8.1, mae: 100, rmse: 120, bias: 0, dataPoints: 24 },
      price: { wape: null, mae: 8, rmse: 10, bias: 0, dataPoints: 24 },
    },
  };

  it('surfaces every supported variable, including net position without a cross-country metric', () => {
    expect(buildPortfolioRows(data).map((row) => row.type)).toEqual([
      'load', 'price', 'renewable', 'solar', 'wind_onshore', 'wind_offshore', 'hydro_total', 'biomass', 'net_position',
    ]);
  });

  it('keeps measured, unmeasurable, and unavailable coverage distinct', () => {
    const rows = buildPortfolioRows(data);
    expect(rows.find((row) => row.type === 'load')).toMatchObject({
      coverage: 'measured', pairedCountries: 2, measuredCountries: 2, minWape: 3.4, maxWape: 8.1,
    });
    expect(rows.find((row) => row.type === 'price')).toMatchObject({
      coverage: 'unmeasurable', pairedCountries: 2, measuredCountries: 0, minWape: null,
    });
    expect(rows.find((row) => row.type === 'net_position')).toMatchObject({
      coverage: 'unavailable', pairedCountries: 0, measuredCountries: 0,
    });
  });
});
