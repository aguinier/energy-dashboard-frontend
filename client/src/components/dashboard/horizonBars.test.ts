import { describe, it, expect } from 'vitest';
import { buildHorizonBars } from './horizonBars';

const SUMMARY = {
  load: {
    tso: {
      dayAhead: { mae: 433.91, mape: 5.41, rmse: 522.92, bias: 364.93, dataPoints: 169 },
      weekAhead: { mae: 858.15, mape: 11.67, rmse: 921.09, bias: 858.15, dataPoints: 7 },
    },
    ml: {
      d1: { mae: 463.07, mape: 5.92, rmse: 606.45, bias: -306.25, dataPoints: 169 },
      d2: { mae: 529.89, mape: 6.8, rmse: 701.32, bias: -373.93, dataPoints: 169 },
    },
  },
} as never;

describe('buildHorizonBars', () => {
  it('emits only measured horizons', () => {
    const bars = buildHorizonBars(SUMMARY, 'load');
    expect(bars.map((b) => b.label)).toEqual(['ML D+1', 'ML D+2', 'TSO D+1', 'TSO D+7']);
  });

  it('uses measured mape values verbatim', () => {
    const bars = buildHorizonBars(SUMMARY, 'load');
    expect(bars.find((b) => b.label === 'ML D+2')!.v).toBe(6.8);
  });

  it('never marks a bar extrapolated', () => {
    expect(buildHorizonBars(SUMMARY, 'load').every((b) => !b.extrapolated)).toBe(true);
  });

  it('omits horizons with no samples', () => {
    const sparse = { load: { tso: {}, ml: { d1: { mape: 4.2, dataPoints: 50 } } } } as never;
    expect(buildHorizonBars(sparse, 'load').map((b) => b.label)).toEqual(['ML D+1']);
  });

  it('returns nothing when the summary is absent', () => {
    expect(buildHorizonBars(undefined, 'load')).toEqual([]);
  });
});
