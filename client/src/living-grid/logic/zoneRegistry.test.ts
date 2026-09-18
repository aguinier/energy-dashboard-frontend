import { describe, it, expect } from 'vitest';
import { availableZones, basisLabel, ZONE_BY_CODE, ZONES, zoneAvailability } from './zoneRegistry';
import { emptyMix, makeDay, series, zone } from './testFixture';

describe('the registry', () => {
  it("holds the design's 28 zones, each with a unique code", () => {
    expect(ZONES).toHaveLength(28);
    expect(new Set(ZONES.map((z) => z.code)).size).toBe(28);
  });

  it('indexes them by code', () => {
    expect(ZONE_BY_CODE.DE.name).toBe('Germany');
    expect(ZONE_BY_CODE.LU.name).toBe('Luxembourg');
  });
});

describe('zoneAvailability', () => {
  it('reads a fully-reporting zone as full', () => {
    const day = makeDay();
    const a = zoneAvailability('DE', day.zones.DE, day.meta.sharedZones);

    expect(a).toMatchObject({ hasLoad: true, hasPrice: true, hasNet: true, hasMix: true, basis: 'full' });
  });

  it('reads a zone missing a stream as partial', () => {
    const day = makeDay();
    const a = zoneAvailability('IT', day.zones.IT, day.meta.sharedZones);

    expect(a.hasNet).toBe(false);
    expect(a.hasLoad).toBe(true);
    expect(a.basis).toBe('partial');
  });

  it('reads a silent zone as none', () => {
    expect(zoneAvailability('PT', zone()).basis).toBe('none');
  });

  it('reads an absent zone as none rather than throwing', () => {
    expect(zoneAvailability('XX', undefined).basis).toBe('none');
  });

  it('does not mistake a series of measured zeros for missing data', () => {
    // A zone genuinely generating nothing still has data, and the panel must
    // not tell the reader otherwise.
    const mix = emptyMix();
    mix.solar = series(() => 0);
    const a = zoneAvailability('BE', zone({ mix }));

    expect(a.hasMix).toBe(true);
    expect(a.basis).toBe('partial');
  });

  it('carries the bidding zone a shared series comes from', () => {
    const day = makeDay();

    expect(zoneAvailability('LU', day.zones.DE, day.meta.sharedZones).sharedWith).toBe('DE_LU');
    expect(zoneAvailability('DE', day.zones.DE, day.meta.sharedZones).sharedWith).toBeNull();
  });
});

describe('availableZones', () => {
  it('keeps only the registry zones the payload has data for', () => {
    expect(availableZones(makeDay()).map((z) => z.code)).toEqual(['DE', 'FR', 'IT']);
  });

  it('is empty before the payload arrives', () => {
    expect(availableZones(undefined)).toEqual([]);
  });
});

describe('basisLabel', () => {
  it("says what the data is rather than carrying the prototype's DEMO pill", () => {
    // The handoff asks for the DEMO badge to stay until real forecasts are
    // wired. They are, so the pill reports coverage instead — and still says
    // so plainly when a zone has nothing.
    expect(basisLabel(zoneAvailability('PT', zone()))).toBe('NO DATA');
    expect(basisLabel(zoneAvailability('DE', makeDay().zones.DE))).toBe('LIVE DATA');
    expect(basisLabel(zoneAvailability('IT', makeDay().zones.IT))).toBe('PARTIAL DATA');
  });
});
