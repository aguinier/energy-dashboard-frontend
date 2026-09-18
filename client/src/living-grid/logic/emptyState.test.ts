import { describe, it, expect } from 'vitest';
import { anyOf, emptyMessage, emptyReason } from './emptyState';
import { series } from './testFixture';

describe('emptyReason', () => {
  it('is null when the hour has a value and the section should render', () => {
    expect(emptyReason(series(() => 5), 12)).toBeNull();
  });

  it('separates a silent day from an hour the data has not reached', () => {
    // This distinction is the whole point. Through the morning the day's
    // ingest has only covered a few hours, so "nothing today" would be false
    // for most zones most of the time.
    expect(emptyReason(series(() => null), 12)).toEqual({ kind: 'none-today' });
    expect(emptyReason(series((h) => (h <= 3 ? 10 : null)), 12)).toEqual({
      kind: 'not-this-hour',
      latestHour: 3,
    });
  });

  it('reports the LAST hour that has data, not the first', () => {
    expect(emptyReason(series((h) => (h <= 9 ? 1 : null)), 20)).toEqual({
      kind: 'not-this-hour',
      latestHour: 9,
    });
  });

  it('looks past a gap to find the real latest hour', () => {
    const s = series((h) => (h === 1 || h === 8 ? 1 : null));

    expect(emptyReason(s, 12)).toEqual({ kind: 'not-this-hour', latestHour: 8 });
  });

  it('calls an interior hole a gap, not an update that has not landed', () => {
    // The zone reported all day either side of 03:00. "not yet" would point
    // forward at 20:00 and blame the ingest for a hole it has already passed.
    const s = series((h) => (h === 3 ? null : 10));

    expect(emptyReason(s, 3)).toEqual({ kind: 'gap', resumesHour: 4 });
  });

  it('names the next hour that reports, not the next slot', () => {
    const s = series((h) => (h >= 3 && h <= 6 ? null : 10));

    expect(emptyReason(s, 3)).toEqual({ kind: 'gap', resumesHour: 7 });
  });

  it('treats an absent series as a silent day', () => {
    expect(emptyReason(undefined, 12)).toEqual({ kind: 'none-today' });
  });

  it('does not mistake a measured zero for missing data', () => {
    expect(emptyReason(series(() => 0), 12)).toBeNull();
  });
});

describe('emptyMessage', () => {
  it('says "today" only when the whole day is silent', () => {
    expect(emptyMessage({ kind: 'none-today' }, 'generation')).toBe(
      'No generation published for this zone today.',
    );
  });

  it('names the latest hour when the data has simply not arrived yet', () => {
    expect(emptyMessage({ kind: 'not-this-hour', latestHour: 3 }, 'border flow')).toBe(
      'No border flow for this hour yet — the latest today is 03:00.',
    );
  });

  it('says a gap is a hole in the day rather than a late update', () => {
    expect(emptyMessage({ kind: 'gap', resumesHour: 7 }, 'generation')).toBe(
      'No generation for this hour — a gap in the day; it resumes at 07:00.',
    );
  });

  it('says a reported zero is a zero, not an absence', () => {
    expect(emptyMessage({ kind: 'zero' }, 'generation')).toBe(
      'Reported generation for this hour is zero.',
    );
  });
});

describe('anyOf', () => {
  it('marks an hour present when any one series has it', () => {
    const track = anyOf([series((h) => (h === 4 ? 1 : null)), series((h) => (h === 9 ? 1 : null))]);

    expect(track[4]).toBe(1);
    expect(track[9]).toBe(1);
    expect(track[12]).toBeNull();
  });

  it('is entirely absent for no series at all', () => {
    expect(anyOf([]).every((v) => v === null)).toBe(true);
  });

  it('feeds emptyReason correctly for a multi-series section', () => {
    // A zone with eight fuels, only one of which reported, and only early.
    const track = anyOf([series((h) => (h < 2 ? 500 : null)), series(() => null)]);

    expect(emptyReason(track, 12)).toEqual({ kind: 'not-this-hour', latestHour: 1 });
  });
});
