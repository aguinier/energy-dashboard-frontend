import { describe, expect, it } from 'vitest';
import { indexMapRows } from './mapRows';
import { endedSeriesNotice } from '@/lib/endedSeriesNotice';
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
    const { ranked, min, max } = indexMapRows([FR, IE, PT]);
    expect([...ranked.keys()]).toEqual(['FR']);
    expect(min).toBe(51234);
    expect(max).toBe(51234);
  });

  it('never lets a withheld value reach the scale as a zero', () => {
    const { min, max } = indexMapRows([FR, IE]);
    expect(min).not.toBe(0);
    expect(max).not.toBe(0);
  });

  it('explains each withheld country with its own last publication', () => {
    const { endedNotices } = indexMapRows([FR, IE, PT]);
    expect(endedNotices.get('IE')).toBe(endedSeriesNotice('2026-08-30T22:30:00Z'));
    expect(endedNotices.get('PT')).toBe(endedSeriesNotice('2026-09-04T21:00:00Z'));
    expect(endedNotices.get('IE')).not.toBe(endedNotices.get('PT'));
    expect(endedNotices.has('FR')).toBe(false);
  });

  it('separates an explained blank from a country we simply never held', () => {
    // GB is not in the payload at all — the SQL produced no group for it.
    const { ranked, endedNotices } = indexMapRows([FR, IE]);
    expect(ranked.has('GB')).toBe(false);
    expect(endedNotices.has('GB')).toBe(false);
    // IE is hatched too, but it is the one we can account for.
    expect(ranked.has('IE')).toBe(false);
    expect(endedNotices.has('IE')).toBe(true);
  });

  it('claims nothing for a withheld row that carries no instant', () => {
    const { ranked, endedNotices } = indexMapRows([
      { country_code: 'XX', country_name: 'Nowhere', value: null, coverage: 'ended' },
    ]);
    expect(ranked.size).toBe(0);
    expect(endedNotices.size).toBe(0);
  });

  it('drops a non-finite value rather than colouring it', () => {
    const { ranked, endedNotices } = indexMapRows([
      { country_code: 'ZZ', country_name: 'Broken', value: Number.NaN },
    ]);
    expect(ranked.size).toBe(0);
    expect(endedNotices.size).toBe(0);
  });

  it('handles a payload of nothing but withheld countries', () => {
    const { ranked, endedNotices, min, max } = indexMapRows([IE, PT]);
    expect(ranked.size).toBe(0);
    expect(endedNotices.size).toBe(2);
    // The pre-existing empty-map default, so dataColor never sees ±Infinity.
    expect([min, max]).toEqual([0, 100]);
  });

  it('tolerates a missing payload', () => {
    expect(indexMapRows(undefined).ranked.size).toBe(0);
    expect(indexMapRows(null).endedNotices.size).toBe(0);
  });

  it('ignores a null value with no coverage verdict', () => {
    // Wire-compatibility: a client running against a pre-ABL-719 server, or a
    // metric that nulls for some other reason, gets the bare no-data hatch
    // rather than a sentence claiming the series stopped.
    const { endedNotices } = indexMapRows([
      { country_code: 'AL', country_name: 'Albania', value: null, timestamp: '2026-06-23T21:00:00Z' },
    ]);
    expect(endedNotices.size).toBe(0);
  });

  it('takes the scale bounds from the ranked countries only', () => {
    const { min, max } = indexMapRows([
      { country_code: 'FR', country_name: 'France', value: 51234 },
      { country_code: 'BE', country_name: 'Belgium', value: 9000 },
      IE,
    ]);
    expect(min).toBe(9000);
    expect(max).toBe(51234);
  });
});
