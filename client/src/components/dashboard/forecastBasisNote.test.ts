import { describe, it, expect } from 'vitest';
import {
  WITHHELD_LEGEND_NOTE,
  withheldForecastNote,
  isWithheld,
  groupWithheldModels,
  joinModelLabels,
} from './forecastBasisNote';

// The sentence the server sends. Written out here rather than imported,
// because the client owning a copy is the thing this module exists to avoid —
// this is a stand-in for whatever arrives on the wire, not the real string.
const NOTE = 'Forecast withheld. This is a forecast of Dutch load gross of behind-the-meter solar…';

describe('withheldForecastNote', () => {
  it('returns the sentence for a withheld series', () => {
    expect(withheldForecastNote({ basis: 'divergent_basis', basisNote: NOTE })).toBe(NOTE);
  });

  it('returns null for a comparable series', () => {
    expect(withheldForecastNote({ basis: 'comparable', basisNote: null })).toBeNull();
  });

  it('returns null for a response that predates the rule', () => {
    // A cached response, or a peer on an older build, carries neither field.
    // That must read as "no finding" — the same way absence from the registry
    // does — and never as a half-rendered notice.
    expect(withheldForecastNote({})).toBeNull();
    expect(withheldForecastNote(undefined)).toBeNull();
    expect(withheldForecastNote(null)).toBeNull();
  });

  it('refuses a half-suppressed response rather than printing an empty notice', () => {
    // Either field alone is malformed and the server never sends one. If it
    // ever did, a heading with nothing under it is worse than staying silent.
    expect(withheldForecastNote({ basis: 'divergent_basis', basisNote: null })).toBeNull();
    expect(withheldForecastNote({ basis: 'divergent_basis', basisNote: '' })).toBeNull();
    expect(withheldForecastNote({ basis: 'comparable', basisNote: NOTE })).toBeNull();
  });

  it('never invents words of its own', () => {
    // The note is established against the upstream documents and lives in the
    // server registry. A client-side default would be a second copy to drift.
    expect(withheldForecastNote({ basis: 'divergent_basis', basisNote: 'anything at all' }))
      .toBe('anything at all');
  });
});

describe('isWithheld', () => {
  it('is true only when there is a sentence to show', () => {
    expect(isWithheld({ basis: 'divergent_basis', basisNote: NOTE })).toBe(true);
    expect(isWithheld({ basis: 'comparable', basisNote: null })).toBe(false);
    expect(isWithheld({ basis: 'divergent_basis', basisNote: null })).toBe(false);
    expect(isWithheld(undefined)).toBe(false);
  });
});

describe('WITHHELD_LEGEND_NOTE', () => {
  it('says withheld, not unavailable', () => {
    // The distinction the whole rule turns on: we hold the rows. "Not
    // available" is the copy for a coverage gap and would be false here.
    expect(WITHHELD_LEGEND_NOTE).toMatch(/withheld/i);
    expect(WITHHELD_LEGEND_NOTE).not.toMatch(/not available|no data|missing|unavailable/i);
  });

  it('is short enough to sit inline in a chart legend', () => {
    expect(WITHHELD_LEGEND_NOTE.length).toBeLessThanOrEqual(40);
  });
});

describe('groupWithheldModels', () => {
  const withheld = (label: string, note = NOTE) => ({
    label,
    basis: 'divergent_basis' as const,
    basisNote: note,
  });
  const fine = (label: string) => ({ label, basis: 'comparable' as const, basisNote: null });

  it('returns nothing when no model was withheld', () => {
    expect(groupWithheldModels([fine('catboost'), fine('tso-d1')])).toEqual([]);
  });

  it('collapses models that share a sentence into one group', () => {
    // The finding is a property of the country's realized series, so today
    // every withheld model on a country carries the identical sentence.
    // Printing it once per checked box would repeat a paragraph three times
    // under one chart.
    expect(groupWithheldModels([withheld('catboost'), withheld('tso-d1')])).toEqual([
      { labels: ['catboost', 'tso-d1'], note: NOTE },
    ]);
  });

  it('keeps two differently-worded findings apart', () => {
    // Keyed on the note, not on the country, so a future registry entry that
    // words its finding differently still renders both.
    const groups = groupWithheldModels([withheld('catboost'), withheld('tso-d1', 'Another finding.')]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.note)).toEqual([NOTE, 'Another finding.']);
  });

  it('ignores comparable entries mixed in, and keeps the caller order', () => {
    const groups = groupWithheldModels([fine('a'), withheld('b'), fine('c'), withheld('d')]);
    expect(groups).toEqual([{ labels: ['b', 'd'], note: NOTE }]);
  });
});

describe('joinModelLabels', () => {
  it('names the models rather than counting them', () => {
    // The reader's next move is to look at the picker, where the boxes are
    // labelled — "2 models withheld" gives them nothing to match against.
    expect(joinModelLabels([])).toBe('');
    expect(joinModelLabels(['catboost'])).toBe('catboost');
    expect(joinModelLabels(['catboost', 'ENTSO-E TSO · D+1'])).toBe('catboost and ENTSO-E TSO · D+1');
    expect(joinModelLabels(['a', 'b', 'c'])).toBe('a, b and c');
  });
});
