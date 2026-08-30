import { describe, it, expect } from 'vitest';
import { buildResidualSeries } from './residualSeries';

describe('buildResidualSeries', () => {
  it('pairs on timestamp and signs the residual as actual - forecast', () => {
    expect(buildResidualSeries(
      [{ t: '2026-08-28T00:00', v: 100 }, { t: '2026-08-28T01:00', v: 90 }],
      [{ t: '2026-08-28T00:00', v: 90 },  { t: '2026-08-28T01:00', v: 100 }],
    )).toEqual([
      { t: '2026-08-28T00:00', residual: 10 },
      { t: '2026-08-28T01:00', residual: -10 },
    ]);
  });

  it('drops an interval where the actual is missing rather than treating it as zero', () => {
    expect(buildResidualSeries(
      [{ t: 'a', v: null }, { t: 'b', v: 90 }],
      [{ t: 'a', v: 90 },   { t: 'b', v: 80 }],
    )).toEqual([{ t: 'b', residual: 10 }]);
  });

  it('drops an interval where the forecast is missing', () => {
    expect(buildResidualSeries(
      [{ t: 'a', v: 100 }],
      [{ t: 'a', v: null }],
    )).toEqual([]);
  });

  it('drops an interval the forecast does not cover at all', () => {
    expect(buildResidualSeries(
      [{ t: 'a', v: 100 }, { t: 'b', v: 100 }],
      [{ t: 'a', v: 90 }],
    )).toEqual([{ t: 'a', residual: 10 }]);
  });

  it('returns an empty series rather than throwing when nothing overlaps', () => {
    expect(buildResidualSeries([{ t: 'a', v: 1 }], [{ t: 'z', v: 1 }])).toEqual([]);
  });
});
