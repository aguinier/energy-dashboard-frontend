import { describe, it, expect } from 'vitest';
import { computeGroupGaps, type GapSourcePoint } from './stackedMixGaps';

/** A past point reporting `values`, defaulting every named key to a number so a test only has to state what it means to leave out. */
function past(values: Record<string, number | null>): GapSourcePoint {
  return { future: false, values };
}

function future(values: Record<string, number | null>): GapSourcePoint {
  return { future: true, values };
}

describe('computeGroupGaps', () => {
  it('finds nothing when a group has no interior null', () => {
    const points = [past({ solar: 1 }), past({ solar: 2 }), past({ solar: 3 })];

    expect(computeGroupGaps(points, ['solar'])).toEqual([]);
  });

  it('reports one interior null as a one-point gap, not an interpolated bridge', () => {
    // Mirrors ABL's own verified fact: solar_mw null for part of an otherwise
    // reporting day.
    const points = [past({ solar: 10 }), past({ solar: null }), past({ solar: 30 })];

    expect(computeGroupGaps(points, ['solar'])).toEqual([{ key: 'solar', startIndex: 1, endIndex: 1 }]);
  });

  it('groups a multi-point hole into one gap', () => {
    const points = [
      past({ solar: 10 }),
      past({ solar: null }),
      past({ solar: null }),
      past({ solar: null }),
      past({ solar: 40 }),
    ];

    expect(computeGroupGaps(points, ['solar'])).toEqual([{ key: 'solar', startIndex: 1, endIndex: 3 }]);
  });

  it('does not flag the future as a gap', () => {
    // The tail of a Today window is explicitly null for everything that has
    // not happened yet — that is not a data hole and must never render one.
    const points = [past({ solar: 10 }), past({ solar: 20 }), future({ solar: null }), future({ solar: null })];

    expect(computeGroupGaps(points, ['solar'])).toEqual([]);
  });

  it('closes a gap that runs right up to the start of the future', () => {
    const points = [past({ solar: 10 }), past({ solar: null }), past({ solar: null }), future({ solar: null })];

    expect(computeGroupGaps(points, ['solar'])).toEqual([{ key: 'solar', startIndex: 1, endIndex: 2 }]);
  });

  it('tracks each group independently', () => {
    const points = [
      past({ solar: 10, wind: 5 }),
      past({ solar: null, wind: 6 }),
      past({ solar: 30, wind: null }),
    ];

    expect(computeGroupGaps(points, ['solar', 'wind'])).toEqual([
      { key: 'solar', startIndex: 1, endIndex: 1 },
      { key: 'wind', startIndex: 2, endIndex: 2 },
    ]);
  });

  it('is empty for an empty series', () => {
    expect(computeGroupGaps([], ['solar'])).toEqual([]);
  });
});
