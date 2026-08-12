import { describe, it, expect } from 'vitest';
import { adaptCoreNetPositionSeries } from './coreNetPositionSeries';
import type { CoreNetPositionResponse } from '@/types';

function response(
  actual: Array<{ timestamp: string; net_position_mw: number }>,
): CoreNetPositionResponse {
  return {
    actual,
    meta: {
      country_code: 'FR',
      bidding_zone: 'FR',
      in_core: true,
      coverage: actual.length ? 'served' : 'no_data',
      last_seen: actual.length ? actual[actual.length - 1].timestamp : null,
    },
  };
}

/**
 * France's four published Core quarters for 2026-08-09 08:00 UTC, fetched
 * live from JAO on 2026-08-12. Mean -368.9 MW. The all-coupled `net_position`
 * row for the same hour is +1,494.575 MW — the sign disagreement ABL-219
 * exists to surface.
 */
const FR_QUARTERS = [
  { timestamp: '2026-08-09T08:00:00', net_position_mw: -114.9 },
  { timestamp: '2026-08-09T08:15:00', net_position_mw: -624.8 },
  { timestamp: '2026-08-09T08:30:00', net_position_mw: 174.8 },
  { timestamp: '2026-08-09T08:45:00', net_position_mw: -910.7 },
];

/** Germany's, same hour. Mean 9,423.875 — its all-coupled value to the digit. */
const DE_QUARTERS = [
  { timestamp: '2026-08-09T08:00:00', net_position_mw: 7594.9 },
  { timestamp: '2026-08-09T08:15:00', net_position_mw: 9583.5 },
  { timestamp: '2026-08-09T08:30:00', net_position_mw: 9676.6 },
  { timestamp: '2026-08-09T08:45:00', net_position_mw: 10840.5 },
];

const NOW = new Date('2026-08-09T12:00:00Z');

describe('adaptCoreNetPositionSeries', () => {
  it('averages the quarter-hours in an hour instead of keeping the last one', () => {
    // The defect this adapter exists to avoid. `adaptNetPositionSeries` writes
    // each point into its hour bin unconditionally, so France's hour would
    // have drawn -910.7 — the last quarter — against a true mean of -368.9.
    const { series } = adaptCoreNetPositionSeries(response(FR_QUARTERS), NOW);
    expect(series).toHaveLength(1);
    expect(series[0].value).toBeCloseTo(-368.9, 6);
  });

  it('keeps France an importer, which sampling one quarter would not', () => {
    const { series } = adaptCoreNetPositionSeries(response(FR_QUARTERS), NOW);
    expect(series[0].value!).toBeLessThan(0);
    // The 08:30 quarter alone is +174.8 — an exporter. Averaging is what makes
    // the sign on screen the sign of the hour.
    expect(FR_QUARTERS.some((q) => q.net_position_mw > 0)).toBe(true);
  });

  it('reproduces DE-LU exactly, matching its all-coupled hourly value', () => {
    // 9,423.875 in both tables. Two identical quantities must not be made to
    // look like they disagree by a gigawatt.
    const { series } = adaptCoreNetPositionSeries(response(DE_QUARTERS), NOW);
    expect(series[0].value).toBeCloseTo(9423.875, 6);
  });

  it('reports how many intervals the densest hour was built from', () => {
    expect(adaptCoreNetPositionSeries(response(FR_QUARTERS), NOW).maxIntervalsPerHour).toBe(4);
    // Already-hourly rows: the tab must not claim an average that was not one.
    expect(
      adaptCoreNetPositionSeries(
        response([{ timestamp: '2026-08-09T08:00:00', net_position_mw: 500 }]),
        NOW,
      ).maxIntervalsPerHour,
    ).toBe(1);
  });

  it('averages a partial hour over what was published, never over four', () => {
    const { series } = adaptCoreNetPositionSeries(
      response(FR_QUARTERS.slice(0, 2)),
      NOW,
    );
    // (-114.9 + -624.8) / 2, not / 4 — dividing by the nominal interval count
    // would halve a real value toward zero.
    expect(series[0].value).toBeCloseTo(-369.85, 6);
  });

  it('leaves an hour with no published interval null rather than bridging it', () => {
    const { series } = adaptCoreNetPositionSeries(
      response([
        { timestamp: '2026-08-09T08:00:00', net_position_mw: 100 },
        { timestamp: '2026-08-09T11:00:00', net_position_mw: 400 },
      ]),
      NOW,
    );
    expect(series).toHaveLength(4);
    expect(series.map((p) => p.value)).toEqual([100, null, null, 400]);
  });

  it('marks points past `now` as future', () => {
    // `now` is built the same naive way the API's timestamps are, so this
    // assertion holds in any machine timezone — see the parsing test below
    // for why that is the deliberate choice and not an oversight.
    const { series, nowIndex } = adaptCoreNetPositionSeries(
      response([
        { timestamp: '2026-08-09T11:00:00', net_position_mw: 1 },
        { timestamp: '2026-08-09T13:00:00', net_position_mw: 2 },
      ]),
      new Date('2026-08-09T12:00:00'),
    );
    expect(series.map((p) => p.future)).toEqual([false, false, true]);
    expect(nowIndex).toBe(1);
  });

  it('bins timestamps exactly the way chartAdapters does, local-naive and all', () => {
    // The API returns a naive `2026-08-09T08:00:00` (no `Z`), which V8 parses
    // as LOCAL time. `chartAdapters.hourKey` — behind the all-coupled series
    // on this same tab — does the identical thing, and matching it is the
    // point: parsing correctly HERE only would slide the Core line against
    // the all-coupled line by the viewer's UTC offset every time the toggle
    // was flipped, which reads as the Core data being time-shifted. The
    // underlying naive parsing is a pre-existing, chart-wide issue and is not
    // ABL-234's to change unilaterally.
    const { series } = adaptCoreNetPositionSeries(
      response([{ timestamp: '2026-08-09T08:00:00', net_position_mw: 42 }]),
      NOW,
    );
    expect(new Date(series[0].ts).getTime()).toBe(new Date('2026-08-09T08:00:00').getTime());
  });

  it('returns an empty series rather than throwing on no data', () => {
    expect(adaptCoreNetPositionSeries(undefined, NOW)).toEqual({
      series: [],
      nowIndex: 0,
      maxIntervalsPerHour: 0,
    });
    expect(adaptCoreNetPositionSeries(response([]), NOW).series).toEqual([]);
  });

  it('skips a non-finite value instead of poisoning the hour average', () => {
    const { series } = adaptCoreNetPositionSeries(
      response([
        { timestamp: '2026-08-09T08:00:00', net_position_mw: 100 },
        { timestamp: '2026-08-09T08:15:00', net_position_mw: NaN },
        { timestamp: '2026-08-09T08:30:00', net_position_mw: 200 },
      ]),
      NOW,
    );
    expect(series[0].value).toBe(150);
  });

  it('does not withhold a genuinely near-zero hour', () => {
    // Unlike net_position's degenerate-zero guard, which is sized from a
    // measured ENTSO-E fabrication that this path structurally cannot have.
    const { series } = adaptCoreNetPositionSeries(
      response([{ timestamp: '2026-08-09T08:00:00', net_position_mw: 0.04 }]),
      NOW,
    );
    expect(series[0].value).toBe(0.04);
  });
});
