import { describe, it, expect } from 'vitest';
import { describeForecastGap, type ForecastGapInput } from './forecastGap';

const BASE: ForecastGapInput = {
  active: true,
  pinnedLabel: null,
  isLoading: false,
  isError: false,
  pointCount: 0,
  countryLabel: 'France',
};

describe('describeForecastGap', () => {
  it('says nothing when the overlay is switched off', () => {
    expect(describeForecastGap({ ...BASE, active: false })).toBeNull();
  });

  it('says nothing while the request is in flight', () => {
    expect(describeForecastGap({ ...BASE, isLoading: true })).toBeNull();
  });

  // An error is its own state. Claiming "no forecast in this window" when the
  // request never completed would assert something we did not measure.
  it('says nothing when the request failed', () => {
    expect(describeForecastGap({ ...BASE, isError: true })).toBeNull();
  });

  it('says nothing when the overlay has points to draw', () => {
    expect(describeForecastGap({ ...BASE, pointCount: 48 })).toBeNull();
  });

  // The ABL-16 case: a pin the server honoured strictly, against a country
  // that model has no rows for.
  it('names the pinned model and offers a way out', () => {
    const gap = describeForecastGap({ ...BASE, pinnedLabel: 'able-ml · catboost' });
    expect(gap).toEqual({
      message: 'able-ml · catboost has no forecast for France in this window.',
      clearable: true,
    });
  });

  // Unpinned means the ladder already tried every registered model, so there
  // is no user action to offer — and no model to blame in the copy.
  it('reports an unpinned gap without offering an action', () => {
    const gap = describeForecastGap(BASE);
    expect(gap).toEqual({
      message: 'No forecast published for France in this window.',
      clearable: false,
    });
  });

  it('uses whatever country label it was given', () => {
    const gap = describeForecastGap({ ...BASE, countryLabel: 'PT', pinnedLabel: 'ENTSO-E TSO · D+7' });
    expect(gap?.message).toBe('ENTSO-E TSO · D+7 has no forecast for PT in this window.');
  });
});
