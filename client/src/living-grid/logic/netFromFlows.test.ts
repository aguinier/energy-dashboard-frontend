import { describe, it, expect } from 'vitest';
import { basisOf, netFromFlows, netSeriesFromFlows, resolveNetSeries } from './netFromFlows';
import { makeDay, series } from './testFixture';

const FLOWS = {
  'DE-FR': series(() => 1_500),
  'CH-DE': series(() => 400),
  'DE-PL': series((h) => (h === 3 ? null : -200)),
};

describe('netFromFlows', () => {
  it('signs each border by which side the zone is on', () => {
    // DE exports 1500 to FR, imports 400 from CH, and DE-PL is negative so
    // Poland is exporting 200 into Germany.
    expect(netFromFlows(FLOWS, 'DE', 12)).toBe(1_500 - 400 - 200);
  });

  it('gives the mirror answer to the zone on the other side', () => {
    expect(netFromFlows(FLOWS, 'FR', 12)).toBe(-1_500);
    expect(netFromFlows(FLOWS, 'CH', 12)).toBe(400);
  });

  it('ignores borders the zone is not on', () => {
    expect(netFromFlows({ 'AT-CH': series(() => 900) }, 'DE', 12)).toBeNull();
  });

  it('returns null when no border has a value for that hour', () => {
    expect(netFromFlows({ 'DE-FR': series(() => null) }, 'DE', 12)).toBeNull();
  });

  it('sums the borders that do report and skips the ones that do not', () => {
    // Hour 3 has no DE-PL reading; the answer is the other two, not a zero for
    // the missing leg.
    expect(netFromFlows(FLOWS, 'DE', 3)).toBe(1_500 - 400);
  });

  it('builds a 24-slot series', () => {
    const s = netSeriesFromFlows(FLOWS, 'DE');

    expect(s).toHaveLength(24);
    expect(s[0]).toBe(900);
  });
});

describe('choosing a basis', () => {
  it('prefers the published day-ahead net position', () => {
    const day = makeDay();

    expect(basisOf(day, 'DE')).toBe('scheduled');
    expect(resolveNetSeries(day, 'DE').series[12]).toBe(2_000);
  });

  it('falls back to flows for a zone that publishes no net position', () => {
    // IT is one of the six zones with no A25 series. Both its borders point
    // inward — CH-IT +900 and FR-IT +600 — so Italy is importing 1500 MW.
    // Note CH is not itself a zone on this map; a border still counts toward
    // the net even when the neighbour is not drawn, or the figure would be
    // short by whatever the map happens to omit.
    const day = makeDay();

    expect(basisOf(day, 'IT')).toBe('derived');
    expect(resolveNetSeries(day, 'IT').series[12]).toBe(-1_500);
  });

  it('reports no basis at all for a zone with neither', () => {
    const day = makeDay();

    expect(basisOf(day, 'PT')).toBe('none');
    expect(resolveNetSeries(day, 'PT').series.every((v) => v === null)).toBe(true);
  });

  it('never presents a derived figure as a scheduled one', () => {
    // The two are different quantities — realized physical flow against a
    // day-ahead commercial schedule — so the basis travels with the numbers.
    const day = makeDay();
    const { basis } = resolveNetSeries(day, 'IT');

    expect(basis).not.toBe('scheduled');
  });

  it('always returns 24 slots, whatever the basis', () => {
    const day = makeDay();
    for (const code of ['DE', 'IT', 'PT']) {
      expect(resolveNetSeries(day, code).series).toHaveLength(24);
    }
  });
});
