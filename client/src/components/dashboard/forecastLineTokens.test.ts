import { describe, it, expect } from 'vitest';
import { forecastLineToken } from './forecastLineTokens';

describe('forecastLineToken', () => {
  it('gives every registered load/price model its own colour and dash', () => {
    const ids = ['catboost', 'xgboost', 'tso-d1', 'tso-d7'];
    const tokens = ids.map(forecastLineToken);

    expect(new Set(tokens.map((t) => t.color)).size).toBe(ids.length);
    expect(new Set(tokens.map((t) => t.dash)).size).toBe(ids.length);
  });

  it('is stable per id regardless of call order — never assigned by position', () => {
    expect(forecastLineToken('xgboost')).toEqual(forecastLineToken('xgboost'));
    // Calling for a different id first must not perturb an earlier id's token.
    const before = forecastLineToken('catboost');
    forecastLineToken('tso-d7');
    expect(forecastLineToken('catboost')).toEqual(before);
  });

  it('falls back to a neutral token for an unregistered id rather than throwing', () => {
    expect(forecastLineToken('some-future-model')).toEqual({ color: '#6B6459', dash: '4 4' });
  });
});
