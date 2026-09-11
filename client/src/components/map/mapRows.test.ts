import { describe, expect, it } from 'vitest';
import { indexMapRows } from './mapRows';
import { coreCaptureStalledNotice, endedSeriesNotice, formatEndedDate } from '@/lib/endedSeriesNotice';
import type { MapDataPoint } from '@/types';

const FR: MapDataPoint = {
  country_code: 'FR',
  country_name: 'France',
  value: 51234,
  timestamp: '2026-09-10T08:00:00Z',
};
// IE and PT as prod served them on 2026-09-10, once the server applied the
// ABL-719 coverage rule: no number, and the instant that explains why.
const IE: MapDataPoint = {
  country_code: 'IE',
  country_name: 'Ireland',
  value: null,
  timestamp: '2026-08-30T22:30:00Z',
  coverage: 'ended',
};
const PT: MapDataPoint = {
  country_code: 'PT',
  country_name: 'Portugal',
  value: null,
  timestamp: '2026-09-04T21:00:00Z',
  coverage: 'ended',
};

describe('indexMapRows', () => {
  it('keeps a withheld country off the colour scale entirely', () => {
    const { ranked, min, max } = indexMapRows([FR, IE, PT], 'entsoe');
    expect([...ranked.keys()]).toEqual(['FR']);
    expect(min).toBe(51234);
    expect(max).toBe(51234);
  });

  it('never lets a withheld value reach the scale as a zero', () => {
    const { min, max } = indexMapRows([FR, IE], 'entsoe');
    expect(min).not.toBe(0);
    expect(max).not.toBe(0);
  });

  it('explains each withheld country with its own last publication', () => {
    const { endedNotices } = indexMapRows([FR, IE, PT], 'entsoe');
    expect(endedNotices.get('IE')).toBe(endedSeriesNotice('2026-08-30T22:30:00Z'));
    expect(endedNotices.get('PT')).toBe(endedSeriesNotice('2026-09-04T21:00:00Z'));
    expect(endedNotices.get('IE')).not.toBe(endedNotices.get('PT'));
    expect(endedNotices.has('FR')).toBe(false);
  });

  it('names no cause even when every country ends at the same instant', () => {
    // ABL-763. An ingest stall across the portfolio (the ABL-630 shape) hatches
    // every country at once. The map cannot tell that from a real upstream
    // stop, so no hatched country may say where the stop happened.
    const STALLED_AT = '2026-08-30T21:00:00Z';
    const stall = [
      ['FR', 'France'],
      ['DE', 'Germany'],
      ['ES', 'Spain'],
      ['IE', 'Ireland'],
    ].map(
      ([country_code, country_name]): MapDataPoint => ({
        country_code,
        country_name,
        value: null,
        timestamp: STALLED_AT,
        coverage: 'ended',
      }),
    );
    const { ranked, endedNotices } = indexMapRows(stall, 'entsoe');
    expect(ranked.size).toBe(0);
    expect(endedNotices.size).toBe(4);
    for (const notice of endedNotices.values()) {
      expect(notice).not.toContain('upstream');
      expect(notice).not.toContain('not here');
    }
  });

  it('separates an explained blank from a country we simply never held', () => {
    // GB is not in the payload at all — the SQL produced no group for it.
    const { ranked, endedNotices } = indexMapRows([FR, IE], 'entsoe');
    expect(ranked.has('GB')).toBe(false);
    expect(endedNotices.has('GB')).toBe(false);
    // IE is hatched too, but it is the one we can account for.
    expect(ranked.has('IE')).toBe(false);
    expect(endedNotices.has('IE')).toBe(true);
  });

  it('claims nothing for a withheld row that carries no instant', () => {
    const { ranked, endedNotices } = indexMapRows(
      [{ country_code: 'XX', country_name: 'Nowhere', value: null, coverage: 'ended' }],
      'entsoe',
    );
    expect(ranked.size).toBe(0);
    expect(endedNotices.size).toBe(0);
  });

  it('drops a non-finite value rather than colouring it', () => {
    const { ranked, endedNotices } = indexMapRows(
      [{ country_code: 'ZZ', country_name: 'Broken', value: Number.NaN }],
      'entsoe',
    );
    expect(ranked.size).toBe(0);
    expect(endedNotices.size).toBe(0);
  });

  it('handles a payload of nothing but withheld countries', () => {
    const { ranked, endedNotices, min, max } = indexMapRows([IE, PT], 'entsoe');
    expect(ranked.size).toBe(0);
    expect(endedNotices.size).toBe(2);
    // The pre-existing empty-map default, so dataColor never sees ±Infinity.
    expect([min, max]).toEqual([0, 100]);
  });

  it('tolerates a missing payload', () => {
    expect(indexMapRows(undefined, 'entsoe').ranked.size).toBe(0);
    expect(indexMapRows(null, 'jao_core').endedNotices.size).toBe(0);
  });

  it('ignores a null value with no coverage verdict', () => {
    // Wire-compatibility: a client running against a pre-ABL-719 server, or a
    // metric that nulls for some other reason, gets the bare no-data hatch
    // rather than a sentence claiming the series stopped.
    const { endedNotices } = indexMapRows(
      [{ country_code: 'AL', country_name: 'Albania', value: null, timestamp: '2026-06-23T21:00:00Z' }],
      'entsoe',
    );
    expect(endedNotices.size).toBe(0);
  });

  it('takes the scale bounds from the ranked countries only', () => {
    const { min, max } = indexMapRows(
      [
        { country_code: 'FR', country_name: 'France', value: 51234 },
        { country_code: 'BE', country_name: 'Belgium', value: 9000 },
        IE,
      ],
      'entsoe',
    );
    expect(min).toBe(9000);
    expect(max).toBe(51234);
  });
});

// ABL-761. The Core view's rows come from our own JAO capture, which can stall
// silently — and because JAO publishes all 12 hubs in lockstep, a Core zone
// gone `ended` most plausibly means that capture stopped — the very failure the
// ABL-727 coverage rule exists to surface. Its sentence must not blame upstream
// for that, nor borrow the all-coupled view's, which describes another figure.
describe('indexMapRows on the Core view', () => {
  // A whole-region stall as `/core-net-position/map` serves it: every Core
  // zone withheld at the same instant, the end of JAO's last published day.
  const STALLED_AT = '2026-09-07T21:45:00Z';
  const coreEnded = (country_code: string, country_name: string): MapDataPoint => ({
    country_code,
    country_name,
    value: null,
    timestamp: STALLED_AT,
    coverage: 'ended',
  });
  const CORE_STALL = [coreEnded('FR', 'France'), coreEnded('DE', 'Germany'), coreEnded('LU', 'Luxembourg')];

  it('does not blame upstream for a stalled Core zone', () => {
    const { endedNotices } = indexMapRows(CORE_STALL, 'jao_core');
    expect(endedNotices.size).toBe(3);
    for (const notice of endedNotices.values()) {
      expect(notice).not.toContain('upstream');
      expect(notice).not.toContain('not here');
      expect(notice).not.toBe(endedSeriesNotice(STALLED_AT));
    }
  });

  it('still dates the stall, in the same UTC form as the all-coupled view', () => {
    const { endedNotices } = indexMapRows(CORE_STALL, 'jao_core');
    expect(endedNotices.get('FR')).toBe(coreCaptureStalledNotice(STALLED_AT));
    expect(endedNotices.get('FR')).toContain(formatEndedDate(new Date(STALLED_AT)));
    // LU shares DE's DE_LU hub, so it is withheld with it and says the same.
    expect(endedNotices.get('LU')).toBe(endedNotices.get('DE'));
  });

  it('keeps a stalled Core zone off the scale, as the all-coupled view does', () => {
    const { ranked, min, max } = indexMapRows(
      [{ country_code: 'PL', country_name: 'Poland', value: -812.4 }, ...CORE_STALL],
      'jao_core',
    );
    expect([...ranked.keys()]).toEqual(['PL']);
    expect([min, max]).toEqual([-812.4, -812.4]);
  });

  it('claims nothing for a Core row that carries no instant', () => {
    const { endedNotices } = indexMapRows(
      [{ country_code: 'FR', country_name: 'France', value: null, coverage: 'ended' }],
      'jao_core',
    );
    expect(endedNotices.size).toBe(0);
  });

  it('gives the all-coupled view its own sentence for the same row', () => {
    // Same row, other source: the choice of sentence is the source's, not the row's.
    const row = coreEnded('FR', 'France');
    expect(indexMapRows([row], 'entsoe').endedNotices.get('FR')).toBe(endedSeriesNotice(STALLED_AT));
  });
});
