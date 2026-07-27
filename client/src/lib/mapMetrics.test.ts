import { describe, it, expect } from 'vitest';
import { MAP_METRICS } from './constants';

describe('MAP_METRICS', () => {
  it('states the unit that is actually rendered for load', () => {
    expect(MAP_METRICS.find((m) => m.value === 'load')!.unit).toBe('GW');
  });

  it('uses one currency notation for price', () => {
    expect(MAP_METRICS.find((m) => m.value === 'price')!.unit).toBe('€/MWh');
  });

  it('covers every selectable metric exactly once', () => {
    const values = MAP_METRICS.map((m) => m.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual(expect.arrayContaining(['price', 'renewable_pct', 'load', 'net_position']));
  });
});
