import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';

// The module under test imports the shared connection, which opens a real
// SQLite file at import time. getSolarCoverage always receives its own handle
// in these tests via the optional `db` parameter, so the default export just
// needs to not exist - same arrangement as generationService.test.ts.
vi.mock('../config/database.js', () => ({ default: null }));

const {
  classifySolarCoverage,
  coverageWindowStart,
  getSolarCoverage,
  COVERAGE_REFERENCE_DAYS,
  MIN_COVERAGE_PAIRS,
  MIN_COVERAGE_SUM_MW,
  PARTIAL_COVERAGE_RATIO,
} = await import('./solarCoverage.js');

// Sums shaped the way SOLAR_COVERAGE_SQL returns them.
const sums = (pairs: number, forecast: number | null, actual: number | null) => ({
  pairs,
  forecast_sum: forecast,
  actual_sum: actual,
});

describe('classifySolarCoverage', () => {
  it('calls a country whose forecast and actuals agree consistent', () => {
    // DE as measured on the replica: 8,692 pairs, ratio 1.00.
    const c = classifySolarCoverage(sums(8692, 140_485_000, 140_034_000));

    expect(c.verdict).toBe('consistent');
    expect(c.ratio).toBe(1);
    expect(c.referenceDays).toBe(COVERAGE_REFERENCE_DAYS);
  });

  it('calls NL a partial subset', () => {
    // NL as measured on the replica 2026-08-12: 8,693 pairs, 12,447,625 MW of
    // forecast against 731,416 MW of actuals over the same hours.
    const c = classifySolarCoverage(sums(8693, 12_447_625, 731_416));

    expect(c.verdict).toBe('partial_subset');
    expect(c.ratio).toBe(17);
    expect(c.pairs).toBe(8693);
  });

  it('leaves the widest genuine forecast bias in Europe alone', () => {
    // RO is the worst honest case in the measured field at 1.29, and GR at
    // 1.21. Both are forecast bias, not a coverage defect, and neither may
    // trip the caveat - a false partial-coverage warning on a sound series is
    // its own wrong number.
    for (const ratio of [1.29, 1.21, 1.09, 0.95]) {
      const c = classifySolarCoverage(sums(8000, 1_000_000 * ratio, 1_000_000));
      expect(c.verdict).toBe('consistent');
    }
  });

  it('sits in an empty band between the honest field and NL', () => {
    // Every threshold between ~1.5 and ~15 selects the same set. Pin that the
    // chosen one has real headroom on both sides rather than being tuned to
    // the single observation it has to catch.
    expect(PARTIAL_COVERAGE_RATIO).toBeGreaterThan(1.29 * 2);
    expect(PARTIAL_COVERAGE_RATIO).toBeLessThan(17 / 5);
  });

  it('answers unknown, not consistent, when there are too few paired hours', () => {
    // "We could not check" must never render as a clean bill of health.
    const c = classifySolarCoverage(sums(MIN_COVERAGE_PAIRS - 1, 12_447_625, 731_416));

    expect(c.verdict).toBe('unknown');
    expect(c.ratio).toBeNull();
  });

  it('answers unknown, not consistent, for a country with no solar forecast to check against', () => {
    // NO, exactly as measured: 8,691 paired hours, a day-ahead solar forecast
    // summing to 0.0 MW, and 15,257 MW of actuals. The trap is that a naive
    // ratio here is 0 - which is under the threshold, so the series would be
    // pronounced `consistent` on the strength of a reference that does not
    // exist. Absence of a forecast is not evidence the actuals are whole.
    const c = classifySolarCoverage(sums(8691, 0, 15_257));

    expect(c.verdict).toBe('unknown');
    expect(c.ratio).toBeNull();
  });

  it('still checks the country with the smallest genuine forecast in Europe', () => {
    // The bar above must not silently swallow small-but-real solar countries.
    // SK is the lowest genuine forecast sum measured (915,079 MW over 8,580
    // pairs) and sits five orders of magnitude clear of NO's zero.
    const c = classifySolarCoverage(sums(8580, 915_079, 949_064));

    expect(c.verdict).toBe('consistent');
  });

  it('does not claim partial coverage when the actuals are a dead zero series', () => {
    // BA as measured on the replica: 2,172 paired hours, 157,667 MW of
    // day-ahead forecast, and actuals of exactly 0.0 at every hour since
    // 2026-04-13. That is a feed emitting zeros, not a metered subset, and the
    // partial-coverage wording would be actively wrong about it - it blames
    // behind-the-meter generation for what is a false number. Filed as its own
    // issue; this rule declines to answer.
    const c = classifySolarCoverage(sums(2172, 157_667, 0));

    expect(c.verdict).toBe('unknown');
  });

  it('never yields a partial verdict without a finite ratio to justify it', () => {
    // The invariant the client note relies on: no Infinity, no null ratio
    // riding along with a partial_subset verdict.
    const cases = [
      sums(8693, 12_447_625, 731_416),
      sums(2172, 157_667, 0),
      sums(8691, 0, 15_257),
      sums(100, 12_447_625, 731_416),
      sums(0, null, null),
    ];

    for (const s of cases) {
      const c = classifySolarCoverage(s);
      if (c.verdict === 'partial_subset') {
        expect(c.ratio).not.toBeNull();
        expect(Number.isFinite(c.ratio!)).toBe(true);
      }
    }
  });

  it('answers unknown when the forecast side does not clear the evidence bar', () => {
    const c = classifySolarCoverage(sums(8000, MIN_COVERAGE_SUM_MW - 1, 5_000_000));

    expect(c.verdict).toBe('unknown');
  });

  it('survives a row with null sums', () => {
    // SUM() over an empty join returns NULL, not 0.
    const c = classifySolarCoverage(sums(0, null, null));

    expect(c.verdict).toBe('unknown');
    expect(c.forecastSumMw).toBe(0);
    expect(c.actualSumMw).toBe(0);
  });
});

describe('coverageWindowStart', () => {
  it('looks back exactly COVERAGE_REFERENCE_DAYS in the stored timestamp form', () => {
    // Fixed instant, not the wall clock - the bound must be reproducible.
    expect(coverageWindowStart(new Date('2026-08-12T13:00:00Z'))).toBe('2026-05-14 13:00:00');
  });
});

describe('getSolarCoverage', () => {
  function fixture() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE energy_generation (
        country_code TEXT NOT NULL,
        timestamp_utc TIMESTAMP NOT NULL,
        solar_mw REAL
      );
      CREATE TABLE energy_generation_forecast (
        country_code TEXT NOT NULL,
        target_timestamp_utc TIMESTAMP NOT NULL,
        solar_mw REAL
      );
    `);
    return db;
  }

  const NOW = new Date('2026-08-12T00:00:00Z');

  function seed(db: Database.Database, cc: string, hours: number, forecastMw: number, actualMw: number | null) {
    const g = db.prepare('INSERT INTO energy_generation (country_code, timestamp_utc, solar_mw) VALUES (?, ?, ?)');
    const f = db.prepare(
      'INSERT INTO energy_generation_forecast (country_code, target_timestamp_utc, solar_mw) VALUES (?, ?, ?)'
    );
    for (let h = 0; h < hours; h++) {
      const ts = new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      g.run(cc, ts, actualMw);
      f.run(cc, ts, forecastMw);
    }
  }

  it('pairs the two tables on country and hour and returns the verdict', () => {
    const db = fixture();
    // 2,000 hours at 400 MW forecast against 20 MW actual - a 20x subset.
    seed(db, 'NL', 2000, 400, 20);

    const c = getSolarCoverage('NL', db, NOW);

    expect(c.pairs).toBe(2000);
    expect(c.ratio).toBe(20);
    expect(c.verdict).toBe('partial_subset');
  });

  it('upcases the country code', () => {
    const db = fixture();
    seed(db, 'NL', 2000, 400, 20);

    expect(getSolarCoverage('nl', db, NOW).verdict).toBe('partial_subset');
  });

  it('ignores hours outside the reference window', () => {
    const db = fixture();
    // 2,000 hours is ~83 days, inside the 90-day window; push the whole block
    // back a year and nothing should pair.
    const old = new Date(NOW.getTime() - 365 * 24 * 60 * 60 * 1000);
    const g = db.prepare('INSERT INTO energy_generation (country_code, timestamp_utc, solar_mw) VALUES (?, ?, ?)');
    const f = db.prepare(
      'INSERT INTO energy_generation_forecast (country_code, target_timestamp_utc, solar_mw) VALUES (?, ?, ?)'
    );
    for (let h = 0; h < 2000; h++) {
      const ts = new Date(old.getTime() - h * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      g.run('NL', ts, 20);
      f.run('NL', ts, 400);
    }

    expect(getSolarCoverage('NL', db, NOW).verdict).toBe('unknown');
  });

  it('does not let an unpaired hour manufacture a discrepancy', () => {
    const db = fixture();
    // Actuals null at every hour: the join keeps the rows, the IS NOT NULL
    // guard drops them, and nothing is compared. A null is "not reported" -
    // read as a zero on the actual side it would read as total non-coverage.
    seed(db, 'NL', 2000, 400, null);

    const c = getSolarCoverage('NL', db, NOW);

    expect(c.pairs).toBe(0);
    expect(c.verdict).toBe('unknown');
  });

  it('answers unknown for a country with no rows at all', () => {
    expect(getSolarCoverage('XX', fixture(), NOW).verdict).toBe('unknown');
  });

  it('does not pair one country against another', () => {
    const db = fixture();
    seed(db, 'NL', 2000, 400, 20);
    seed(db, 'DE', 2000, 400, 400);

    expect(getSolarCoverage('DE', db, NOW).verdict).toBe('consistent');
    expect(getSolarCoverage('NL', db, NOW).verdict).toBe('partial_subset');
  });
});
