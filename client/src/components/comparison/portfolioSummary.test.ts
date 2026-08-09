import { describe, expect, it } from 'vitest';
import { summarizePortfolio } from './portfolioSummary';

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
