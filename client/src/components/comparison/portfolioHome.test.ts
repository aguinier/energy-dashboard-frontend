import { describe, expect, it } from 'vitest';
import type { CrossCountryMetrics } from '@/types';
import { activatesCountryDetail, rankingState, responsePresentTypes } from './portfolioHome';

const data: CrossCountryMetrics = {
  BE: { load: { mae: 2, wape: 12, rmse: 3, bias: 0, dataPoints: 4 }, price: { mae: 1, wape: null, rmse: 2, bias: 0, dataPoints: 4 } },
  FR: { load: { mae: 2, wape: 5, rmse: 3, bias: 0, dataPoints: 4 } },
  DE: { load: { mae: 2, wape: 8, rmse: 3, bias: 0, dataPoints: 4 } },
};

describe('forecast portfolio home', () => {
  it('offers only response-present types when All cannot define a ranking', () => {
    expect(responsePresentTypes(data)).toEqual(['load', 'price']);
    expect(rankingState(data, 'all')).toMatchObject({ kind: 'choose', rows: [] });
  });
  it('keeps a null WAPE unmeasurable and out of the ranking scale', () => {
    const state = rankingState(data, 'price');
    if (state.kind !== 'rank') throw new Error('expected ranking');
    expect(state.rows[0]).toMatchObject({ country: 'BE', wape: null });
    expect(state.scale.count).toBe(0);
  });
  it('treats fewer than three measured WAPEs as neutral rather than ranked', () => {
    const sparse = rankingState({ BE: data.BE, FR: data.FR }, 'load');
    if (sparse.kind !== 'rank') throw new Error('expected ranking');
    expect(sparse.scale.usable).toBe(false);
  });
  it('activates country detail by pointer, Enter, or Space only', () => {
    expect(activatesCountryDetail({})).toBe(true);
    expect(activatesCountryDetail({ key: 'Enter' })).toBe(true);
    expect(activatesCountryDetail({ key: ' ' })).toBe(true);
    expect(activatesCountryDetail({ key: 'Escape' })).toBe(false);
  });
});
