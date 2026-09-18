import { describe, it, expect } from 'vitest';
import { chipText } from './mapChips';
import { signedGw } from './format';

describe('chipText', () => {
  it('prints a price the way the map printed it before', () => {
    // `€${Math.round(price)}` — the exact expression buildMapAttrs used.
    expect(chipText('euro', 57)).toBe('€57');
    expect(chipText('euro', 56.6)).toBe('€57');
    expect(chipText('euro', 0)).toBe('€0');
    expect(chipText('euro', -12.4)).toBe('€-12');
  });

  it('prints a generation total the way the map printed it before', () => {
    expect(chipText('gw', 35000)).toBe('35.0 GW');
    expect(chipText('gw', 12340)).toBe('12.3 GW');
  });

  it('prints a net position through the one signed formatter', () => {
    expect(chipText('signedGw', 2000)).toBe(signedGw(2000));
    expect(chipText('signedGw', 2000)).toBe('+2.0');
    expect(chipText('signedGw', -1000)).toBe('−1.0');
  });

  it('keeps the U+2212 minus, not a hyphen', () => {
    // Plex Mono gives U+2212 the same width as the plus; a hyphen makes a
    // column of net positions jitter as values cross zero.
    expect(chipText('signedGw', -1000).charCodeAt(0)).toBe(0x2212);
  });

  it('reads a value mid-tween without complaint', () => {
    // The whole reason this takes a number: the map formats whatever the tween
    // is currently showing, not just whole-hour values.
    expect(chipText('signedGw', 1500)).toBe('+1.5');
    expect(chipText('gw', 12345.6)).toBe('12.3 GW');
    expect(chipText('euro', 56.5)).toBe('€57');
  });

  it('draws nothing for a value that is not a number', () => {
    expect(chipText('signedGw', NaN)).toBe('');
    expect(chipText('euro', Infinity)).toBe('');
  });
});
