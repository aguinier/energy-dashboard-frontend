import { describe, it, expect } from 'vitest';
import {
  describeForecastGap,
  describeForecastGapsForSelection,
  type ForecastGapInput,
  type SelectionGapEntry,
} from './forecastGap';

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

const GAP_ENTRY: SelectionGapEntry = {
  id: 'catboost',
  label: 'able-ml · catboost',
  color: '#2C8A6B',
  isLoading: false,
  isError: false,
  pointCount: 0,
};

describe('describeForecastGapsForSelection', () => {
  // The ABL-204 acceptance case: catboost and xgboost checked together for a
  // country only one of them forecasts.
  it('names the empty model and leaves the covered one out', () => {
    const gaps = describeForecastGapsForSelection(
      [GAP_ENTRY, { ...GAP_ENTRY, id: 'xgboost', label: 'able-ml · xgboost', color: '#756BB1', pointCount: 12 }],
      'France',
    );
    expect(gaps).toEqual([
      { id: 'catboost', color: '#2C8A6B', message: 'able-ml · catboost has no forecast for France in this window.' },
    ]);
  });

  it('says nothing for a model still loading', () => {
    expect(describeForecastGapsForSelection([{ ...GAP_ENTRY, isLoading: true }], 'France')).toEqual([]);
  });

  it('says nothing for a model whose request failed — that is an error state, not an empty one', () => {
    expect(describeForecastGapsForSelection([{ ...GAP_ENTRY, isError: true }], 'France')).toEqual([]);
  });

  it('returns one gap per empty model, all checked models empty', () => {
    const gaps = describeForecastGapsForSelection(
      [GAP_ENTRY, { ...GAP_ENTRY, id: 'tso-d1', label: 'ENTSO-E TSO · D+1', color: '#C99A2A' }],
      'Malta',
    );
    expect(gaps.map((g) => g.id)).toEqual(['catboost', 'tso-d1']);
  });

  it('returns nothing when every checked model has rows', () => {
    expect(describeForecastGapsForSelection([{ ...GAP_ENTRY, pointCount: 48 }], 'France')).toEqual([]);
  });
});
