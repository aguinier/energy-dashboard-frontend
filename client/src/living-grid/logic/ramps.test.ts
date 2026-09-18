import { describe, it, expect } from 'vitest';
import { alpha, EXPORT_RAMP, FUEL_COLORS, IMPORT_RAMP, mix, PRICE_RAMP, sampleRamp } from './ramps';
import { GRID_FUEL_KEYS } from '@/types';

describe('mix', () => {
  it('returns the endpoints unchanged', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
  });

  it('blends the midpoint', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('clamps out-of-range positions', () => {
    expect(mix('#000000', '#ffffff', -5)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 5)).toBe('#ffffff');
  });

  it('always emits a six-digit hex', () => {
    // A channel rounding to a single digit without padding produces '#f0f0f'
    // and the browser silently drops the colour.
    expect(mix('#010203', '#040506', 0.5)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('sampleRamp', () => {
  it('hits the first and last stop at the ends', () => {
    expect(sampleRamp(PRICE_RAMP, 0)).toBe(PRICE_RAMP[0]);
    expect(sampleRamp(PRICE_RAMP, 1)).toBe(PRICE_RAMP[PRICE_RAMP.length - 1]);
  });

  it('lands exactly on an interior stop', () => {
    // Six stops means stop 1 sits at 1/5 along.
    expect(sampleRamp(PRICE_RAMP, 0.2)).toBe(PRICE_RAMP[1]);
  });

  it('clamps rather than running off the ramp', () => {
    expect(sampleRamp(PRICE_RAMP, -1)).toBe(PRICE_RAMP[0]);
    expect(sampleRamp(PRICE_RAMP, 9)).toBe(PRICE_RAMP[PRICE_RAMP.length - 1]);
  });

  it('survives a degenerate ramp', () => {
    expect(sampleRamp(['#2fd3c0'], 0.7)).toBe('#2fd3c0');
    expect(sampleRamp([], 0.5)).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('the palette', () => {
  it('gives every fuel a colour', () => {
    for (const fuel of GRID_FUEL_KEYS) {
      expect(FUEL_COLORS[fuel]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('gives the eight fuels eight distinct colours', () => {
    const colours = GRID_FUEL_KEYS.map((f) => FUEL_COLORS[f].toLowerCase());

    expect(new Set(colours).size).toBe(colours.length);
  });

  it('keeps the export and import ramps disjoint', () => {
    // The two-tone fill is the whole reading of the Balance view: a colour
    // appearing in both ramps would make an importer indistinguishable from
    // an exporter.
    const exp = new Set(EXPORT_RAMP.map((c) => c.toLowerCase()));
    for (const c of IMPORT_RAMP) {
      expect(exp.has(c.toLowerCase())).toBe(false);
    }
  });
});

describe('alpha', () => {
  it('converts a hex to rgba', () => {
    expect(alpha('#2FD3C0', 0.5)).toBe('rgba(47,211,192,0.5)');
  });
});
