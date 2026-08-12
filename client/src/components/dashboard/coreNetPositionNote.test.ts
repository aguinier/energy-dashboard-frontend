import { describe, it, expect } from 'vitest';
import { describeCoreCoverage } from './coreNetPositionNote';
import type { CoreNetPositionResponse } from '@/types';

function meta(
  coverage: CoreNetPositionResponse['meta']['coverage'],
  overrides: Partial<CoreNetPositionResponse['meta']> = {},
): CoreNetPositionResponse['meta'] {
  return {
    country_code: 'FR',
    bidding_zone: 'FR',
    in_core: coverage !== 'out_of_core',
    coverage,
    last_seen: null,
    ...overrides,
  };
}

describe('describeCoreCoverage', () => {
  it('says nothing when there is a chart to look at', () => {
    expect(describeCoreCoverage(meta('served'), 'France')).toBeNull();
  });

  it('says nothing before the response arrives', () => {
    expect(describeCoreCoverage(undefined, 'France')).toBeNull();
  });

  it('tells an out-of-Core zone that no such figure exists, not that data is missing', () => {
    const note = describeCoreCoverage(meta('out_of_core'), 'Spain')!;
    expect(note.headline).toContain('Spain');
    expect(note.headline).toContain('outside the Core region');
    expect(note.detail).toContain('No Core figure exists');
    // Spain's all-coupled net position is on file and correct. Calling this a
    // data gap would send a reader hunting an outage that does not exist.
    expect(`${note.headline} ${note.detail}`.toLowerCase()).not.toContain('no data');
    // And it points at the view that does hold a number for this zone.
    expect(note.detail).toContain('All coupled borders');
  });

  it('names the 12 Core zones so the claim is checkable', () => {
    const note = describeCoreCoverage(meta('out_of_core'), 'Spain')!;
    for (const cc of ['AT', 'BE', 'CZ', 'DE-LU', 'FR', 'HR', 'HU', 'NL', 'PL', 'RO', 'SI', 'SK']) {
      expect(note.detail).toContain(cc);
    }
  });

  it('tells a not_captured deployment it is a switch, not an outage', () => {
    const note = describeCoreCoverage(meta('not_captured'), 'France')!;
    expect(note.headline).toContain('captured');
    expect(note.detail).toContain('JAO');
    expect(note.detail).toContain('not an outage');
    // This is the state every deployment is in until the capture is enabled,
    // so it must not read as France having stopped publishing.
    expect(note.headline).not.toContain('France');
  });

  it('distinguishes an empty window from both of the above', () => {
    const note = describeCoreCoverage(meta('no_data'), 'Poland')!;
    expect(note.headline).toContain('Poland');
    expect(note.headline).toContain('in this window');
    expect(note.detail).toContain('wider window');
  });

  it('never labels the distinction AC vs DC', () => {
    for (const c of ['out_of_core', 'not_captured', 'no_data'] as const) {
      const note = describeCoreCoverage(meta(c), 'France')!;
      const text = `${note.headline} ${note.detail}`.toUpperCase();
      expect(text).not.toContain('AC ');
      expect(text).not.toContain(' DC');
    }
  });
});
