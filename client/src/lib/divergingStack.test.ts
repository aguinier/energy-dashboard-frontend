import { describe, it, expect } from 'vitest';
import { divergingStack, stackExtent } from './divergingStack';

type K = 'solar' | 'nuclear' | 'fossil' | 'pumped';
const ORDER: K[] = ['solar', 'nuclear', 'fossil', 'pumped'];

describe('divergingStack', () => {
  it('stacks an all-positive point cumulatively upward from zero', () => {
    expect(divergingStack(ORDER, { solar: 100, nuclear: 300, fossil: 400, pumped: 50 })).toEqual([
      { key: 'solar', y0: 0, y1: 100 },
      { key: 'nuclear', y0: 100, y1: 400 },
      { key: 'fossil', y0: 400, y1: 800 },
      { key: 'pumped', y0: 800, y1: 850 },
    ]);
  });

  it('stacks negatives downward from zero without moving the positive bands', () => {
    // FR's live shape: pumping at -300 MW with a consumption-only fossil type
    // at -50. Nuclear must sit on the same baseline whether or not the country
    // happens to be pumping — a plain cumulative stack would slide it down by
    // 350 MW and the top of the stack would stop meaning "total output".
    expect(divergingStack(ORDER, { solar: 0, nuclear: 700, fossil: -50, pumped: -300 })).toEqual([
      { key: 'solar', y0: 0, y1: 0 },
      { key: 'nuclear', y0: 0, y1: 700 },
      { key: 'fossil', y0: 0, y1: -50 },
      { key: 'pumped', y0: -50, y1: -350 },
    ]);
  });

  it('never clamps a negative away', () => {
    const [band] = divergingStack(['pumped'], { pumped: -300 });

    expect(band.y1 - band.y0).toBe(-300);
  });

  it('keeps every band exactly its own value wide, whatever the mix of signs', () => {
    const values: Record<K, number> = { solar: 12, nuclear: -4, fossil: 0, pumped: 7 };

    for (const band of divergingStack(ORDER, values)) {
      expect(band.y1 - band.y0).toBeCloseTo(values[band.key], 10);
    }
  });

  it('is continuous as a member crosses zero', () => {
    // Just below and just above the crossing, every other band has to be in
    // essentially the same place — otherwise layers jump around as pumped
    // storage swings between charging and discharging.
    const below = divergingStack(ORDER, { solar: 100, nuclear: 300, pumped: -0.001 });
    const above = divergingStack(ORDER, { solar: 100, nuclear: 300, pumped: 0.001 });

    for (const key of ['solar', 'nuclear'] as const) {
      const b = below.find((x) => x.key === key)!;
      const a = above.find((x) => x.key === key)!;
      expect(a.y0).toBeCloseTo(b.y0, 6);
      expect(a.y1).toBeCloseTo(b.y1, 6);
    }
  });

  it('gives a null a zero-width band at the current baseline', () => {
    const bands = divergingStack(ORDER, { solar: 100, nuclear: null, fossil: 400 });

    expect(bands[1]).toEqual({ key: 'nuclear', y0: 100, y1: 100 });
    // ...and the band after it is unaffected, so a hole does not shift the
    // rest of the stack.
    expect(bands[2]).toEqual({ key: 'fossil', y0: 100, y1: 500 });
  });
});

describe('stackExtent', () => {
  it('leaves the axis at zero when nothing is negative', () => {
    const points = [
      { values: { solar: 100, nuclear: 300 } },
      { values: { solar: 150, nuclear: 300 } },
    ];

    expect(stackExtent(points, ORDER)).toEqual({ min: 0, max: 450 });
  });

  it('extends below zero by the deepest negative total', () => {
    const points = [
      { values: { solar: 100, nuclear: 300, pumped: -200 } },
      { values: { solar: 100, nuclear: 300, pumped: -500 } },
    ];

    expect(stackExtent(points, ORDER)).toEqual({ min: -500, max: 400 });
  });

  it('measures over the drawn keys only', () => {
    const points = [{ values: { solar: 100, nuclear: 300, pumped: -200 } }];

    expect(stackExtent(points, ['solar'])).toEqual({ min: 0, max: 100 });
    expect(stackExtent(points, ORDER)).toEqual({ min: -200, max: 400 });
  });

  it('is a degenerate zero-height domain for an empty series', () => {
    expect(stackExtent([], ORDER)).toEqual({ min: 0, max: 0 });
  });
});
