import { describe, it, expect } from 'vitest';
import { coverageNote, dayCoverage } from './dayCoverage';
import { makeDay, makeEmptyDay, series, zone } from './testFixture';

describe('dayCoverage', () => {
  it('reports every stream a full day carries', () => {
    const coverage = dayCoverage(makeDay());
    expect(coverage.empty).toBe(false);
    expect(coverage.zoneCount).toBe(4);
    expect(coverage.streams).toEqual({
      load: true,
      price: true,
      net: true,
      mix: true,
      flows: true,
    });
  });

  it('calls a zoneless payload empty', () => {
    const coverage = dayCoverage(makeEmptyDay());
    expect(coverage.empty).toBe(true);
    expect(coverage.zoneCount).toBe(0);
    expect(Object.values(coverage.streams).every((v) => v === false)).toBe(true);
  });

  /**
   * The shape D+1 actually returns, measured against prod: the day-ahead
   * auction has settled prices and net positions, and nothing realized exists
   * yet. A day is not simply full or empty and the note has to say which.
   */
  it('reports the day-ahead shape as partial, not empty', () => {
    const day = makeDay({
      zones: {
        DE: zone({ price: series(() => 90), net: series(() => 2_000) }),
        FR: zone({ price: series(() => 70) }),
      },
      flows: {},
    });
    const coverage = dayCoverage(day);
    expect(coverage.empty).toBe(false);
    expect(coverage.streams).toEqual({
      load: false,
      price: true,
      net: true,
      mix: false,
      flows: false,
    });
  });

  it('does not count a zone that exists but published nothing', () => {
    const day = makeDay({ zones: { PT: zone() }, flows: {} });
    const coverage = dayCoverage(day);
    expect(coverage.zoneCount).toBe(1);
    expect(coverage.empty).toBe(true);
  });
});

describe('coverageNote', () => {
  it('says nothing about a complete day — the map is the message', () => {
    expect(coverageNote(dayCoverage(makeDay()), 'today')).toBeNull();
    expect(coverageNote(dayCoverage(makeDay()), 'past')).toBeNull();
  });

  it('keeps the tense straight between a hole and a schedule', () => {
    const empty = dayCoverage(makeEmptyDay());
    expect(coverageNote(empty, 'future')).toBe('Nothing is published for this day yet.');
    expect(coverageNote(empty, 'past')).toBe('Nothing is published for this day.');
    // "yet" about a day that has already been is a false promise.
    expect(coverageNote(empty, 'past')).not.toContain('yet');
  });

  it('names what a partial future day does carry', () => {
    const day = makeDay({
      zones: { DE: zone({ price: series(() => 90), net: series(() => 2_000) }) },
      flows: {},
    });
    const note = coverageNote(dayCoverage(day), 'future');
    expect(note).toBe('Day-ahead prices and net positions only — nothing else is published this far ahead.');
  });

  it('uses no list connective for a single stream', () => {
    const day = makeDay({ zones: { DE: zone({ price: series(() => 90) }) }, flows: {} });
    expect(coverageNote(dayCoverage(day), 'future')).toBe(
      'Day-ahead prices only — nothing else is published this far ahead.',
    );
  });

  it('says nothing about a partial past day, which is ordinary', () => {
    const day = makeDay({ zones: { DE: zone({ price: series(() => 90) }) }, flows: {} });
    expect(coverageNote(dayCoverage(day), 'past')).toBeNull();
  });
});
