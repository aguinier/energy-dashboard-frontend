import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryEnergySource, type MemoryEnergySource } from './memoryEnergySource.js';
import {
  classifyForecastVintage,
  createFreshnessMap,
  FORECAST_VINTAGE_STALE_AFTER_HOURS,
} from './freshnessMap.js';

/**
 * The freshness map: three clocks, two directions, and one column that cannot
 * be trusted.
 *
 * Every case here corresponds to a way a single scalar `as_of` would have been
 * wrong — which is why ABL-293 §2g refused one and specified four fields.
 */

let db: MemoryEnergySource;
const NOW = new Date('2026-08-12T12:00:00Z');

beforeEach(() => {
  db = createMemoryEnergySource();
  db.zones('DE', 'GB', 'XX');
});

afterEach(() => {
  db.close();
});

function map() {
  return createFreshnessMap({ source: db, refreshIntervalMs: 0, now: () => NOW });
}

describe('data_through', () => {
  it('is the newest row, not the highest string', () => {
    // `MAX(timestamp_utc)` is an index lookup and is *wrong* here: `'T'`(84)
    // sorts above `' '`(32), so a `T`-form row beats a space-form row on the
    // same date. The map reads the tail of the index and takes the maximum
    // after normalising, which gets both correctness and the seek.
    db.load('DE', '2026-08-12T09:00:00', 100);
    db.load('DE', '2026-08-12 11:00:00', 200);

    expect(map().lookup('DE', 'load').data_through).toBe('2026-08-12T11:00:00Z');
  });

  it('never names a row no query can return', () => {
    // The newest stored row for DE is an impossible `0.0` — exactly the state MK
    // and SI were in when this was measured. Advertising it as `data_through`
    // would promise a row the data endpoint filters out.
    db.load('DE', '2026-08-12 10:00:00', 40_000);
    db.load('DE', '2026-08-12 11:00:00', 0);
    db.load('DE', '2026-08-12 12:00:00+02:00', 41_000);

    expect(map().lookup('DE', 'load').data_through).toBe('2026-08-12T10:00:00Z');
  });

  it('reports both edges of what we hold', () => {
    db.load('DE', '2026-08-10 00:00:00', 1);
    db.load('DE', '2026-08-12 00:00:00', 2);

    const state = map().lookup('DE', 'load');
    expect(state.data_from).toBe('2026-08-10T00:00:00Z');
    expect(state.data_through).toBe('2026-08-12T00:00:00Z');
  });
});

describe('status is judged by the rule that fits the family', () => {
  it('judges a measured stream on age', () => {
    db.load('DE', '2026-08-12 11:00:00', 100);
    expect(map().lookup('DE', 'load').status).toBe('live');
  });

  it('marks a measured stream stale once a pass has certainly been missed', () => {
    db.load('DE', '2026-08-11 12:00:00', 100); // 24h old, past the 18h threshold
    expect(map().lookup('DE', 'load').status).toBe('stale');
  });

  it('marks a long-dead series ended, not stale', () => {
    // GB really did stop on 2021-06-14. `ended` is what lets a customer tell
    // "this zone stopped publishing" from "we are between passes" — without it
    // both render as a short array and the customer attributes both to us.
    db.load('GB', '2021-06-14T09:00:00', 30_000);
    expect(map().lookup('GB', 'load').status).toBe('ended');
  });

  it('judges a day-ahead price on coverage, not age — it is dated in the future', () => {
    // The ABL-51 defect, in one assertion. A day-ahead price dated ~21h ahead
    // would read as impossibly fresh forever under an age rule, so a genuinely
    // missing tomorrow would never surface.
    db.price('DE', '2026-08-13 22:00:00', 90);
    expect(map().lookup('DE', 'price').status).toBe('live');

    const stale = createMemoryEnergySource();
    stale.zones('DE');
    // Nothing reaching today's Brussels market day: stale, even though this row
    // is only a day old and an age rule would call it fine.
    stale.price('DE', '2026-08-10 12:00:00', 90);
    expect(
      createFreshnessMap({ source: stale, refreshIntervalMs: 0, now: () => NOW }).lookup(
        'DE',
        'price'
      ).status
    ).toBe('stale');
    stale.close();
  });

  it('reports none for a zone we hold nothing for, rather than omitting it', () => {
    const state = map().lookup('XX', 'load');
    expect(state.status).toBe('none');
    expect(state.data_through).toBeNull();
  });
});

describe('source_checked_at comes from records_failed, never from status', () => {
  it('ignores a pass that failed everything but is logged as completed', () => {
    // `data_ingestion_log.status` is `'completed'` on 114,982 of 114,983 rows —
    // there is no failure value in the vocabulary at all, and the 2026-08-06
    // ENTSO-E outage (484 HTTP 503s, nothing stored) is in the table as five
    // healthy-looking passes. Anyone deriving freshness from `status` publishes
    // the worst outage of the year as a green light.
    db.load('DE', '2026-08-12 11:00:00', 100);
    db.ingestPass({
      pipelineType: 'load',
      zone: 'DE',
      startTime: '2026-08-12T06:30:00+00:00',
      endTime: '2026-08-12T06:41:00+00:00',
    });
    db.ingestPass({
      pipelineType: 'load',
      zone: 'DE',
      startTime: '2026-08-12T11:30:00+00:00',
      endTime: '2026-08-12T11:41:00+00:00',
      status: 'completed',
      recordsFailed: 35,
    });

    expect(map().lookup('DE', 'load').source_checked_at).toBe('2026-08-12T06:41:00Z');
  });

  it('ignores a pass that has not finished', () => {
    db.ingestPass({
      pipelineType: 'load',
      zone: 'DE',
      startTime: '2026-08-12T11:30:00+00:00',
      endTime: null,
    });
    expect(map().lookup('DE', 'load').source_checked_at).toBeNull();
  });

  it('reads generation from the renewable pipeline, which is what writes it', () => {
    // There is no `generation` pipeline_type in the log. `fetch_renewable.py`
    // logs `'renewable'` and writes the whole A75 document into
    // `energy_generation`, so mapping it to a plausible-looking absent name
    // would leave this field permanently null.
    db.ingestPass({
      pipelineType: 'renewable',
      zone: 'DE',
      startTime: '2026-08-12T06:30:00+00:00',
      endTime: '2026-08-12T06:43:00+00:00',
    });
    expect(map().lookup('DE', 'generation').source_checked_at).toBe('2026-08-12T06:43:00Z');
  });

  it('prefers a zone-level pass over a fleet-level one', () => {
    db.ingestPass({
      pipelineType: 'load',
      zone: null,
      startTime: '2026-08-12T11:30:00+00:00',
      endTime: '2026-08-12T11:41:00+00:00',
    });
    db.ingestPass({
      pipelineType: 'load',
      zone: 'DE',
      startTime: '2026-08-12T06:30:00+00:00',
      endTime: '2026-08-12T06:41:00+00:00',
    });

    expect(map().lookup('DE', 'load').source_checked_at).toBe('2026-08-12T06:41:00Z');
    // GB has no pass of its own, so the fleet-level one is the honest answer.
    expect(map().lookup('GB', 'load').source_checked_at).toBe('2026-08-12T11:41:00Z');
  });
});

describe('the map is memoized, not queried per request', () => {
  it('does not change between refreshes', () => {
    db.load('DE', '2026-08-12 10:00:00', 100);
    const built = map();
    expect(built.lookup('DE', 'load').data_through).toBe('2026-08-12T10:00:00Z');

    db.load('DE', '2026-08-12 11:00:00', 200);
    expect(built.lookup('DE', 'load').data_through).toBe('2026-08-12T10:00:00Z');

    built.refresh();
    expect(built.lookup('DE', 'load').data_through).toBe('2026-08-12T11:00:00Z');
  });

  it('reports when it was built, so a catalogue response can say so', () => {
    expect(map().snapshot().builtAt).toEqual(NOW);
  });
});

describe('forecast vintages have a clock of their own', () => {
  it('is live inside the twelve-hour nightly gap between runs', () => {
    // Our runs land at 07:00, 14:00, 15:30 and 19:00 UTC, so a customer calling
    // at 03:00 is correctly served a vintage generated at 19:00 the previous
    // evening. That is the product, not a fault.
    const at3am = new Date('2026-08-13T03:00:00Z');
    expect(classifyForecastVintage('2026-08-12T19:00:00.000000', at3am)).toBe('live');
  });

  it('goes stale once a whole run schedule has been missed', () => {
    const later = new Date(
      Date.parse('2026-08-12T19:00:00Z') + (FORECAST_VINTAGE_STALE_AFTER_HOURS + 1) * 3_600_000
    );
    expect(classifyForecastVintage('2026-08-12T19:00:00.000000', later)).toBe('stale');
  });

  it('is none when we hold no vintage at all', () => {
    expect(classifyForecastVintage(null, NOW)).toBe('none');
  });
});
