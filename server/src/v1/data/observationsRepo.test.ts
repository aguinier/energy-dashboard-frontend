import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryEnergySource, type MemoryEnergySource } from './memoryEnergySource.js';
import { readObservations } from './observationsRepo.js';
import { parseWindow } from './params.js';
import { STREAMS } from './series.js';

/**
 * The SQL traps, against a real SQLite engine.
 *
 * Every case here is a defect this repository has already paid for once, and
 * none of them is reproducible against a stub: they are all about how SQLite
 * compares text, which rows an index seek finds, and what the DDL does not
 * default.
 */

let db: MemoryEnergySource;

beforeEach(() => {
  db = createMemoryEnergySource();
  db.zones('DE');
});

afterEach(() => {
  db.close();
});

function readLoad(from: string, to: string, options: { after?: string; limit?: number } = {}) {
  return readObservations(db, {
    stream: 'load',
    zone: 'DE',
    window: parseWindow({ from, to }),
    series: STREAMS.load.series,
    after: options.after,
    limit: options.limit ?? 100,
  });
}

describe('two separators in one column (ABL-21)', () => {
  it('finds both forms inside the window', () => {
    // The real table holds both: `energy_load` is 279,880 `T`-form rows against
    // 2,480,336 space-form, split at a 2025-11 cutover. A space-form upper
    // bound sorts *below* every `T`-form row on the end date and silently drops
    // the whole day; a `T`-form bound over-reads the other way. Neither single
    // bound is correct while both forms exist.
    db.load('DE', '2026-08-12T09:00:00', 100);
    db.load('DE', '2026-08-12 10:00:00', 200);

    const page = readLoad('2026-08-12', '2026-08-13');
    expect(page.rows.map((row) => row.timestamp)).toEqual([
      '2026-08-12T09:00:00Z',
      '2026-08-12T10:00:00Z',
    ]);
  });

  it('does not pull in a row past the end of a half-open window', () => {
    db.load('DE', '2026-08-12 23:00:00', 100);
    db.load('DE', '2026-08-13T00:00:00', 200);

    const page = readLoad('2026-08-12', '2026-08-13');
    expect(page.rows.map((row) => row.timestamp)).toEqual(['2026-08-12T23:00:00Z']);
  });

  it('orders by the normalised timestamp, so the two forms interleave correctly', () => {
    // Ordering on the raw column would put `2026-08-12T09:00:00` after
    // `2026-08-12 23:00:00`, because `'T'`(84) > `' '`(32) — which would also
    // break cursor pagination, since the cursor assumes the page is monotonic.
    db.load('DE', '2026-08-12 23:00:00', 300);
    db.load('DE', '2026-08-12T09:00:00', 100);
    db.load('DE', '2026-08-12 12:00:00', 200);

    expect(readLoad('2026-08-12', '2026-08-13').rows.map((row) => row.load)).toEqual([
      100, 200, 300,
    ]);
  });
});

describe('rows stored with a UTC offset are excluded', () => {
  it('leaves them out of the data', () => {
    // 26,405 such rows exist across load, price and renewable, all in
    // 2025-11-13..28, and each is up to two hours from where it belongs.
    // Serving one as though it were UTC publishes a two-hour error under a
    // contract whose first sentence is that every timestamp is UTC.
    db.load('DE', '2025-11-20 10:00:00+02:00', 100);
    db.load('DE', '2025-11-20 11:00:00', 200);

    const page = readLoad('2025-11-20', '2025-11-21');
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].timestamp).toBe('2025-11-20T11:00:00Z');
  });

  it('excludes by exact length, which the measured data supports', () => {
    // `LENGTH(timestamp_utc) = 19` is exact rather than heuristic: measured
    // 2026-08-13, every row in all three tables is length 19 or length 25, with
    // no third value. A `Z`-suffixed row would be length 20 and is not a shape
    // this ingest writes — asserted so that if one ever appears, it appears as
    // a failing test rather than as a silently dropped row.
    db.load('DE', '2026-08-12 10:00:00', 100);
    db.load('DE', '2026-08-12T11:00:00Z', 200);

    expect(readLoad('2026-08-12', '2026-08-13').rows).toHaveLength(1);
  });
});

describe('null is not zero', () => {
  it('emits every requested production type, null where the zone does not report it', () => {
    db.generation('DE', '2026-08-12 03:00:00', { solar_mw: 0, wind_onshore_mw: 12_000 });

    const page = readObservations(db, {
      stream: 'generation',
      zone: 'DE',
      window: parseWindow({ from: '2026-08-12', to: '2026-08-13' }),
      series: STREAMS.generation.series,
      limit: 10,
    });

    const row = page.rows[0];
    // A measured zero — solar at 03:00 really is 0.0.
    expect(row.solar).toBe(0);
    // Not reported at all. Present as a key, null as a value: omitting it would
    // make "does not report" indistinguishable from "we dropped it".
    expect(row.nuclear).toBeNull();
    expect(Object.keys(row)).toHaveLength(22); // timestamp + 21 production types
  });

  it('narrows the emitted set without changing the null rule', () => {
    db.generation('DE', '2026-08-12 03:00:00', { solar_mw: 1 });

    const page = readObservations(db, {
      stream: 'generation',
      zone: 'DE',
      window: parseWindow({ from: '2026-08-12', to: '2026-08-13' }),
      series: STREAMS.generation.series.filter((s) => ['solar', 'nuclear'].includes(s.field)),
      limit: 10,
    });

    expect(page.rows[0]).toEqual({
      timestamp: '2026-08-12T03:00:00Z',
      solar: 1,
      nuclear: null,
    });
  });
});

describe("load's impossible zeros are not measurements", () => {
  it('filters a stored 0.0, which is the ingest writing a placeholder', () => {
    // 543 such rows across 11 zones; MK reads 0.0 for entire days against a real
    // 543-717 MW peak. A national grid never draws exactly 0 MW.
    db.load('DE', '2026-08-12 09:00:00', 0);
    db.load('DE', '2026-08-12 10:00:00', 40_000);

    expect(readLoad('2026-08-12', '2026-08-13').rows).toHaveLength(1);
  });

  it('does not apply the same rule to generation, where zero is ordinary', () => {
    // Applying `> 0` across the board would delete real overnight solar and
    // bias every renewable series upward — the same class of mistake pointing
    // the other way.
    db.generation('DE', '2026-08-12 03:00:00', { solar_mw: 0 });

    const page = readObservations(db, {
      stream: 'generation',
      zone: 'DE',
      window: parseWindow({ from: '2026-08-12', to: '2026-08-13' }),
      series: STREAMS.generation.series,
      limit: 10,
    });
    expect(page.rows).toHaveLength(1);
  });
});

describe('paging', () => {
  beforeEach(() => {
    for (let hour = 0; hour < 10; hour += 1) {
      db.load('DE', `2026-08-12 ${String(hour).padStart(2, '0')}:00:00`, 100 + hour);
    }
  });

  it('reports hasMore as a fact, not as row_count === limit', () => {
    // Ten rows, limit ten: `hasMore` must be false. The `limit + 1` probe is
    // what makes that answerable — otherwise this caller follows a `next` link
    // to an empty page forever, one billed request at a time.
    expect(readLoad('2026-08-12', '2026-08-13', { limit: 10 }).hasMore).toBe(false);
    expect(readLoad('2026-08-12', '2026-08-13', { limit: 9 }).hasMore).toBe(true);
  });

  it('resumes strictly after the cursor, losing and repeating nothing', () => {
    const first = readLoad('2026-08-12', '2026-08-13', { limit: 4 });
    expect(first.lastStoredTimestamp).toBe('2026-08-12 03:00:00');

    const second = readLoad('2026-08-12', '2026-08-13', {
      limit: 4,
      after: first.lastStoredTimestamp!,
    });
    expect(second.rows[0].timestamp).toBe('2026-08-12T04:00:00Z');
  });

  it('a cursor across the separator cutover still resumes correctly', () => {
    // The cursor is a space-form bound, and the rows past it may be `T`-form.
    // Sound because the space form is the *lower* of the two: any row whose
    // normalised value is above a space-form bound also sorts above it raw. If
    // that reasoning were wrong, this page would silently skip the `T`-form row.
    db.load('DE', '2026-08-12T04:30:00', 999);

    const page = readLoad('2026-08-12', '2026-08-13', { limit: 2, after: '2026-08-12 04:00:00' });
    expect(page.rows.map((row) => row.timestamp)).toEqual([
      '2026-08-12T04:30:00Z',
      '2026-08-12T05:00:00Z',
    ]);
  });
});
