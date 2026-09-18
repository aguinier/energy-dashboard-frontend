import { describe, it, expect } from 'vitest';
import {
  buildMapAttrs,
  donutSegments,
  dominantFuel,
  netFillColor,
  netReference,
  netScaleTop,
  priceScale,
} from './mapAttrs';
import { buildPriceBars } from './priceBars';
import { initialState, livingGridReducer, type ViewTab } from './livingGridState';
import { EXPORT_RAMP, FUEL_COLORS, IMPORT_RAMP, PRICE_RAMP, sampleRamp } from './ramps';
import { emptyMix, makeDay, series } from './testFixture';

const stateFor = (tab: ViewTab, hour = 12) =>
  livingGridReducer({ ...initialState(hour) }, { type: 'SET_VIEW', tab });

const parse = (json: string) => JSON.parse(json) as Record<string, unknown>;

describe('netReference', () => {
  it('takes the 70th percentile, not the maximum', () => {
    // A max-based scale lets one outlier flatten the continent into two
    // indistinguishable tones, which is the failure mode this design is
    // explicitly trying to avoid.
    const magnitudes = [100, 200, 300, 400, 500, 600, 700, 800, 900, 100_000];

    expect(netReference(magnitudes)).toBe(800);
  });

  it('falls back to something usable on empty or all-zero input', () => {
    expect(netReference([])).toBe(1);
    expect(netReference([0, 0, 0])).toBe(1);
  });
});

describe('priceScale', () => {
  it('gives a panel bar the same colour its country has on the map', () => {
    // A zone flat all day spans nothing of its own, so scaled against itself
    // it paints as the cheapest hour on the ramp while the map — which scales
    // across zones — paints it the dearest country on the continent.
    const day = makeDay();
    // The map hands the web component a 0–1 scalar per zone and lets it walk
    // the same ramp, so that scalar is what a bar has to agree with.
    const scalars = parse(buildMapAttrs(stateFor('Prices'), day).scalars) as Record<string, number>;
    const scale = priceScale(day, 12);

    const bars = buildPriceBars(day.zones.DE.price, 12, {
      scaleMin: scale.lo,
      scaleMax: scale.hi,
    });

    expect(bars[12].color).toBe(sampleRamp(PRICE_RAMP, scalars.DE));
  });
});

describe('netScaleTop', () => {
  it('is the magnitude at which the ramp stops brightening', () => {
    // What the legend must print. One outlier zone does not set the scale,
    // so the top label has to be the saturation point, not the day's maximum.
    const magnitudes = [500, 700, 900, 1_100, 1_300, 1_500, 1_700, 1_900, 14_000];
    const top = netScaleTop(magnitudes);

    expect(top).toBeLessThan(Math.max(...magnitudes));
    expect(netFillColor(top, netReference(magnitudes))).toBe(
      EXPORT_RAMP[EXPORT_RAMP.length - 1],
    );
  });

  it('is unmoved by a single outlier zone', () => {
    // The whole reason the fill is not max-based: one −14 GW hour in one zone
    // must not flatten the continent, so it must not set the legend either.
    const base = [500, 700, 900, 1_100, 1_300, 1_500, 1_700, 1_900];

    expect(netScaleTop([...base, 99_000])).toBe(netScaleTop([...base, 2_000]));
  });
});

describe('netFillColor', () => {
  it('picks the export ramp for a positive net position', () => {
    expect(EXPORT_RAMP).toContain(netFillColor(1_000, 2_000));
  });

  it('picks the import ramp for a negative one', () => {
    expect(IMPORT_RAMP).toContain(netFillColor(-1_000, 2_000));
  });

  it('saturates rather than running off the end of the ramp', () => {
    expect(netFillColor(999_999, 1_000)).toBe(EXPORT_RAMP[EXPORT_RAMP.length - 1]);
    expect(netFillColor(-999_999, 1_000)).toBe(IMPORT_RAMP[IMPORT_RAMP.length - 1]);
  });

  it('keeps a near-balanced zone at the quiet end', () => {
    expect(netFillColor(1, 5_000)).toBe(EXPORT_RAMP[0]);
  });
});

describe('dominantFuel and donutSegments', () => {
  it('names the largest reported fuel', () => {
    const mix = emptyMix();
    mix.wind = series(() => 100);
    mix.nuclear = series(() => 400);

    expect(dominantFuel(mix, 12)).toBe('nuclear');
  });

  it('returns null when a zone reports nothing', () => {
    expect(dominantFuel(emptyMix(), 12)).toBeNull();
  });

  it('returns null when every reported fuel is zero', () => {
    // A country generating nothing has no dominant fuel; colouring it by the
    // first zero in the list would be an invented answer.
    const mix = emptyMix();
    mix.wind = series(() => 0);
    mix.solar = series(() => 0);

    expect(dominantFuel(mix, 12)).toBeNull();
  });

  it('emits ring segments as [colour, share] summing to one', () => {
    const mix = emptyMix();
    mix.wind = series(() => 300);
    mix.gas = series(() => 100);

    const segments = donutSegments(mix, 12);

    expect(segments).toEqual([
      [FUEL_COLORS.wind, 0.75],
      [FUEL_COLORS.gas, 0.25],
    ]);
  });

  it('drops slivers under half a percent', () => {
    const mix = emptyMix();
    mix.wind = series(() => 1000);
    mix.solar = series(() => 1);

    expect(donutSegments(mix, 12)).toHaveLength(1);
  });

  it('is empty for a zone with nothing to show', () => {
    expect(donutSegments(emptyMix(), 12)).toEqual([]);
  });
});

describe('buildMapAttrs — the dataset', () => {
  it('lists only zones the payload carries, so the rest stay inert', () => {
    const attrs = buildMapAttrs(stateFor('Balance'), makeDay());

    // PT publishes nothing but is still a zone in the payload; the map needs
    // it clickable so the panel can say so.
    expect(Object.keys(parse(attrs.values)).sort()).toEqual(['DE', 'FR', 'IT', 'PT']);
  });

  it('is empty and harmless before any data arrives', () => {
    const attrs = buildMapAttrs(stateFor('Balance'), undefined);

    expect(parse(attrs.values)).toEqual({});
    expect(parse(attrs.flows)).toEqual({});
    expect(parse(attrs.chips)).toEqual({});
  });

  it('drops a border whose other end is not on the map', () => {
    // CH is not in the fixture's zones, so the CH-IT corridor has nowhere to
    // point and must not be drawn.
    const attrs = buildMapAttrs(stateFor('Balance'), makeDay());

    expect(Object.keys(parse(attrs.flows))).toEqual(['DE-FR', 'FR-IT']);
  });

  it('omits a border hour that was never published rather than sending zero', () => {
    const attrs = buildMapAttrs(stateFor('Balance', 5), makeDay());

    expect(parse(attrs.flows)['DE-FR']).toBeUndefined();
  });
});

describe('buildMapAttrs — per view', () => {
  it('fills by net position and chips signed GW on Balance', () => {
    const attrs = buildMapAttrs(stateFor('Balance'), makeDay());

    expect(attrs.fillop).toBe('0.78');
    expect(parse(attrs.chips).DE).toBe('+2.0');
    expect(parse(attrs.chips).FR).toBe('−1.0');
    expect(EXPORT_RAMP).toContain(parse(attrs.fills).DE);
    expect(IMPORT_RAMP).toContain(parse(attrs.fills).FR);
    expect(attrs.scalars).toBe('');
  });

  it('switches to price scalars and euro chips on Prices', () => {
    const attrs = buildMapAttrs(stateFor('Prices'), makeDay());

    expect(attrs.fillop).toBe('0.82');
    expect(attrs['scalar-colors']).toBe(PRICE_RAMP.join(','));
    expect(parse(attrs.chips).DE).toBe('€90');

    // Normalised across the zones on screen: FR cheapest, IT dearest.
    const scalars = parse(attrs.scalars) as Record<string, number>;
    expect(scalars.FR).toBe(0);
    expect(scalars.IT).toBe(1);
    expect(scalars.DE).toBeGreaterThan(0);
    expect(scalars.DE).toBeLessThan(1);
  });

  it('fills by dominant fuel and lightens the map on Generation', () => {
    const attrs = buildMapAttrs(stateFor('Generation'), makeDay());

    // Lighter so the donut rings stay readable on top of the fill.
    expect(attrs.fillop).toBe('0.5');
    expect(parse(attrs.fills).DE).toBe(FUEL_COLORS.wind);
    expect(parse(attrs.fills).FR).toBe(FUEL_COLORS.nuclear);
    expect(parse(attrs.chips).DE).toBe('35.0 GW');
    expect(parse(attrs.donuts).DE).toBeDefined();
  });

  it('keeps Market on the net two-tone but turns the commercial layer on', () => {
    const attrs = buildMapAttrs(stateFor('Market'), makeDay());

    expect(attrs.fillop).toBe('0.78');
    expect(parse(attrs.chips).DE).toBe('+2.0');
  });

  it('gives a zone with no published net position a flow-derived fill', () => {
    // IT publishes no A25 net position; its borders still do, so the map
    // colours it rather than leaving a hole across the Alps.
    const attrs = buildMapAttrs(stateFor('Balance'), makeDay());

    expect(parse(attrs.fills).IT).toBeDefined();
    expect(parse(attrs.chips).IT).toBeDefined();
  });

  it('leaves a silent zone unfilled and unlabelled', () => {
    const attrs = buildMapAttrs(stateFor('Balance'), makeDay());

    expect(parse(attrs.fills).PT).toBeUndefined();
    expect(parse(attrs.chips).PT).toBeUndefined();
  });
});

describe('buildMapAttrs — toggles reach the element', () => {
  it('passes layer and visualization toggles through as strings', () => {
    let state = stateFor('Balance');
    state = livingGridReducer(state, { type: 'TOGGLE_LAYER', key: 'grid' });
    state = livingGridReducer(state, { type: 'TOGGLE_VIZ', key: 'borders' });
    state = livingGridReducer(state, { type: 'TOGGLE_VIZ', key: 'anim' });

    const attrs = buildMapAttrs(state, makeDay());

    expect(attrs.grid).toBe('true');
    expect(attrs.borders).toBe('true');
    // Animation off is expressed as zero speed, not as a stopped element.
    expect(attrs.speed).toBe('0');
  });

  it('drops every chip when values are switched off', () => {
    const state = livingGridReducer(stateFor('Balance'), { type: 'TOGGLE_VIZ', key: 'values' });
    const attrs = buildMapAttrs(state, makeDay());

    expect(parse(attrs.chips)).toEqual({});
  });

  it('carries the active zone and the theme', () => {
    const state = livingGridReducer(stateFor('Balance'), { type: 'PICK_ZONE', code: 'FR' });
    const attrs = buildMapAttrs(state, makeDay());

    expect(attrs.active).toBe('FR');
    expect(attrs.theme).toBe('living');
  });
});
