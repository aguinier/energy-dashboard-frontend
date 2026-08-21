import { describe, it, expect, vi } from 'vitest';
import { buildFixtureDb } from '../test/fixtureDb.js';

/**
 * The shared fixture holds four hours per country, which is by design — every
 * shape it encodes is a per-row or per-series defect that four hours can show.
 * A *recommendation* is the one thing four hours cannot show: it exists to be
 * a track record, so the qualification bars in `bestForecastModel.ts` reject a
 * sample that small on purpose.
 *
 * So this file seeds its own multi-week history on top of its own fixture
 * instance rather than widening the shared one, which would move the window
 * every other route test measures against.
 */
const fixtureDb = buildFixtureDb();
vi.mock('../config/database.js', () => ({ default: fixtureDb }));
vi.mock('../config/writeDatabase.js', async () => (await import('../test/noWriteDb.js')).forbidWriteDb());

const { getRecommendedModel, accuracyWindow } = await import('./recommendedModelService.js');
const { getForecastData } = await import('./forecastService.js');

/**
 * `now` for every test here. The 30-day window it implies is 2026-07-03 to
 * 2026-08-02, which contains the seeded history below and deliberately
 * *excludes* the shared fixture's own 2026-07-01/02 rows — otherwise those
 * four hours blend into every count and the expected numbers stop being
 * arithmetic anyone can check.
 */
const NOW = new Date('2026-08-02T00:00:00Z');

/** 2026-07-05 .. 2026-07-29 — 600 of the window's 720 hours, comfortably over the coverage bar. */
const DAYS = Array.from({ length: 25 }, (_, i) => 5 + i);
const HOURS_OF_DAY = Array.from({ length: 24 }, (_, h) => h);

const stamp = (day: number, hour: number, sep = ' ') =>
  `2026-07-${String(day).padStart(2, '0')}${sep}${String(hour).padStart(2, '0')}:00:00`;

/** Realized load — deliberately not flat, so a WAPE has something to weight. */
const actualAt = (day: number, hour: number) => 1000 + hour * 20 + (day % 5) * 30;

const load = fixtureDb.prepare(
  'INSERT INTO energy_load (country_code, timestamp_utc, load_mw) VALUES (?, ?, ?)',
);
const mlForecast = fixtureDb.prepare(
  `INSERT INTO forecasts
     (country_code, forecast_type, target_timestamp_utc, generated_at, horizon_hours, forecast_value, model_name, model_version)
   VALUES (?, ?, ?, '2026-07-01T00:00:00.000000', 12, ?, ?, 'v1')`,
);
const tsoLoadForecast = fixtureDb.prepare(
  `INSERT INTO energy_load_forecast
     (country_code, target_timestamp_utc, forecast_value_mw, forecast_type, forecast_min_mw, forecast_max_mw)
   VALUES (?, ?, ?, ?, NULL, NULL)`,
);

/**
 * Seed a country's realized load plus whichever forecasts the case needs, as a
 * multiplier on the actual — so a 1.10 multiplier really is a ~10% WAPE and
 * the expected ranking is arithmetic rather than a magic number.
 */
function seedLoad(
  country: string,
  opts: { catboost?: number; xgboost?: number; tsoD1?: number; tsoD7?: number },
) {
  for (const day of DAYS) {
    for (const hour of HOURS_OF_DAY) {
      const actual = actualAt(day, hour);
      load.run(country, stamp(day, hour), actual);
      if (opts.catboost) mlForecast.run(country, 'load', stamp(day, hour, 'T'), actual * opts.catboost, 'catboost');
      if (opts.xgboost) mlForecast.run(country, 'load', stamp(day, hour, 'T'), actual * opts.xgboost, 'xgboost');
      if (opts.tsoD1) tsoLoadForecast.run(country, stamp(day, hour), actual * opts.tsoD1, 'day_ahead');
      // ENTSO-E week-ahead publishes one value per day, at noon. That is the
      // whole reason the coverage bar is counted in hours: 25 points over a
      // 720-hour window is 3.5% of it.
      if (opts.tsoD7 && hour === 12) {
        tsoLoadForecast.run(country, stamp(day, hour), actual * opts.tsoD7, 'week_ahead');
      }
    }
  }
}

// DE — the Board's case: the ENTSO-E day-ahead series beats ours. Mirrors the
// replica measurement (catboost 6.75% WAPE vs TSO D+1 3.45% over 30 days).
seedLoad('DE', { catboost: 1.1, tsoD1: 1.03, tsoD7: 1.2 });
// FR — ours wins, so nothing should move.
seedLoad('FR', { xgboost: 1.02, tsoD1: 1.09 });
// NL — the TSO series pairs perfectly and is still not a score, because
// realized load and the day-ahead forecast measure different quantities.
seedLoad('NL', { catboost: 1.08, tsoD1: 2.0 });
// GR — a TSO series and no ML forecast at all.
seedLoad('GR', { tsoD1: 1.05 });

describe('accuracyWindow', () => {
  it('is a fixed 30 days back from now, not the window the user is looking at', () => {
    const w = accuracyWindow(NOW);
    expect(w.end).toBe('2026-08-02T00:00:00.000Z');
    expect(w.start).toBe('2026-07-03T00:00:00.000Z');
    expect(w.hours).toBe(720);
  });
});

describe('getRecommendedModel — per (country, forecast type) resolution', () => {
  it('resolves DE load to the ENTSO-E series, because it measures better here', () => {
    const rec = getRecommendedModel('DE', 'load', NOW)!;

    expect(rec.modelId).toBe('tso-d1');
    expect(rec.source).toBe('tso');
    expect(rec.fallback).toBe(false);
    // 3% over-forecast at every hour.
    expect(rec.wape).toBeCloseTo(3, 1);
    expect(rec.dataPoints).toBe(DAYS.length * 24);
  });

  it('resolves FR load to our own model over the same window', () => {
    const rec = getRecommendedModel('FR', 'load', NOW)!;

    expect(rec.modelId).toBe('xgboost');
    expect(rec.source).toBe('ml');
    expect(rec.fallback).toBe(false);
    expect(rec.wape).toBeCloseTo(2, 1);
  });

  it('is genuinely per pair — the same forecast type resolves differently by country', () => {
    expect(getRecommendedModel('DE', 'load', NOW)!.source).toBe('tso');
    expect(getRecommendedModel('FR', 'load', NOW)!.source).toBe('ml');
  });

  it('takes the only measured source when the other has nothing here', () => {
    const rec = getRecommendedModel('GR', 'load', NOW)!;

    expect(rec.modelId).toBe('tso-d1');
    expect(rec.candidates.find((c) => c.id === 'catboost')?.excluded).toBe('no_pairs');
  });

  it('is case-insensitive about the country code', () => {
    expect(getRecommendedModel('de', 'load', NOW)!.modelId).toBe('tso-d1');
  });
});

describe('getRecommendedModel — what it refuses to rank', () => {
  it('excludes a divergent-basis TSO series rather than ranking a definitional gap', () => {
    // NL's realized load is net of behind-the-meter solar and its day-ahead
    // forecast is not (ABL-277). The pairs are real; the difference is not
    // forecast error, so it must not win a comparison — nor lose one.
    const rec = getRecommendedModel('NL', 'load', NOW)!;
    const tso = rec.candidates.find((c) => c.id === 'tso-d1')!;

    expect(tso.excluded).toBe('unmeasurable_wape');
    expect(tso.wape).toBeNull();
    // The point count stays truthful — "not measurable" is not "no data".
    expect(tso.dataPoints).toBe(DAYS.length * 24);
    expect(rec.modelId).toBe('catboost');
    expect(rec.source).toBe('ml');
  });

  it('excludes the week-ahead series, which only publishes at one hour of the day', () => {
    const rec = getRecommendedModel('DE', 'load', NOW)!;
    const d7 = rec.candidates.find((c) => c.id === 'tso-d7')!;

    expect(d7.excluded).toBe('sparse_coverage');
    expect(d7.hoursCovered).toBe(DAYS.length);
    // It is excluded on coverage, not on being wrong — it had a score.
    expect(d7.wape).not.toBeNull();
  });

  it('reports every registered model, so an absence is visible rather than missing', () => {
    const rec = getRecommendedModel('DE', 'load', NOW)!;

    expect(rec.candidates.map((c) => c.id).sort()).toEqual(
      ['catboost', 'tso-d1', 'tso-d7', 'xgboost'].sort(),
    );
    expect(rec.candidates.find((c) => c.id === 'xgboost')?.excluded).toBe('no_pairs');
  });
});

describe('getRecommendedModel — the no-history fallback', () => {
  it('resolves a pair with no accuracy history to the type production model', () => {
    // AT has no seeded history at all: it must render, not blank.
    const rec = getRecommendedModel('AT', 'load', NOW)!;

    expect(rec.modelId).toBe('catboost');
    expect(rec.fallback).toBe(true);
    expect(rec.wape).toBeNull();
    expect(rec.dataPoints).toBe(0);
  });

  it('falls back for a type nothing can score, rather than inventing one', () => {
    // `net_position` has no actuals source, so no ml accuracy path exists and
    // no tso model is registered. Its production model still has to serve.
    const rec = getRecommendedModel('DE', 'net_position', NOW)!;

    expect(rec.modelId).toBe('chronos-2-V010');
    expect(rec.fallback).toBe(true);
    expect(rec.candidates.every((c) => c.excluded !== null)).toBe(true);
  });

  it('never reports a fallback as a measured result', () => {
    const rec = getRecommendedModel('AT', 'load', NOW)!;
    // A `wape: 0` here would read as a flawless forecast for a pair nobody
    // measured — the defect this whole dashboard is built against.
    expect(rec.wape).not.toBe(0);
    expect(rec.wape).toBeNull();
  });

  it('is undefined only for an unregistered forecast type', () => {
    expect(getRecommendedModel('DE', 'not_a_type' as never, NOW)).toBeUndefined();
  });
});

describe('getRecommendedModel — the window it reports', () => {
  it('echoes back exactly the window it measured', () => {
    const rec = getRecommendedModel('DE', 'load', NOW)!;

    expect(rec.windowStart).toBe('2026-07-03T00:00:00.000Z');
    expect(rec.windowEnd).toBe('2026-08-02T00:00:00.000Z');
    expect(rec.windowDays).toBe(30);
  });
});

describe('the recommendation does not reach the serving path', () => {
  // Issue acceptance criterion 5: an explicit `model=` request must keep
  // returning exactly what it returns today, and the unpinned ladder must keep
  // walking. `forecastService` is untouched by this change; this asserts that
  // rather than leaving it to a reading of the diff, on the one pair where the
  // recommendation and the ladder genuinely disagree.
  const SEEDED_WINDOW = { start: '2026-07-10T00:00:00Z', end: '2026-07-10T05:00:00Z' };

  it('serves our ML model unpinned, even where the recommendation is the TSO series', () => {
    expect(getRecommendedModel('DE', 'load', NOW)!.modelId).toBe('tso-d1');

    const rows = getForecastData('DE', 'load', SEEDED_WINDOW.start, SEEDED_WINDOW.end);

    // Still the ladder's answer — production first — not the recommendation's.
    expect(rows.length).toBeGreaterThan(0);
    expect([...new Set(rows.map((r) => r.model_name))]).toEqual(['catboost']);
  });

  it('still honours an explicit model= strictly', () => {
    const rows = getForecastData('FR', 'load', SEEDED_WINDOW.start, SEEDED_WINDOW.end, 'hourly', undefined, 'xgboost');

    expect([...new Set(rows.map((r) => r.model_name))]).toEqual(['xgboost']);
  });

  it('still returns nothing for a model with no rows, rather than substituting', () => {
    // FR is seeded with xgboost only. Asking for catboost gets an empty series,
    // never xgboost's numbers under catboost's name.
    const rows = getForecastData('FR', 'load', SEEDED_WINDOW.start, SEEDED_WINDOW.end, 'hourly', undefined, 'catboost');

    expect(rows).toEqual([]);
  });
});
