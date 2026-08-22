import { describe, it, expect } from 'vitest';
import {
  CHANGELOG_ENTRY_TYPES,
  CORRECTION_MAX_LEAD_MS,
  ChangelogEntryError,
  NOTICE_PERIOD_DAYS,
  NOTICE_PERIOD_MS,
  assertPublishable,
  correctionPublicationLagMs,
  describeNotice,
  formatInterval,
  noticeIntervalMs,
  parseInstant,
  problemsWithEntry,
  sortEntriesNewestFirst,
  toWireChangelog,
  type ChangelogEntry,
} from './changelogEntry.js';

/**
 * The two-date model and the ordering rule, tested where they are pure.
 *
 * These are the two acceptance criteria ABL-532 names as needing tests, and both
 * are properties of an entry rather than of a database or a route — so they are
 * asserted here, once, and the store and the renderer are then free to be tested
 * for what only they can get wrong.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;

function entry(overrides: Partial<ChangelogEntry> = {}): ChangelogEntry {
  return {
    id: 'cl_000000000001',
    type: 'planned',
    publishedAt: '2026-08-22T09:00:00.000Z',
    effectiveAt: '2026-09-21T09:00:00.000Z',
    title: 'A planned change',
    detail: 'What changed, and for which countries and datasets.',
    whatWasWrong: null,
    isExample: false,
    ...overrides,
  };
}

function correction(overrides: Partial<ChangelogEntry> = {}): ChangelogEntry {
  return entry({
    id: 'cl_000000000002',
    type: 'correction',
    publishedAt: '2026-08-22T09:00:00.000Z',
    effectiveAt: '2026-08-22T09:00:00.000Z',
    title: 'A correction',
    whatWasWrong: 'Values for one zone were served on the wrong basis for nine days.',
    ...overrides,
  });
}

describe('parseInstant', () => {
  it('normalises to UTC with milliseconds, whatever zone was typed', () => {
    expect(parseInstant('2026-09-21T09:00:00Z', '--effective')).toBe('2026-09-21T09:00:00.000Z');
    expect(parseInstant('2026-09-21T11:00:00+02:00', '--effective')).toBe(
      '2026-09-21T09:00:00.000Z'
    );
    expect(parseInstant('  2026-09-21T09:00Z  ', '--effective')).toBe('2026-09-21T09:00:00.000Z');
  });

  it('refuses a time with no zone rather than reading it as local time', () => {
    // The whole reason this is strict: the effective instant is what the notice
    // period is measured against, and resolving it against the operator's
    // timezone is how 30 days quietly becomes 29 days and 22 hours.
    expect(() => parseInstant('2026-09-21T09:00:00', '--effective')).toThrow(
      /explicit time zone/
    );
    expect(() => parseInstant('2026-09-21', '--effective')).toThrow(/explicit time zone/);
  });

  it('refuses free text that Date would happily accept', () => {
    for (const bad of ['tomorrow', 'Sep 21 2026', '2026/09/21', '1758445200']) {
      expect(() => parseInstant(bad, '--effective')).toThrow(ChangelogEntryError);
    }
  });

  it('names the flag in the message, so a CLI failure says which one', () => {
    expect(() => parseInstant('nope', '--effective')).toThrow(/--effective/);
  });

  it('refuses a well-shaped date that is not a real one', () => {
    expect(() => parseInstant('2026-02-30T09:00:00Z', '--effective')).toThrow(
      ChangelogEntryError
    );
  });
});

describe('the two-date model', () => {
  it('accepts a planned change published exactly the notice period ahead', () => {
    expect(noticeIntervalMs(entry())).toBe(NOTICE_PERIOD_MS);
    expect(problemsWithEntry(entry())).toEqual([]);
  });

  it('refuses a planned change with less than 30 days of notice', () => {
    const short = entry({ effectiveAt: '2026-09-21T08:59:59.000Z' });

    expect(problemsWithEntry(short)).toHaveLength(1);
    expect(problemsWithEntry(short)[0]).toMatch(/needs 30 days' notice/);
    // And it points at the two ways out rather than only complaining.
    expect(problemsWithEntry(short)[0]).toMatch(/cannot be\s+backdated/);
    expect(problemsWithEntry(short)[0]).toMatch(/correction type/);
  });

  it('refuses a planned change dated to take effect before it was published', () => {
    const backwards = entry({ effectiveAt: '2026-08-01T09:00:00.000Z' });

    expect(problemsWithEntry(backwards)[0]).toMatch(/effective instant is before publication/);
  });

  it('accepts a correction published at the same instant the change took effect', () => {
    expect(problemsWithEntry(correction())).toEqual([]);
    expect(noticeIntervalMs(correction())).toBe(0);
  });

  it('accepts a correction published up to an hour before the switch is flipped', () => {
    // The safe operational order — notice up first, then serve the change — is
    // not something the validator should push an operator out of.
    const lead = correction({ effectiveAt: '2026-08-22T10:00:00.000Z' });

    expect(noticeIntervalMs(lead)).toBe(CORRECTION_MAX_LEAD_MS);
    expect(problemsWithEntry(lead)).toEqual([]);
  });

  it('refuses a correction that takes effect in the future — that is a planned change', () => {
    const disguised = correction({ effectiveAt: '2026-09-01T09:00:00.000Z' });

    expect(problemsWithEntry(disguised)[0]).toMatch(/a correction is served immediately/);
    expect(problemsWithEntry(disguised)[0]).toMatch(/publish it as one/);
  });

  it('allows a correction published late, and reports how late', () => {
    // Deliberately not a refusal: the change is already being served by then, so
    // refusing the entry trades a late notice for no notice at all.
    const late = correction({ publishedAt: '2026-08-22T11:30:00.000Z' });

    expect(problemsWithEntry(late)).toEqual([]);
    expect(correctionPublicationLagMs(late)).toBe(2.5 * HOUR);
    expect(describeNotice(late)).toBe('2 hours 30 minutes after the change took effect');
  });

  it('reports no lag for an entry that was not late', () => {
    expect(correctionPublicationLagMs(correction())).toBe(0);
    expect(correctionPublicationLagMs(entry())).toBe(0);
  });

  it('requires a correction to say what was wrong', () => {
    for (const value of [null, '', '   ']) {
      expect(problemsWithEntry(correction({ whatWasWrong: value }))).toEqual([
        expect.stringMatching(/whatWasWrong is required on a correction/),
      ]);
    }
  });

  it('refuses whatWasWrong on a planned change', () => {
    expect(problemsWithEntry(entry({ whatWasWrong: 'nothing, really' }))).toEqual([
      expect.stringMatching(/belongs only on a correction/),
    ]);
  });

  it('refuses an unknown type without also complaining about everything else', () => {
    const problems = problemsWithEntry(entry({ type: 'urgent' as never, title: '' }));

    // One problem, not three: with no known type there is no rule to apply, and
    // a list of consequential complaints buries the real one.
    expect(problems).toEqual([expect.stringMatching(/type must be one of: planned, correction/)]);
  });

  it('refuses an instant that is not in the stored shape, and stops there', () => {
    const problems = problemsWithEntry(entry({ effectiveAt: '2026-09-21T09:00:00Z' }));

    // Would otherwise also produce a NaN-driven complaint about the notice
    // period, which points at the wrong field.
    expect(problems).toEqual([expect.stringMatching(/effectiveAt must be a UTC instant/)]);
  });

  it('requires a title and a detail', () => {
    expect(problemsWithEntry(entry({ title: '  ', detail: '' }))).toEqual([
      expect.stringMatching(/title is required/),
      expect.stringMatching(/detail is required/),
    ]);
  });

  it('collects every problem at once rather than one per run', () => {
    const broken = entry({ type: 'correction', whatWasWrong: null, effectiveAt: '2026-10-01T09:00:00.000Z' });

    expect(problemsWithEntry(broken)).toHaveLength(2);
  });

  it('assertPublishable lists the problems in the message', () => {
    expect(() => assertPublishable(entry({ effectiveAt: '2026-08-30T09:00:00.000Z' }))).toThrow(
      ChangelogEntryError
    );
    expect(() => assertPublishable(entry({ effectiveAt: '2026-08-30T09:00:00.000Z' }))).toThrow(
      /cannot be published[\s\S]*30 days/
    );
    expect(() => assertPublishable(entry())).not.toThrow();
  });

  it('has a rule for every type it declares', () => {
    // The guard on adding a third type later — a member with no branch would
    // otherwise be publishable with no constraint on its two instants at all.
    for (const type of CHANGELOG_ENTRY_TYPES) {
      const nonsense = entry({ type, effectiveAt: '2026-08-22T09:00:00.001Z', whatWasWrong: null });
      expect(problemsWithEntry(nonsense).length).toBeGreaterThan(0);
    }
  });
});

describe('describeNotice', () => {
  it('states the interval a planned entry actually gave', () => {
    expect(describeNotice(entry())).toBe('30 days before the change takes effect');
  });

  it('calls a gap under a minute "the same time"', () => {
    // Because it is: the change is served when an artifact is promoted and the
    // entry is stamped when the operator runs the publish command, and nothing
    // collapses those into one millisecond. Both instants are on the page
    // regardless, so nothing is hidden by the phrase.
    expect(describeNotice(correction({ publishedAt: '2026-08-22T09:00:30.000Z' }))).toBe(
      'published at the same time as the change'
    );
    expect(describeNotice(correction({ effectiveAt: '2026-08-22T09:00:45.000Z' }))).toBe(
      'published at the same time as the change'
    );
  });

  it('is a function of the entry alone, so the page does not change under a reader', () => {
    const fixed = entry();
    expect(describeNotice(fixed)).toBe(describeNotice(fixed));
  });
});

describe('formatInterval', () => {
  it('uses at most two units, largest first', () => {
    expect(formatInterval(30 * DAY)).toBe('30 days');
    expect(formatInterval(DAY)).toBe('1 day');
    expect(formatInterval(DAY + 5 * HOUR)).toBe('1 day 5 hours');
    expect(formatInterval(2 * HOUR + 30 * 60_000)).toBe('2 hours 30 minutes');
    expect(formatInterval(45 * 60_000)).toBe('45 minutes');
    expect(formatInterval(60_000)).toBe('1 minute');
  });

  it('does not round a sub-minute gap to "0 minutes"', () => {
    expect(formatInterval(0)).toBe('less than a minute');
    expect(formatInterval(1_200)).toBe('less than a minute');
  });

  it('drops minutes once days are involved, rather than printing three units', () => {
    expect(formatInterval(30 * DAY + 60_000)).toBe('30 days');
    expect(formatInterval(30 * DAY + 3 * HOUR + 60_000)).toBe('30 days 3 hours');
  });

  it('reads a negative interval as a magnitude', () => {
    expect(formatInterval(-2 * HOUR)).toBe('2 hours');
  });
});

describe('ordering', () => {
  const older = entry({ id: 'cl_a', publishedAt: '2026-08-01T09:00:00.000Z' });
  const newer = entry({ id: 'cl_b', publishedAt: '2026-08-20T09:00:00.000Z' });

  it('is newest first by publication', () => {
    expect(sortEntriesNewestFirst([older, newer]).map((e) => e.id)).toEqual(['cl_b', 'cl_a']);
    expect(sortEntriesNewestFirst([newer, older]).map((e) => e.id)).toEqual(['cl_b', 'cl_a']);
  });

  it('orders by publication and not by effective instant', () => {
    // The case the rule exists for: a planned change published first but
    // effective in a month, and a correction published later and effective at
    // once. By effective instant the planned one would sit on top, which reads
    // as a chronology of what happened and is not one.
    const planned = entry({
      id: 'cl_planned',
      publishedAt: '2026-08-01T09:00:00.000Z',
      effectiveAt: '2026-08-31T09:00:00.000Z',
    });
    const fix = correction({
      id: 'cl_fix',
      publishedAt: '2026-08-10T09:00:00.000Z',
      effectiveAt: '2026-08-10T09:00:00.000Z',
    });

    expect(sortEntriesNewestFirst([planned, fix]).map((e) => e.id)).toEqual([
      'cl_fix',
      'cl_planned',
    ]);
  });

  it('breaks a publication tie deterministically instead of leaving input order to decide', () => {
    const a = entry({ id: 'cl_aaa' });
    const b = entry({ id: 'cl_bbb' });

    expect(sortEntriesNewestFirst([a, b]).map((e) => e.id)).toEqual(['cl_bbb', 'cl_aaa']);
    expect(sortEntriesNewestFirst([b, a]).map((e) => e.id)).toEqual(['cl_bbb', 'cl_aaa']);
  });

  it('does not mutate its input', () => {
    const input = [older, newer];
    sortEntriesNewestFirst(input);
    expect(input.map((e) => e.id)).toEqual(['cl_a', 'cl_b']);
  });

  it('compares stored instants as strings, which is chronological across a year boundary', () => {
    const decade = [
      entry({ id: 'cl_1', publishedAt: '2026-12-31T23:59:59.999Z' }),
      entry({ id: 'cl_2', publishedAt: '2027-01-01T00:00:00.000Z' }),
    ];

    expect(sortEntriesNewestFirst(decade).map((e) => e.id)).toEqual(['cl_2', 'cl_1']);
  });
});

describe('the JSON document', () => {
  it('carries the notice period as data, not only in prose', () => {
    expect(toWireChangelog([]).notice_period_days).toBe(NOTICE_PERIOD_DAYS);
  });

  it('is newest first and snake_case, with the interval as a number as well as words', () => {
    const wire = toWireChangelog([entry({ id: 'cl_old', publishedAt: '2026-01-01T00:00:00.000Z' }), correction()]);

    expect(wire.entries.map((e) => e.id)).toEqual(['cl_000000000002', 'cl_old']);
    expect(wire.entries[1]).toMatchObject({
      type: 'planned',
      published_at: '2026-01-01T00:00:00.000Z',
      effective_at: '2026-09-21T09:00:00.000Z',
      what_was_wrong: null,
      example: false,
    });
    expect(wire.entries[0].notice_seconds).toBe(0);
    expect(wire.entries[0].notice).toBe('published at the same time as the change');
  });

  it('reports the notice in seconds so a watcher does not have to parse English', () => {
    expect(toWireChangelog([entry()]).entries[0].notice_seconds).toBe(30 * 86_400);
  });

  it('cites no clause and links nothing', () => {
    const serialised = JSON.stringify(toWireChangelog([entry(), correction()]));

    expect(serialised).not.toMatch(/§/);
    expect(serialised.toLowerCase()).not.toContain('terms of service');
    expect(serialised).not.toMatch(/https?:\/\//);
  });
});
