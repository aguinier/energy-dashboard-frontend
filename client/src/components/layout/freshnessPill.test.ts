import { describe, it, expect } from 'vitest';
import { describeFreshness, freshnessPulses } from './freshnessPill';
import type { DataFreshness, FreshnessStream } from '@/types';

const NOW = new Date('2026-08-07T07:10:00Z');

const live = (ageHours: number): FreshnessStream => ({
  latest: '2026-08-07 05:45:00',
  ageHours,
  status: 'live',
});
const stale = (ageHours: number): FreshnessStream => ({
  latest: '2026-08-05 21:00:00',
  ageHours,
  status: 'stale',
});
const ended = (ageHours: number): FreshnessStream => ({
  latest: '2026-06-23 21:00:00',
  ageHours,
  status: 'ended',
});
const none: FreshnessStream = { latest: null, ageHours: null, status: 'none' };

/** A healthy FR, as measured against prod on 2026-08-07 07:10 UTC. */
const healthy = (over: Partial<DataFreshness> = {}): DataFreshness => ({
  load: live(1.43),
  generation: live(1.43),
  price: { latest: '2026-08-08 21:45:00', ageHours: -38.6, status: 'live' },
  tsoLoadForecast: { latest: '2026-08-08 21:45:00', ageHours: -38.6, status: 'live' },
  tsoGenerationForecast: { latest: '2026-08-07 21:45:00', ageHours: -14.6, status: 'live' },
  ...over,
});

describe('describeFreshness', () => {
  it('keeps the healthy pill exactly as it was', () => {
    const pill = describeFreshness(healthy(), NOW);

    expect(pill.tone).toBe('live');
    expect(pill.label).toBe('ENTSO-E · 1 hour ago');
    expect(pill.title).toBe('Live data from ENTSO-E — last measured value synced 1 hour ago');
  });

  it('goes stale when the measured streams stop, and says the word', () => {
    // The 2026-08-06 outage: passes stop, the dashboard keeps drawing
    // yesterday. The tone alone is not enough — green-vs-amber is the one
    // distinction a colour blind viewer may not get — so "stale" is in the text.
    const pill = describeFreshness(
      healthy({ load: stale(34.17), generation: stale(34.17) }),
      NOW,
    );

    expect(pill.tone).toBe('stale');
    // Coarse on purpose — the same wording the pill has always used. The word
    // "stale" is the load-bearing part; the magnitude only has to be roughly
    // right for someone to decide whether to trust the chart.
    expect(pill.label).toBe('ENTSO-E · stale, 1 day ago');
    expect(pill.title).toContain('load has not updated for 1 day');
    expect(pill.title).toContain('generation has not updated for 1 day');
  });

  it('shows a neutral ended state for a zone whose upstream series stopped', () => {
    // GB stops at 2021-06-14. This is distinct from both a live stream and an
    // actionable ingest alarm, and the wording names upstream as the cause.
    const fiveYears = 45118;
    const pill = describeFreshness(
      healthy({ load: ended(fiveYears), generation: none, price: none }),
      NOW,
    );

    expect(pill.tone).toBe('ended');
    expect(pill.label).toBe('ENTSO-E · series ended');
    expect(pill.title).toContain('load stopped publishing upstream');
    expect(pill.title).toContain('not an ingest alarm');
    expect(freshnessPulses(pill.tone)).toBe(false);
  });

  it('catches ABL-51: prices fine yesterday, tomorrow never arrived', () => {
    // The measured streams are healthy, so an age-based pill says nothing at
    // all. This is the case a board member found by hand.
    const pill = describeFreshness(
      healthy({ price: { latest: '2026-08-07 21:45:00', ageHours: -14.6, status: 'stale' } }),
      NOW,
    );

    expect(pill.tone).toBe('stale');
    expect(pill.label).toBe('ENTSO-E · tomorrow missing');
    expect(pill.title).toContain('the day-ahead price does not cover tomorrow');
  });

  it('names every broken stream, not just the first', () => {
    const pill = describeFreshness(
      healthy({
        load: stale(20),
        price: { latest: '2026-08-07 21:45:00', ageHours: -14.6, status: 'stale' },
      }),
      NOW,
    );

    expect(pill.title).toContain('load has not updated for 20 hours');
    expect(pill.title).toContain('the day-ahead price does not cover tomorrow');
  });

  it('reports one ended stream even when the others are fine', () => {
    // AL, measured on prod 2026-08-07: load 9.4h (late but complete) and
    // generation 1,066h — 44 days. A pill driven by load alone would call that
    // healthy.
    const pill = describeFreshness(healthy({ generation: ended(1066) }), NOW);

    expect(pill.tone).toBe('ended');
    expect(pill.title).toContain('generation stopped publishing upstream');
    expect(freshnessPulses(pill.tone)).toBe(false);
  });

  it('prints the age of the freshest measured stream, never a future-dated one', () => {
    // Price is 38 hours in the FUTURE. Folding it into the age produced
    // "synced 23 hours ago" while the database held tomorrow's auction.
    const pill = describeFreshness(healthy({ generation: live(6.18) }), NOW);

    expect(pill.label).toBe('ENTSO-E · 1 hour ago');
  });

  it('says "no data" rather than "stale" for a country we have never held', () => {
    // Distinct states on purpose: an alarm no ingest fix could ever clear is
    // not an alarm, it is furniture.
    const pill = describeFreshness(
      healthy({ load: none, generation: none, price: none }),
      NOW,
    );

    expect(pill.tone).toBe('none');
    expect(pill.label).toBe('ENTSO-E · no data');
  });

  it('does not let a never-held stream suppress a healthy one', () => {
    const pill = describeFreshness(healthy({ generation: none, price: none }), NOW);

    expect(pill.tone).toBe('live');
    expect(pill.label).toBe('ENTSO-E · 1 hour ago');
  });

  /**
   * ABL-632. A stream can be stale because its recent window is full of holes
   * rather than because it stopped, and then its newest row is minutes old. The
   * age wording is a contradiction in that case — the prod degradation of
   * 2026-08-30..09-02 had DE's load 41/96, 81/96 and 53/96 across three days
   * with `MAX` never more than a few hours behind.
   */
  it('says what is missing, not how old it is, when a window is holey', () => {
    const pill = describeFreshness(
      healthy({
        load: {
          latest: '2026-08-07 06:45:00',
          ageHours: 0.42,
          status: 'stale',
          coverage: {
            windowStart: '2026-08-04',
            windowEnd: '2026-08-05',
            expectedDailyRows: 96,
            observed: 134,
            expected: 192,
            ratio: 0.6979,
          },
        },
      }),
      NOW,
    );

    expect(pill.tone).toBe('stale');
    expect(pill.label).toBe('ENTSO-E · gaps in recent data');
    expect(pill.title).toContain('load is missing 58 of its last 192 readings');
    expect(pill.title).toContain('2026-08-04 to 2026-08-05');
    // The one thing it must never say: that a 25-minute-old stream has not updated.
    expect(pill.title).not.toContain('has not updated');
  });

  it('still explains an age-driven stale by its age, coverage or not', () => {
    // Complete window, stream simply stopped — the ABL-60 shape. A full
    // `coverage` beside it must not rewrite the wording.
    const pill = describeFreshness(
      healthy({
        load: {
          ...stale(20),
          coverage: {
            windowStart: '2026-08-03',
            windowEnd: '2026-08-04',
            expectedDailyRows: 24,
            observed: 48,
            expected: 48,
            ratio: 1,
          },
        },
      }),
      NOW,
    );

    expect(pill.label).toBe('ENTSO-E · stale, 1 hour ago');
    expect(pill.title).toContain('load has not updated for 20 hours');
  });

  it('claims nothing while the answer is still in flight', () => {
    const pill = describeFreshness(undefined, NOW);

    expect(pill.tone).toBe('none');
    expect(pill.label).toBe('ENTSO-E');
    expect(pill.title).toBe('Checking how current the ENTSO-E data is');
  });

  it('pulses only for a live verdict', () => {
    expect(freshnessPulses('live')).toBe(true);
    expect(freshnessPulses('stale')).toBe(false);
    expect(freshnessPulses('ended')).toBe(false);
    expect(freshnessPulses('none')).toBe(false);
  });
});
