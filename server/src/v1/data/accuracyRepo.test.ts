import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createMemoryEnergySource,
  type MemoryEnergySource,
} from './memoryEnergySource.js';
import { countForecastHours, readAccuracyPoints, ACCURACY_TYPE_IDS } from './accuracyRepo.js';
import { parseWindow } from './params.js';

/**
 * The `/v1/accuracy` join, against a real SQLite engine.
 *
 * Every assertion here is a *SQL* claim, which is why this runs against
 * `memoryEnergySource` rather than a stub: the defects it guards are things
 * SQLite does — how it compares `'T'`(84) against `' '`(32), whether a `LEFT
 * JOIN` pair can fan out, whether `NULL` survives a `COALESCE`. A stub returning
 * canned rows would prove none of them.
 *
 * The first block is the one this endpoint was split out of ABL-303 for.
 */

const WINDOW = parseWindow({ from: '2026-08-12', to: '2026-08-13' });

/** `2026-08-12 09:00:00` — the space-separated form the ingest writes today. */
function spaceForm(hour: number): string {
  return `2026-08-12 ${String(hour).padStart(2, '0')}:00:00`;
}

/** `2026-08-12T09:00:00` — the form the 2025-11 cutover left behind. */
function tForm(hour: number): string {
  return `2026-08-12T${String(hour).padStart(2, '0')}:00:00`;
}

let db: MemoryEnergySource;

/** One catboost load forecast for DE at `hour`, from a single vintage. */
function seedForecast(hour: number, value: number, type = 'load'): void {
  db.forecast({
    zone: 'DE',
    type,
    target: tForm(hour),
    generatedAt: '2026-08-12T07:00:00.100000',
    horizonHours: hour,
    value,
    model: 'catboost',
  });
}

function points(type = 'load', horizonHours?: number) {
  return readAccuracyPoints(db, {
    zone: 'DE',
    forecastType: type,
    model: 'catboost',
    window: WINDOW,
    horizonHours,
  });
}

beforeEach(() => {
  db = createMemoryEnergySource();
  db.zones('DE');
});

afterEach(() => {
  db.close();
});

describe('the two-separator join (ABL-214) — the reason this endpoint was split out', () => {
  it('scores a conflicting T/space pair ONCE, not twice', () => {
    // The whole issue, in one assertion. `energy_load` holds 137,113
    // country-hours where both stored forms exist and 107,047 of those pairs
    // hold conflicting values. The naive repair — `actual_col IN
    // (REPLACE(expr,'T',' '), REPLACE(expr,' ','T'))` — matches both rows and
    // hands this metric the right-looking value and the wrong one **as two
    // independent observations**, trading a silent-drop defect for a
    // silent-fan-out one. Two LEFT JOINs and a COALESCE cannot: each side
    // matches at most one physical row, so their combination is at most one.
    seedForecast(9, 45_000);
    db.load('DE', spaceForm(9), 40_000);
    db.load('DE', tForm(9), 50_000); // conflicting twin

    const scored = points();

    expect(scored).toHaveLength(1);
    // Space preferred — the stated convention, published as
    // `meta.conflict_convention`. ABL-215 owns which member is *authoritative*;
    // this asserts only that we serve the one we say we serve.
    expect(scored[0].actual).toBe(40_000);

    // And the counter-proof, on the same rows and the same schema: the naive
    // repair really does fan out. `utils/timestamp.test.ts` shows this on a
    // synthetic pair of tables; this shows it on `energy_load` and `forecasts`
    // as they are actually shaped, which is the claim the issue makes.
    const naive = db.all<{ actual: number }>(
      `SELECT a.load_mw AS actual
         FROM forecasts f
         JOIN energy_load a
           ON a.country_code = f.country_code
          AND a.timestamp_utc IN (
                REPLACE(f.target_timestamp_utc, 'T', ' '),
                REPLACE(f.target_timestamp_utc, ' ', 'T')
              )
        WHERE f.country_code = 'DE' AND f.forecast_type = 'load'`
    );
    expect(naive).toHaveLength(2);
    // Both members of the pair, offered to the metric as independent
    // observations. One of them is wrong and nothing in the result says which.
    expect(naive.map((row) => row.actual).sort()).toEqual([40_000, 50_000]);
  });

  it('keeps an index seek on both sides of the pair', () => {
    // The shape is only affordable because `actualCol` stays bare on both joins.
    // Wrapping it in `REPLACE` would also be correct and did not complete in
    // 120s on a 3.0M x 811k join — the same class of change as the 51s scar in
    // CLAUDE.md's Common Issues.
    seedForecast(9, 45_000);
    db.load('DE', spaceForm(9), 40_000);

    const plan = db
      .all<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT COALESCE(a.load_mw, a2.load_mw)
           FROM forecasts f
           LEFT JOIN energy_load a
             ON a.country_code = 'DE' AND a.timestamp_utc = REPLACE(f.target_timestamp_utc, 'T', ' ')
           LEFT JOIN energy_load a2
             ON a2.country_code = 'DE' AND a2.timestamp_utc = REPLACE(f.target_timestamp_utc, ' ', 'T')`
      )
      .map((row) => row.detail)
      .join(' ');

    expect(plan).toMatch(
      /SEARCH a USING (COVERING )?INDEX idx_load_country_time \(country_code=\? AND timestamp_utc=\?\)/
    );
    expect(plan).toMatch(
      /SEARCH a2 USING (COVERING )?INDEX idx_load_country_time \(country_code=\? AND timestamp_utc=\?\)/
    );
  });

  it('pairs an hour whose only stored actual is T-form — the drop ABL-214 is named for', () => {
    // The coverage the fix exists to add. A one-sided `REPLACE` join matched the
    // space form only and dropped these silently: no error, no empty state, just
    // a smaller sample than the caller had any way to notice.
    seedForecast(10, 30_000);
    db.load('DE', tForm(10), 31_000);

    expect(points()).toEqual([{ forecast: 30_000, actual: 31_000 }]);
  });

  it('changes nothing for an hour that already matched', () => {
    // The other half of the claim in `timestampFormOnClause`: this shape is
    // additive. A space-form actual is preferred unconditionally, exactly as the
    // one-sided join it replaces did, so no currently-scored hour moves.
    seedForecast(11, 20_000);
    db.load('DE', spaceForm(11), 21_000);

    expect(points()).toEqual([{ forecast: 20_000, actual: 21_000 }]);
  });

  it('leaves a forecast hour with no actual out of the sample entirely', () => {
    // Never a zero, never carried forward, never interpolated. An unpaired hour
    // is absent — that is what makes `forecast_hours` vs `sample_size` on the
    // response a real ratio rather than a formality.
    seedForecast(12, 25_000);

    expect(points()).toEqual([]);
    expect(countForecastHours(db, {
      zone: 'DE',
      forecastType: 'load',
      model: 'catboost',
      window: WINDOW,
    })).toBe(1);
  });

  it('never pairs a row stored with a trailing UTC offset', () => {
    // The 26,405 length-25 rows (`2025-11-28T00:00:00+02:00`) are two hours from
    // where they belong and `/v1/observations` refuses to serve them. They are
    // excluded here by construction rather than by a predicate: both join
    // clauses test equality against a length-19 value, which a length-25 string
    // can never equal.
    seedForecast(13, 10_000);
    db.load('DE', '2026-08-12 13:00:00+02:00', 11_000);

    expect(points()).toEqual([]);
  });
});

describe('the load guard is conditional, and must stay that way', () => {
  it('drops an impossible 0.0 load actual', () => {
    // A national grid never draws exactly 0 MW; 543 such rows across 11 zones
    // are the ingest writing a placeholder. Scoring `|forecast - 0|` against one
    // is a 100% error against a number nobody measured.
    seedForecast(14, 40_000);
    db.load('DE', spaceForm(14), 0);

    expect(points()).toEqual([]);
  });

  it('keeps a measured 0.0 for solar, where overnight zero is real', () => {
    // The mirror mistake, and the more expensive one: applying `> 0` across the
    // board would delete real measurements and bias every renewable metric
    // upward. Solar at 03:00 is 0.0 and that IS the measurement.
    seedForecast(3, 12, 'solar');
    db.generation('DE', spaceForm(3), { solar_mw: 0 });

    expect(points('solar')).toEqual([{ forecast: 12, actual: 0 }]);
  });

  it('keeps a genuine zero-clearing price hour', () => {
    seedForecast(15, 4.5, 'price');
    db.price('DE', spaceForm(15), 0);

    expect(points('price')).toEqual([{ forecast: 4.5, actual: 0 }]);
  });

  it('distinguishes an unreported production type from a measured zero', () => {
    // `energy_generation` carries no `DEFAULT 0`, which is what makes this
    // possible at all — and is why the actuals come from it rather than from the
    // frozen `energy_renewable`, where an unreported type is stored as a literal
    // `0.0` and scores a flawless zero error (ABL-353: 477,846 fabricated pairs,
    // 23 countries with a perfect offshore-wind forecast and no offshore wind).
    seedForecast(16, 800, 'wind_offshore');
    db.generation('DE', spaceForm(16), { solar_mw: 5_000 }); // wind_offshore NULL

    expect(points('wind_offshore')).toEqual([]);
  });
});

describe('one vintage per target hour', () => {
  it('scores the newest run, not every run that covered the hour', () => {
    for (const [generatedAt, value] of [
      ['2026-08-12T07:00:00.100000', 100],
      ['2026-08-12T14:00:00.100000', 200],
    ] as const) {
      db.forecast({
        zone: 'DE',
        type: 'load',
        target: tForm(17),
        generatedAt,
        horizonHours: 17,
        value,
        model: 'catboost',
      });
    }
    db.load('DE', spaceForm(17), 150);

    expect(points()).toEqual([{ forecast: 200, actual: 150 }]);
  });

  it('keeps the horizon filter inside the newest-vintage subquery', () => {
    // Without it the subquery finds the newest vintage *overall* and the outer
    // horizon filter then keeps nothing — comparing a 6-hour-ahead run against a
    // 60-hour-ahead one and returning neither consistently.
    db.forecast({
      zone: 'DE', type: 'load', target: tForm(18),
      generatedAt: '2026-08-12T07:00:00.100000', horizonHours: 6, value: 600, model: 'catboost',
    });
    db.forecast({
      zone: 'DE', type: 'load', target: tForm(18),
      generatedAt: '2026-08-12T14:00:00.100000', horizonHours: 60, value: 6_000, model: 'catboost',
    });
    db.load('DE', spaceForm(18), 700);

    expect(points('load', 6)).toEqual([{ forecast: 600, actual: 700 }]);
  });

  it('scores only the requested model', () => {
    // catboost and xgboost cover disjoint zone sets, so "our forecast" is not a
    // measurable thing — "catboost's forecast" is. Reporting one model's numbers
    // under the other's name is the failure this endpoint's label exists to
    // prevent.
    seedForecast(19, 100);
    db.forecast({
      zone: 'DE', type: 'load', target: tForm(19),
      generatedAt: '2026-08-12T14:00:00.100000', horizonHours: 19, value: 999, model: 'xgboost',
    });
    db.load('DE', spaceForm(19), 110);

    expect(points()).toEqual([{ forecast: 100, actual: 110 }]);
  });
});

describe('countForecastHours', () => {
  it('counts one hour once even when the forecast side stores both separators', () => {
    // `forecasts` is 99.7% T-form but the two chronos models write a space, so a
    // bare `COUNT(DISTINCT target_timestamp_utc)` would count one hour twice and
    // understate the pairing rate. The count normalises first, which is what
    // makes it the same number as the deduped join's row count.
    db.forecast({
      zone: 'DE', type: 'load', target: tForm(20),
      generatedAt: '2026-08-12T07:00:00.100000', horizonHours: 20, value: 1, model: 'catboost',
    });
    db.forecast({
      zone: 'DE', type: 'load', target: spaceForm(20),
      generatedAt: '2026-08-12T07:00:00.100000', horizonHours: 20, value: 1, model: 'catboost',
    });

    expect(countForecastHours(db, {
      zone: 'DE', forecastType: 'load', model: 'catboost', window: WINDOW,
    })).toBe(1);
  });

  it('is zero for a model that does not serve this zone', () => {
    seedForecast(21, 100);

    expect(countForecastHours(db, {
      zone: 'DE', forecastType: 'load', model: 'xgboost', window: WINDOW,
    })).toBe(0);
  });
});

describe('the offer', () => {
  it('serves six types, and not the two whose actual is undefined on this table', () => {
    // `hydro_total` and `renewable` are withheld because what their actual *is*
    // on `energy_generation` is ABL-399, not because they are unimportant.
    // `energy_renewable` folded pumping into `hydro_reservoir_mw` — FR
    // 2026-08-01..07 reads 2,014.3 MW there against 1,181.7 MW on
    // `energy_generation` — so scoring a model fit on the first basis against
    // the second measures the difference between two definitions of hydro and
    // reports it as forecast error.
    expect([...ACCURACY_TYPE_IDS].sort()).toEqual([
      'biomass',
      'load',
      'price',
      'solar',
      'wind_offshore',
      'wind_onshore',
    ]);
  });
});
