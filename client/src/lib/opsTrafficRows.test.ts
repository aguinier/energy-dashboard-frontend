import { describe, it, expect } from 'vitest';
import { buildTrafficBlock, formatCountingSince } from './opsTrafficRows';
import type { VisitorCounters } from '@/types';

function counters(overrides: Partial<VisitorCounters> = {}): VisitorCounters {
  return {
    countingSince: '2026-08-05T09:14:00.000Z',
    day: '2026-08-12',
    today: { page: 12, api: 340, asset: 96, automated: 2880 },
    window: { page: 84, api: 2412, asset: 671, automated: 20160 },
    windowDaysCovered: 7,
    windowComplete: true,
    distinctClientsToday: 3,
    ...overrides,
  };
}

const rowsByLabel = (v: VisitorCounters) =>
  Object.fromEntries(buildTrafficBlock(v)!.rows.map((r) => [r.label, r]));

describe('formatCountingSince', () => {
  it('renders the instant in UTC, because the buckets are UTC days', () => {
    // Rendered in the viewer's local zone it would disagree with the day the
    // counts are bucketed by — the same class of mistake as the freshness pill
    // parsing a space-separated timestamp as local time.
    expect(formatCountingSince('2026-08-12T09:14:00.000Z')).toBe('12 Aug 09:14 UTC');
    expect(formatCountingSince('2026-08-11T23:30:00.000Z')).toBe('11 Aug 23:30 UTC');
  });

  it('says so rather than rendering Invalid Date', () => {
    expect(formatCountingSince('not-a-timestamp')).toBe('an unknown time');
  });
});

describe('buildTrafficBlock — a build that does not report counters', () => {
  it('returns null rather than a block of zeros', () => {
    // The peer is whatever build is deployed over there. A pre-ABL-289 peer
    // answers with no `visitors` key, and rendering that as "0 today · 0 in 7d"
    // would be a confident claim that nobody visited prod.
    expect(buildTrafficBlock(undefined)).toBeNull();
  });
});

describe('buildTrafficBlock — a complete window', () => {
  it('labels the 7-day figure as a 7-day figure', () => {
    const rows = rowsByLabel(counters());

    expect(rows['Page views'].value).toBe('12 today · 84 in 7d');
    expect(rows['App API calls'].value).toBe('340 today · 2,412 in 7d');
    expect(rows['Automated'].value).toBe('2,880 today · 20,160 in 7d');
  });

  it('reports the counting-since instant and does not flag the window partial', () => {
    const block = buildTrafficBlock(counters())!;

    expect(block.since).toBe('5 Aug 09:14 UTC');
    expect(block.partialWindow).toBe(false);
  });

  it('keeps the four lanes separate, never folding automated into the visitor rows', () => {
    // The failure this whole feature exists to prevent: 2,880 health/peer polls
    // reading as 2,880 visits.
    const rows = rowsByLabel(counters());

    expect(rows['Page views'].value).not.toContain('2,880');
    expect(rows['App API calls'].value).not.toContain('2,880');
    expect(rows['Automated'].value).toContain('2,880');
  });
});

describe('buildTrafficBlock — a process younger than its window', () => {
  const fresh = counters({
    countingSince: '2026-08-12T09:14:00.000Z',
    window: { page: 12, api: 340, asset: 96, automated: 2880 },
    windowDaysCovered: 1,
    windowComplete: false,
  });

  it('never calls a partial count a 7-day count', () => {
    // A container restarted an hour ago reporting "12 in 7d" is the exact
    // species of bug this codebase keeps having: plausible, wrong, uncrashing.
    const rows = rowsByLabel(fresh);

    expect(rows['Page views'].value).toBe('12 today · 12 so far');
    expect(rows['Page views'].value).not.toContain('7d');
  });

  it('flags the block and spells out the caveat in the row detail', () => {
    const block = buildTrafficBlock(fresh)!;

    expect(block.partialWindow).toBe(true);
    expect(block.rows[0].detail).toContain('12 Aug 09:14 UTC');
    expect(block.rows[0].detail).toContain('1 of 7 days observed');
    expect(block.rows[0].detail).toContain('a restart resets this');
  });
});

describe('buildTrafficBlock — distinct clients', () => {
  it('renders the estimate with the qualification that it is one', () => {
    const rows = rowsByLabel(counters({ distinctClientsToday: 3 }));

    expect(rows['Distinct clients'].value).toBe('3 today');
    expect(rows['Distinct clients'].detail).toContain('hashed ip+user-agent');
  });

  it('renders a measured zero as zero, not as unknown', () => {
    // Nobody visited today is a real, correct answer — distinct from "we can no
    // longer tell", which is the null below.
    expect(rowsByLabel(counters({ distinctClientsToday: 0 }))['Distinct clients'].value).toBe('0 today');
  });

  it('renders the capped case as unmeasurable rather than as the cap', () => {
    const rows = rowsByLabel(counters({ distinctClientsToday: null }));

    expect(rows['Distinct clients'].value).toBe('too many to count today');
    expect(rows['Distinct clients'].value).not.toMatch(/\d/);
  });
});
