import { describe, it, expect } from 'vitest';
import {
  isCoreCcrCountry,
  isNetPositionScope,
  netPositionHatchLegendLabel,
  netPositionLegendLabel,
  netPositionMapDisclosure,
  netPositionTabDisclosure,
  NET_POSITION_MAP_DISCLOSURE,
  NET_POSITION_SCOPE_OPTIONS,
  NON_CORE_MAP_NOTICE,
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

// ------------------------------------------------------------------ ABL-234
// The scope toggle. Every string below is on screen next to a number whose
// meaning it defines, so the tests are about the CLAIM each one makes, not
// about its prose.

describe('isNetPositionScope', () => {
  it('accepts exactly the two scopes', () => {
    expect(isNetPositionScope('all_coupled')).toBe(true);
    expect(isNetPositionScope('core')).toBe(true);
  });

  it('rejects anything else a persisted blob could carry', () => {
    // The migration coerces on this; a permissive guard would let an
    // unrecognised string reach a legend that names a scope the query did not
    // use.
    for (const bad of ['ac', 'dc', 'Core', '', null, undefined, 0, {}, ['core']]) {
      expect(isNetPositionScope(bad)).toBe(false);
    }
  });
});

describe('netPositionTabDisclosure — Core scope', () => {
  it('describes the Core scope, not the scope the reader just left', () => {
    const note = netPositionTabDisclosure('FR', 'core');
    expect(note).toContain('Core flow-based net position');
    expect(note).toContain('12-zone Core region only');
    // The all-coupled sentence must NOT be the one describing this chart.
    expect(note).not.toContain('This chart is the net position over every');
  });

  it('still names the other figure as a different number, not a correction', () => {
    // ABL-222's property, preserved through the toggle: whichever view is on
    // screen, the sentence says the other one exists and can differ in sign.
    const note = netPositionTabDisclosure('FR', 'core');
    expect(note).toContain('all-coupled-borders net position also exists');
    expect(note).toContain('including in sign');
    expect(note).toContain('this is not that figure');
  });

  it('tells a non-Core zone that no Core figure exists, and where to find one', () => {
    const note = netPositionTabDisclosure('GR', 'core');
    expect(note).toContain('outside the 12-zone Core region');
    expect(note).toContain('All coupled borders');
    // Never "no data" — Greece has a perfectly good all-coupled figure.
    expect(note.toLowerCase()).not.toContain('no data');
  });

  it('treats LU as a Core zone in Core scope too', () => {
    expect(netPositionTabDisclosure('LU', 'core')).toContain('Core flow-based net position');
    expect(netPositionTabDisclosure('lu', 'core')).not.toContain('outside the 12-zone Core region');
  });

  it('does not label either scope AC vs DC', () => {
    for (const cc of ['FR', 'DE', 'GR']) {
      const note = netPositionTabDisclosure(cc, 'core');
      expect(note.toUpperCase()).not.toContain('AC ');
      expect(note.toUpperCase()).not.toContain(' DC');
    }
  });

  it('defaults to the all-coupled wording when no scope is passed', () => {
    // Every pre-ABL-234 call site relies on this.
    expect(netPositionTabDisclosure('FR')).toBe(netPositionTabDisclosure('FR', 'all_coupled'));
  });
});

describe('map copy per scope', () => {
  it('names which borders the legend heading covers, in both scopes', () => {
    expect(netPositionLegendLabel('all_coupled')).toBe('Avg net position, all coupled borders');
    expect(netPositionLegendLabel('core')).toBe('Avg net position, Core region only');
  });

  it('swaps the legend disclosure with the scope', () => {
    expect(netPositionMapDisclosure('all_coupled')).toBe(NET_POSITION_MAP_DISCLOSURE);
    const core = netPositionMapDisclosure('core');
    expect(core).toContain('12-zone Core flow-based region only');
    expect(core).toContain('not applicable');
  });

  it('says "not applicable", never "not measured", for a non-Core country', () => {
    // The distinction the whole hatch treatment hangs on: Spain's absence
    // here is a fact about the Core region, not about our ingest.
    expect(NON_CORE_MAP_NOTICE).toContain('outside the 12-zone Core region');
    expect(NON_CORE_MAP_NOTICE).toContain('not applicable');
    expect(NON_CORE_MAP_NOTICE.toLowerCase()).not.toContain('not measured');
    expect(NON_CORE_MAP_NOTICE.toLowerCase()).not.toContain('no data');
  });

  it('widens the hatch key in Core view, where one texture carries two meanings', () => {
    expect(netPositionHatchLegendLabel('all_coupled')).toBe('no data');
    expect(netPositionHatchLegendLabel('core')).toContain('outside Core region');
  });
});

describe('NET_POSITION_SCOPE_OPTIONS', () => {
  it('offers exactly the two scopes, all-coupled first as the default', () => {
    expect(NET_POSITION_SCOPE_OPTIONS.map((o) => o.value)).toEqual(['all_coupled', 'core']);
  });

  it('labels them by border scope, never by conductor type', () => {
    for (const o of NET_POSITION_SCOPE_OPTIONS) {
      expect(`${o.label} ${o.title}`.toUpperCase()).not.toContain('AC ');
      expect(`${o.label} ${o.title}`.toUpperCase()).not.toContain(' DC');
    }
  });
});
