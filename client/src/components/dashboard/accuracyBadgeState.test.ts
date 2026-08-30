import { describe, it, expect } from 'vitest';
import { accuracyBadgeState } from './accuracyBadgeState';

const base = { wape: 3.42, mae: 210, dataPoints: 2976 };

describe('accuracyBadgeState', () => {
  it('reports a measured value when there is a WAPE and enough points', () => {
    expect(accuracyBadgeState(base)).toEqual({
      kind: 'measured', wape: 3.42, dataPoints: 2976,
    });
  });

  it('is absent when the forecast type is not in the payload at all', () => {
    expect(accuracyBadgeState(undefined)).toEqual({ kind: 'absent' });
  });

  it('is not measurable when no points were paired', () => {
    expect(accuracyBadgeState({ wape: null, mae: null, dataPoints: 0 }))
      .toEqual({ kind: 'not_measurable', reason: 'no_data' });
  });

  it('is WITHHELD, not not-measurable, when points paired but no error is publishable', () => {
    // ABL-277: a divergent basis (NL) pairs points and returns null measures.
    // dataPoints > 0 with a null mae is the signature. Reporting this as
    // "not measurable" would tell an analyst the data was thin, when the
    // comparison is invalid by definition.
    expect(accuracyBadgeState({ wape: null, mae: null, dataPoints: 720 }))
      .toEqual({ kind: 'withheld' });
  });

  it('is not measurable when points paired and mae exists but actuals summed to zero', () => {
    expect(accuracyBadgeState({ wape: null, mae: 0, dataPoints: 720 }))
      .toEqual({ kind: 'not_measurable', reason: 'no_magnitude' });
  });

  it('is not measurable, never measured, when wape is missing entirely', () => {
    // undefined, not null: a server built before this field existed omits the
    // key rather than sending null, and the client can deploy ahead of the
    // server. `=== null` would miss this and fall through to `measured`,
    // where AccuracyBadge calls `.toFixed(2)` on undefined and throws.
    expect(accuracyBadgeState({ wape: undefined, mae: 210, dataPoints: 720 }))
      .toEqual({ kind: 'not_measurable', reason: 'no_magnitude' });
  });

  it('refuses to publish a number over too few points', () => {
    expect(accuracyBadgeState({ wape: 3.42, mae: 210, dataPoints: 4 }))
      .toEqual({ kind: 'not_measurable', reason: 'no_data' });
  });

  it('honours a caller-supplied minimum', () => {
    expect(accuracyBadgeState({ wape: 3.42, mae: 210, dataPoints: 4 }, 4))
      .toEqual({ kind: 'measured', wape: 3.42, dataPoints: 4 });
  });
});
