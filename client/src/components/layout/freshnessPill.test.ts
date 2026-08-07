import { describe, it, expect } from 'vitest';
import { describeFreshness } from './freshnessPill';
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

  it('goes stale on a zone that left the data years ago', () => {
    // GB stops at 2021-06-14. The old pill pulsed green beside "5 years ago" —
    // the text was right and the mark contradicted it.
    const fiveYears = 45118;
    const pill = describeFreshness(
      healthy({ load: stale(fiveYears), generation: none, price: none }),
      NOW,
    );

    expect(pill.tone).toBe('stale');
    expect(pill.label).toBe('ENTSO-E · stale, 5 years ago');
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

  it('reports one stale stream even when the others are fine', () => {
    // AL, measured on prod 2026-08-07: load 9.4h (late but complete) and
    // generation 1,066h — 44 days. A pill driven by load alone would call that
    // healthy.
    const pill = describeFreshness(healthy({ generation: stale(1066) }), NOW);

    expect(pill.tone).toBe('stale');
    expect(pill.title).toContain('generation has not updated for 1 month');
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

  it('claims nothing while the answer is still in flight', () => {
    const pill = describeFreshness(undefined, NOW);

    expect(pill.tone).toBe('none');
    expect(pill.label).toBe('ENTSO-E');
    expect(pill.title).toBe('Checking how current the ENTSO-E data is');
  });
});
