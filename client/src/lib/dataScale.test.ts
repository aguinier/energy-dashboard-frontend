import { describe, it, expect } from 'vitest';
import { lerpHex, rampCleanToDirty, SCALE_CLEAN, SCALE_DIRTY, SCALE_MEDIUM } from './dataScale';

describe('lerpHex', () => {
  it('returns the endpoints exactly at t=0 and t=1', () => {
    expect(lerpHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(lerpHex('#000000', '#ffffff', 1)).toBe('#ffffff');
  });

  it('interpolates each channel independently', () => {
    expect(lerpHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(lerpHex('#ff0000', '#0000ff', 0.5)).toBe('#800080');
  });

  it('always returns 6-digit hex, so withOpacity can append an alpha pair', () => {
    // The old EuropeMap lerp returned `rgb(r,g,b)`, which withOpacity would
    // have silently turned into `rgb(...)ff`.
    for (const t of [0, 0.13, 0.5, 0.87, 1]) {
      expect(lerpHex(SCALE_CLEAN, SCALE_DIRTY, t)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('pads single-digit channels rather than emitting 5-digit hex', () => {
    expect(lerpHex('#000000', '#0f0f0f', 0.5)).toBe('#080808');
  });

  it('clamps t outside 0..1', () => {
    expect(lerpHex('#000000', '#ffffff', -3)).toBe('#000000');
    expect(lerpHex('#000000', '#ffffff', 4)).toBe('#ffffff');
  });
});

describe('rampCleanToDirty', () => {
  it('hits the three named stops', () => {
    expect(rampCleanToDirty(0)).toBe(SCALE_CLEAN.toLowerCase());
    expect(rampCleanToDirty(0.5)).toBe(SCALE_MEDIUM.toLowerCase());
    expect(rampCleanToDirty(1)).toBe(SCALE_DIRTY.toLowerCase());
  });

  it('is monotonic in lightness, so the ramp still orders in greyscale', () => {
    const luminance = (hex: string) => {
      const v = parseInt(hex.slice(1), 16);
      return 0.2126 * ((v >> 16) & 0xff) + 0.7152 * ((v >> 8) & 0xff) + 0.0722 * (v & 0xff);
    };
    // clean -> medium brightens, medium -> dirty darkens; the point is that the
    // two ends are far apart in luminance, not that the ramp is monotonic.
    expect(Math.abs(luminance(rampCleanToDirty(0)) - luminance(rampCleanToDirty(1)))).toBeGreaterThan(10);
  });

  it('clamps out-of-range t instead of producing garbage hex', () => {
    expect(rampCleanToDirty(-1)).toBe(SCALE_CLEAN.toLowerCase());
    expect(rampCleanToDirty(9)).toBe(SCALE_DIRTY.toLowerCase());
  });

  it('never emits red or green as the extremes', () => {
    // The scale exists specifically to avoid the red/green pair. Guard the
    // constants so a future "tidy-up" cannot quietly reintroduce it.
    expect(SCALE_CLEAN).toBe('#2C8A6B');
    expect(SCALE_DIRTY).toBe('#8E3D2C');
  });
});
