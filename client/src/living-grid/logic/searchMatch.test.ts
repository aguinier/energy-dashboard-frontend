import { describe, it, expect } from 'vitest';
import { matchZone } from './searchMatch';

const AVAILABLE = ['DE', 'FR', 'BE', 'NL', 'IE', 'FI', 'IT'];

describe('matchZone', () => {
  it('waits for two characters before selecting anything', () => {
    expect(matchZone('', AVAILABLE)).toBeNull();
    expect(matchZone('b', AVAILABLE)).toBeNull();
    expect(matchZone('  ', AVAILABLE)).toBeNull();
  });

  it('matches an exact two-letter zone code, case-insensitively', () => {
    expect(matchZone('de', AVAILABLE)).toBe('DE');
    expect(matchZone('DE', AVAILABLE)).toBe('DE');
  });

  it('matches a name prefix', () => {
    expect(matchZone('bel', AVAILABLE)).toBe('BE');
    expect(matchZone('Netherl', AVAILABLE)).toBe('NL');
  });

  it('only matches a prefix, never a substring', () => {
    // "land" appears inside Netherlands, Finland and Ireland. A substring
    // match would move the selection under a half-typed query, which reads as
    // the map glitching rather than as search working.
    expect(matchZone('land', AVAILABLE)).toBeNull();
    expect(matchZone('many', AVAILABLE)).toBeNull();
  });

  it('ignores surrounding whitespace', () => {
    expect(matchZone('  fr  ', AVAILABLE)).toBe('FR');
  });

  it('never selects a zone that has no data today', () => {
    // The registry knows 28 zones; only the ones in the payload are selectable,
    // or the panel would open on a country with nothing in it.
    expect(matchZone('PL', AVAILABLE)).toBeNull();
    expect(matchZone('Poland', AVAILABLE)).toBeNull();
  });

  it('prefers the exact code over a name that starts the same way', () => {
    // "IE" is Ireland's code; "IT" is Italy's. Typing IT must not land on
    // Ireland just because the name search runs over the same list.
    expect(matchZone('IT', AVAILABLE)).toBe('IT');
    expect(matchZone('IE', AVAILABLE)).toBe('IE');
  });

  it('returns null for a query that matches nothing', () => {
    expect(matchZone('zz', AVAILABLE)).toBeNull();
    expect(matchZone('Atlantis', AVAILABLE)).toBeNull();
  });
});
