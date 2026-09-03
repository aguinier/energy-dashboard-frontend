import { describe, it, expect } from 'vitest';
import { computeFreshnessRollup, unmeasuredFreshnessRollup } from './freshnessRollup.js';
import type { DataFreshness } from './dataFreshnessService.js';
import type { FreshnessStatus } from '../types/index.js';

function stream(status: FreshnessStatus, ageHours: number | null = null) {
  return { latest: status === 'none' ? null : '2026-08-11 00:00:00', ageHours, status };
}

function freshness(status: FreshnessStatus): DataFreshness {
  return {
    load: stream(status),
    price: stream(status),
    generation: stream(status),
    tsoLoadForecast: stream(status),
    tsoGenerationForecast: stream(status),
  };
}

describe('computeFreshnessRollup', () => {
  it('reports live when every stream in the fleet is live', () => {
    const rollup = computeFreshnessRollup({ DE: freshness('live'), FR: freshness('live') });
    expect(rollup.status).toBe('live');
    expect(rollup.countriesChecked).toBe(2);
    expect(rollup.streamsChecked).toBe(10);
    expect(rollup.counts).toEqual({ live: 10, stale: 0, ended: 0, none: 0 });
    expect(rollup.staleCountries).toEqual([]);
  });

  it('lets a single stale stream in one country dominate an otherwise healthy fleet', () => {
    const rollup = computeFreshnessRollup({
      DE: freshness('live'),
      BE: { ...freshness('live'), load: stream('stale', 20) },
    });
    expect(rollup.status).toBe('stale');
    expect(rollup.staleCountries).toEqual(['BE']);
    expect(rollup.counts.stale).toBe(1);
  });

  it('does not let a terminal "ended" stream outrank a healthy "live" one', () => {
    // `ended` is documented furniture — a stream that stopped so long ago no
    // ingest fix would still be chasing it. It must never mask a real `live`
    // signal elsewhere in the fleet.
    const rollup = computeFreshnessRollup({
      DE: freshness('live'),
      LU: freshness('ended'),
    });
    expect(rollup.status).toBe('live');
  });

  it('does not treat "none" (never held) as an alarm', () => {
    const rollup = computeFreshnessRollup({ AT: freshness('none') });
    expect(rollup.status).toBe('none');
    expect(rollup.staleCountries).toEqual([]);
  });

  it('ranks "ended" above "none" without ever letting either outrank "stale"', () => {
    const rollup = computeFreshnessRollup({
      LU: freshness('ended'),
      AT: freshness('none'),
      BE: { ...freshness('none'), price: stream('stale', 40) },
    });
    expect(rollup.status).toBe('stale');
  });

  it('reports none with zero counts for an empty fleet, rather than throwing', () => {
    const rollup = computeFreshnessRollup({});
    expect(rollup.status).toBe('none');
    expect(rollup.countriesChecked).toBe(0);
    expect(rollup.streamsChecked).toBe(0);
    expect(rollup.staleCountries).toEqual([]);
  });

  it('sorts multiple stale countries deterministically', () => {
    const rollup = computeFreshnessRollup({
      FR: { ...freshness('live'), price: stream('stale', 25) },
      AT: { ...freshness('live'), load: stream('stale', 30) },
    });
    expect(rollup.staleCountries).toEqual(['AT', 'FR']);
  });

  it('counts every stream of a stale country, not just the one that triggered it', () => {
    const rollup = computeFreshnessRollup({
      BE: { ...freshness('live'), load: stream('stale', 20), generation: stream('stale', 22) },
    });
    expect(rollup.counts.stale).toBe(2);
    expect(rollup.counts.live).toBe(3);
    expect(rollup.staleCountries).toEqual(['BE']);
  });

  it('never marks a computed rollup as unmeasured, not even the empty fleet', () => {
    // The empty fleet and the unreadable database produce the same numbers and
    // must stay distinguishable: one is "we looked and there is nothing", the
    // other is "we could not look" (ABL-657).
    expect(computeFreshnessRollup({}).unmeasured).toBeUndefined();
    expect(computeFreshnessRollup({ DE: freshness('live') }).unmeasured).toBeUndefined();
  });
});

describe('unmeasuredFreshnessRollup', () => {
  it('carries the reason and reports honest zero counts', () => {
    const rollup = unmeasuredFreshnessRollup('attempt to write a readonly database');

    expect(rollup.unmeasured).toBe('attempt to write a readonly database');
    expect(rollup.countriesChecked).toBe(0);
    expect(rollup.streamsChecked).toBe(0);
    expect(rollup.counts).toEqual({ live: 0, stale: 0, ended: 0, none: 0 });
    expect(rollup.staleCountries).toEqual([]);
  });

  it('is byte-identical to the empty fleet apart from the reason — `unmeasured` is the only discriminator', () => {
    // Pinned because every consumer keys on `unmeasured` and not on the numbers:
    // if a future edit made this shape differ some other way, a consumer could
    // start reading the difference instead and silently diverge from the rest.
    const empty = computeFreshnessRollup({});
    const failed = unmeasuredFreshnessRollup('database is locked');

    expect({ ...failed, unmeasured: undefined }).toEqual({ ...empty, unmeasured: undefined });
  });

  it('does not claim a freshness verdict — `status` is the empty shape, not a finding', () => {
    // `none` here is furniture: `FreshnessStatus` has no member for "not
    // measured", which is exactly why the reason is a separate field.
    expect(unmeasuredFreshnessRollup('boom').status).toBe('none');
  });
});
