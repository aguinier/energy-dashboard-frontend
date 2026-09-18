import { describe, it, expect } from 'vitest';
import { borderKey, netFlows, type FlowRow } from './flowNetting.js';
import { hourSlotIndex } from './hourBuckets.js';

const HOUR_KEYS = ['2026-07-01 00', '2026-07-01 01', '2026-07-01 02'];
const index = hourSlotIndex([...HOUR_KEYS, ...new Array(21).fill(null)]);

const row = (from: string, to: string, hour: number, mw: number | null): FlowRow => ({
  country_from: from,
  country_to: to,
  hourKey: HOUR_KEYS[hour],
  flow_mw: mw,
});

describe('borderKey', () => {
  it('is alphabetical regardless of the direction it is asked about', () => {
    expect(borderKey('DE', 'FR')).toBe('DE-FR');
    expect(borderKey('FR', 'DE')).toBe('DE-FR');
  });
});

describe('netting the two directed legs', () => {
  it('signs the flow against the alphabetical key', () => {
    // + means the FIRST zone in the key exports. Reading direction off
    // anything else is wrong: the key deliberately discards row order.
    const out = netFlows([row('DE', 'FR', 0, 500), row('FR', 'DE', 0, 200)], index);

    expect(out['DE-FR'][0]).toBe(300);
  });

  it('goes negative when the second zone is the exporter', () => {
    const out = netFlows([row('DE', 'FR', 0, 200), row('FR', 'DE', 0, 500)], index);

    expect(out['DE-FR'][0]).toBe(-300);
  });

  it('reports a real zero when the legs cancel', () => {
    // Equal legs are a measured balance, not missing data — the border must
    // read 0, and a consumer must be able to tell that from null.
    const out = netFlows([row('DE', 'FR', 0, 150), row('FR', 'DE', 0, 150)], index);

    expect(out['DE-FR'][0]).toBe(0);
    expect(out['DE-FR'][0]).not.toBeNull();
  });

  it('uses the single leg when only one direction is published', () => {
    const out = netFlows([row('BE', 'FR', 0, 250)], index);

    expect(out['BE-FR'][0]).toBe(250);
  });

  it('leaves an hour null when neither leg exists', () => {
    // A flow that has not been published is not a flow of zero. Every hour
    // after "now" is this case, because these are realized physical flows.
    const out = netFlows([row('DE', 'BE', 0, 900), row('DE', 'BE', 2, 900)], index);

    // Negative because the key is BE-DE and it is DE that is exporting.
    expect(out['BE-DE'][0]).toBe(-900);
    expect(out['BE-DE'][1]).toBeNull();
    expect(out['BE-DE'][2]).toBe(-900);
  });

  it('sums repeated rows for one leg and hour', () => {
    // Some borders are reported per interconnector rather than per zone pair.
    const out = netFlows([row('DE', 'FR', 0, 300), row('DE', 'FR', 0, 200)], index);

    expect(out['DE-FR'][0]).toBe(500);
  });

  it('keeps borders independent of one another', () => {
    const out = netFlows(
      [row('DE', 'FR', 0, 500), row('FR', 'DE', 0, 100), row('BE', 'FR', 0, 250)],
      index,
    );

    expect(Object.keys(out).sort()).toEqual(['BE-FR', 'DE-FR']);
    expect(out['DE-FR'][0]).toBe(400);
    expect(out['BE-FR'][0]).toBe(250);
  });
});

describe('rows that must not reach a series', () => {
  it('skips a null flow rather than counting it as zero', () => {
    const out = netFlows([row('DE', 'FR', 0, null)], index);

    expect(out['DE-FR']).toBeUndefined();
  });

  it('skips an hour outside the day', () => {
    // The window's index prefilter is deliberately wide, so a row just past
    // the last slot can come back and must be dropped, not clamped into it.
    const stray: FlowRow = {
      country_from: 'DE',
      country_to: 'FR',
      hourKey: '2026-07-02 05',
      flow_mw: 500,
    };

    expect(netFlows([stray], index)['DE-FR']).toBeUndefined();
  });

  it('skips a self-referential row', () => {
    expect(netFlows([row('DE', 'DE', 0, 100)], index)['DE-DE']).toBeUndefined();
  });

  it('returns 24 slots for every border it does emit', () => {
    const out = netFlows([row('DE', 'FR', 0, 500)], index);

    expect(out['DE-FR']).toHaveLength(24);
  });
});
