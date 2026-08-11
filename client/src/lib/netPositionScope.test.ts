import { describe, it, expect } from 'vitest';
import {
  isCoreCcrCountry,
  netPositionTabDisclosure,
  NET_POSITION_MAP_DISCLOSURE,
} from './netPositionScope';

describe('isCoreCcrCountry', () => {
  it('is true for a plain Core zone', () => {
    // FR is the divergent case measured in ABL-219 — Core and published net
    // position disagree in sign there, unlike DE.
    expect(isCoreCcrCountry('FR')).toBe(true);
  });

  it('is true for both country codes sharing the DE_LU Core hub', () => {
    expect(isCoreCcrCountry('DE')).toBe(true);
    expect(isCoreCcrCountry('LU')).toBe(true);
  });

  it('is false for a zone this dashboard covers that is outside Core CCR', () => {
    // GB is not even SDAC-coupled any more; GR is SDAC-coupled but not Core.
    expect(isCoreCcrCountry('GB')).toBe(false);
    expect(isCoreCcrCountry('GR')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isCoreCcrCountry('fr')).toBe(true);
  });
});

describe('netPositionTabDisclosure', () => {
  it('states the coupled-border scope for every country', () => {
    const note = netPositionTabDisclosure('GR');
    expect(note).toContain('every ENTSO-E-coupled border');
    expect(note).toContain('not just the Core region');
  });

  it('does not label the distinction AC vs DC', () => {
    // Germany's Core figure already nets in its HVDC links, and France's
    // excludes its AC borders with ES/IT — an AC/DC label is wrong for both.
    const note = netPositionTabDisclosure('FR');
    expect(note.toUpperCase()).not.toContain('AC ');
    expect(note.toUpperCase()).not.toContain(' DC');
  });

  it('adds the Core-figure caveat only for a Core CCR zone', () => {
    const fr = netPositionTabDisclosure('FR');
    expect(fr).toContain('Core flow-based net position also exists');
    expect(fr).toContain('including in sign');

    const gr = netPositionTabDisclosure('GR');
    expect(gr).not.toContain('Core flow-based net position also exists');
  });

  it('applies the caveat to both DE and LU, the shared Core hub', () => {
    expect(netPositionTabDisclosure('DE')).toContain('Core flow-based net position');
    expect(netPositionTabDisclosure('LU')).toContain('Core flow-based net position');
  });

  it('is case-insensitive on the country code', () => {
    expect(netPositionTabDisclosure('fr')).toContain('Core flow-based net position');
  });
});

describe('NET_POSITION_MAP_DISCLOSURE', () => {
  it('names both the included scope and the Core exception as a class', () => {
    expect(NET_POSITION_MAP_DISCLOSURE).toContain('not just the Core region');
    expect(NET_POSITION_MAP_DISCLOSURE).toContain('12 Core zones');
    expect(NET_POSITION_MAP_DISCLOSURE.toLowerCase()).toContain('disagree');
  });

  it('does not label the distinction AC vs DC', () => {
    expect(NET_POSITION_MAP_DISCLOSURE.toUpperCase()).not.toContain('AC ');
    expect(NET_POSITION_MAP_DISCLOSURE.toUpperCase()).not.toContain(' DC');
  });
});
