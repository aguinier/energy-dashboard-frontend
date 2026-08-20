import { describe, it, expect } from 'vitest';
import {
  describeAutoSelection,
  describeAutoSelectionHint,
  autoSelectionSourceLabel,
} from './autoSelection';
import type { RecommendedModel, RankedModelCandidate } from '@/types';

function candidate(over: Partial<RankedModelCandidate> & { id: string }): RankedModelCandidate {
  return {
    label: over.id,
    source: 'ml',
    wape: 6.75,
    dataPoints: 721,
    hoursCovered: 721,
    excluded: null,
    ...over,
  };
}

/** The measured DE load case: the ENTSO-E day-ahead series beats our catboost. */
function deLoad(over: Partial<RecommendedModel> = {}): RecommendedModel {
  return {
    modelId: 'tso-d1',
    label: 'ENTSO-E TSO · D+1',
    source: 'tso',
    wape: 3.45,
    dataPoints: 721,
    fallback: false,
    windowStart: '2026-07-21T00:00:00.000Z',
    windowEnd: '2026-08-20T00:00:00.000Z',
    windowDays: 30,
    candidates: [
      candidate({ id: 'tso-d1', label: 'ENTSO-E TSO · D+1', source: 'tso', wape: 3.45 }),
      candidate({ id: 'catboost', label: 'able-ml · catboost', wape: 6.75 }),
      candidate({ id: 'xgboost', label: 'able-ml · xgboost', wape: null, dataPoints: 0, excluded: 'no_pairs' }),
    ],
    ...over,
  };
}

describe('describeAutoSelection', () => {
  it('names the model, its source, the country and the window', () => {
    const note = describeAutoSelection(deLoad(), 'Germany')!;

    expect(note).toContain('ENTSO-E TSO · D+1');
    expect(note).toContain('ENTSO-E');
    expect(note).toContain('Germany');
    expect(note).toContain('last 30 days');
  });

  it('says what the winner beat, with both numbers', () => {
    const note = describeAutoSelection(deLoad(), 'Germany')!;

    expect(note).toContain('3.45% WAPE against 6.75% for able-ml · catboost');
  });

  it('says a TSO default is ENTSO-E, so it never reads as ours', () => {
    // The whole point of the Board directive: a default that changed source
    // silently is worse than either source.
    expect(describeAutoSelection(deLoad(), 'Germany')).toContain('ENTSO-E');
    expect(describeAutoSelection(deLoad(), 'Germany')).not.toContain('our own model');
  });

  it('says an ML default is ours', () => {
    const rec = deLoad({
      modelId: 'xgboost',
      label: 'able-ml · xgboost',
      source: 'ml',
      wape: 2.1,
      candidates: [
        candidate({ id: 'xgboost', label: 'able-ml · xgboost', wape: 2.1 }),
        candidate({ id: 'tso-d1', label: 'ENTSO-E TSO · D+1', source: 'tso', wape: 3.45 }),
      ],
    });

    const note = describeAutoSelection(rec, 'France')!;
    expect(note).toContain('our own model');
    expect(note).toContain('2.10% WAPE against 3.45% for ENTSO-E TSO · D+1');
  });

  it('tells the reader they can override it', () => {
    expect(describeAutoSelection(deLoad(), 'Germany')).toContain('override');
  });

  it('says nothing for the no-history fallback', () => {
    // A hand-picked production default is not a measured winner, and must not
    // be announced as one.
    expect(describeAutoSelection(deLoad({ fallback: true, wape: null }), 'Austria')).toBeNull();
  });

  it('says nothing when there is no recommendation at all', () => {
    expect(describeAutoSelection(undefined, 'Germany')).toBeNull();
    expect(describeAutoSelection(null, 'Germany')).toBeNull();
  });

  it('never renders a null WAPE as a number', () => {
    const note = describeAutoSelection(deLoad({ wape: null }), 'Germany');
    expect(note).toBeNull();
  });

  it('does not claim to have beaten a model that was never measured', () => {
    // Only `tso-d1` is ranked; catboost has no pairs at all. Naming it as the
    // runner-up would describe a race that did not happen.
    const rec = deLoad({
      candidates: [
        candidate({ id: 'tso-d1', label: 'ENTSO-E TSO · D+1', source: 'tso', wape: 3.45 }),
        candidate({ id: 'catboost', label: 'able-ml · catboost', wape: null, dataPoints: 0, excluded: 'no_pairs' }),
      ],
    });

    const note = describeAutoSelection(rec, 'Greece')!;
    expect(note).not.toContain('able-ml · catboost');
    expect(note).toContain('the only forecast with a measured track record here');
  });

  it('does not name a ranked runner-up whose WAPE is missing', () => {
    const rec = deLoad({
      candidates: [
        candidate({ id: 'tso-d1', label: 'ENTSO-E TSO · D+1', source: 'tso', wape: 3.45 }),
        candidate({ id: 'catboost', label: 'able-ml · catboost', wape: null }),
      ],
    });

    expect(describeAutoSelection(rec, 'Greece')).toContain('only forecast with a measured');
  });
});

describe('describeAutoSelectionHint', () => {
  it('names the auto-selected model and its measured error', () => {
    expect(describeAutoSelectionHint(deLoad())).toBe(
      'ENTSO-E TSO · D+1 · best measured here (3.45% WAPE, last 30 days)',
    );
  });

  it('describes the server ladder when there is no measurement yet', () => {
    expect(describeAutoSelectionHint(deLoad({ fallback: true, wape: null }))).toBe(
      'Production, then next available — no measured track record here yet',
    );
  });

  it('falls back to the pre-existing wording when nothing was fetched', () => {
    // A server on older code sends no recommendation. The ladder is still
    // exactly what happens, so the old sentence is still the true one.
    expect(describeAutoSelectionHint(undefined)).toBe('Production, then next available');
  });
});

describe('autoSelectionSourceLabel', () => {
  it('badges a TSO default as ENTSO-E and an ML default as ours', () => {
    expect(autoSelectionSourceLabel(deLoad())).toBe('ENTSO-E TSO');
    expect(autoSelectionSourceLabel(deLoad({ source: 'ml' }))).toBe('able-ml');
  });

  it('badges nothing for a fallback or an absent recommendation', () => {
    expect(autoSelectionSourceLabel(deLoad({ fallback: true }))).toBeNull();
    expect(autoSelectionSourceLabel(undefined)).toBeNull();
  });
});
