import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildFixtureDb, NEXT_DAY, WINDOW } from '../test/fixtureDb.js';
import { rangeArgs, timestampRange } from '../utils/timestamp.js';
import { DIVERGENT_LOAD_BASIS } from './loadForecastBasis.js';

const fixtureDb = buildFixtureDb();
vi.mock('../config/database.js', () => ({ default: fixtureDb }));
vi.mock('./readQueryWorker.js', () => ({ runReadQueryInWorker: vi.fn() }));

const { crossCountryMetricsSql, VALID_FORECAST_TYPES, wape, getCrossCountryMetrics } =
  await import('./crossCountryMetricsService.js');

// The `wape` cases moved to `wape.test.ts` when ABL-388 extracted the function
// into its own pure module — they needed a fixture database built before they
// could import a piece of arithmetic. What is still this file's business is
// that the re-export survives: this is where callers have imported it from
// since ABL-19.
describe('wape re-export', () => {
  it('still resolves through crossCountryMetricsService', () => {
    expect(wape([{ actual: 100, forecast: 90 }])).toBe(10);
  });
});

describe('cross-country metrics query plan', () => {
  it('materializes latest forecast vintages in one forecast-table pass', () => {
    fixtureDb.exec(`
      CREATE INDEX idx_forecasts_lookup
        ON forecasts(country_code, forecast_type, target_timestamp_utc);
      CREATE INDEX idx_load_country_time
        ON energy_load(country_code, timestamp_utc);
      CREATE INDEX idx_price_country_time
        ON energy_price(country_code, timestamp_utc);
      CREATE INDEX idx_renewable_country_time
        ON energy_renewable(country_code, timestamp_utc);
    `);

    const detail = fixtureDb
      .prepare(`EXPLAIN QUERY PLAN ${crossCountryMetricsSql(VALID_FORECAST_TYPES)}`)
      .all(...rangeArgs(timestampRange(WINDOW.start, WINDOW.end)))
      .map((row) => (row as { detail: string }).detail);

    const forecastPasses = detail.filter((line) => /^(?:SCAN|SEARCH) forecasts USING (?:COVERING )?INDEX/.test(line));
    expect(forecastPasses, detail.join('\n')).toHaveLength(1);
    expect(detail.some((line) => line.includes('CORRELATED SCALAR SUBQUERY'))).toBe(false);
    expect(detail).toContain('MATERIALIZE latest_keys');
    expect(detail).toContain('MATERIALIZE latest_forecasts');
  });
});

describe('skill vs seasonal-naive (ABL-186)', () => {
  // AT load is not part of the shared fixture's D-7 window (2026-06-24) — seeded
  // once here, in a single beforeAll, so every `it` below reads one consistent
  // dataset rather than risking duplicate rows from re-seeding per test. AT's
  // WINDOW actual is 600/620/640/660 against an xgboost forecast of
  // 540/560/580/600 (error 60 flat, WAPE 9.52 — see crossCountryComparison.test.ts).
  //
  // Hour 0's D-7 reading is seeded as an impossible-zero placeholder (the same
  // shape ABL-35/ABL-50 guard against on the actuals side) and must drop out of
  // the baseline intersection rather than join as `load_mw: 0`. Hours 1-3 are a
  // real D-7 baseline, 10 MW off the actual at every hour.
  beforeAll(() => {
    fixtureDb.exec(`
      INSERT INTO energy_load (country_code, timestamp_utc, load_mw) VALUES
        ('AT', '2026-06-24 00:00:00', 0),
        ('AT', '2026-06-24 01:00:00', 610),
        ('AT', '2026-06-24 02:00:00', 630),
        ('AT', '2026-06-24 03:00:00', 650);
    `);
  });

  it('drops an impossible-zero D-7 reading from the intersection rather than joining it as a real baseline', () => {
    const result = getCrossCountryMetrics('load', WINDOW.start, WINDOW.end);
    expect(result.AT.wape).toBe(9.52);
    // Only 3 of the 4 hours have a usable D-7 baseline.
    expect(result.AT.skillVsSeasonalNaive.n).toBe(3);
    expect(result.AT.skillVsSeasonalNaive.n).toBeLessThanOrEqual(result.AT.dataPoints);
  });

  it('scores skill on that intersection, and renders a loss as a negative number', () => {
    const result = getCrossCountryMetrics('load', WINDOW.start, WINDOW.end);
    // Over hours 1-3: actual 620/640/660 (sum 1920), model error 60 flat (sum
    // 180, WAPE 9.375), D-7 baseline error 10 flat (sum 30, WAPE 1.5625).
    // skill = 100*(1 - 9.375/1.5625) = -500 — a forecast six times worse than
    // "the same hour last week", not a small or neutral number.
    expect(result.AT.skillVsSeasonalNaive).toEqual({ n: 3, skillPct: -500, baselineWape: 1.56 });
  });

  it('is insufficient data, not a misleading zero, when no D-7 actual exists', () => {
    // DE has WAPE-measurable rows in WINDOW but nothing seven days earlier
    // anywhere in the fixture.
    const result = getCrossCountryMetrics('load', WINDOW.start, WINDOW.end);
    expect(result.DE.wape).not.toBeNull();
    expect(result.DE.skillVsSeasonalNaive).toEqual({ n: 0, skillPct: null, baselineWape: null });
  });
});

describe('divergent load basis (ABL-493)', () => {
  // NL's fixture shape is described in fixtureDb.ts: realized 900/700/500/300
  // on NEXT_DAY against a forecast 300 MW high at every hour, with a D-7
  // baseline 100 MW under realized. Unsuppressed that is mae 300, wape 50,
  // rmse 300, bias -300 and a skill of -200% over 4 pairs — every figure
  // arithmetically correct, and none of them forecast error.
  const nlLoad = () => getCrossCountryMetrics('load', NEXT_DAY.start, NEXT_DAY.end).NL;

  it('withholds every error measure, including the two the TSO path never had', () => {
    const nl = nlLoad();
    expect(nl.mae).toBeNull();
    expect(nl.wape).toBeNull();
    expect(nl.rmse).toBeNull();
    // `bias` is the field this endpoint publishes and `/tso-forecast/*` does
    // not, so calling the existing helper unchanged would have left it
    // standing. It is also the most actionable-looking of the four: -300 MW
    // reads as a systematic over-forecast a TSO could correct, when it is the
    // behind-the-meter solar the two series disagree about.
    expect(nl.bias).toBeNull();
  });

  it('keeps dataPoints truthful — this is "not attributable", not "no data"', () => {
    // Zeroing it would assert we hold nothing, when we hold both series in
    // full. Same distinction `degenerate_zero` draws against `no_actuals`.
    expect(nlLoad().dataPoints).toBe(4);
  });

  it('drops skillPct and keeps the baseline WAPE, which is realized-vs-realized', () => {
    const skill = nlLoad().skillVsSeasonalNaive;
    // Without the rule this reads -200: "six times worse than the same hour
    // last week", rendered as a loss badge. It divides by the contaminated
    // model WAPE, so it goes.
    expect(skill.skillPct).toBeNull();
    // The baseline compares realized against realized seven days earlier —
    // both terms out of `energy_load`, both net of behind-the-meter solar — so
    // it survives. 100 * 400 / 2400.
    expect(skill.baselineWape).toBe(16.67);
    expect(skill.n).toBe(4);
  });

  it('carries the reason, so the numbers are replaced rather than merely absent', () => {
    const nl = nlLoad();
    expect(nl.basis).toBe('divergent_basis');
    expect(nl.basisNote).toBe(DIVERGENT_LOAD_BASIS.NL.reason);
    // Never "no data": we hold both series in full.
    expect(nl.basisNote).not.toMatch(/no data|missing|unavailable/i);
  });

  it('leaves the same country\'s OTHER forecast types alone', () => {
    // The finding is about NL's load pair. Nothing has been established about
    // its price pair, and blanking it would be the same false claim pointed
    // the other way. Generation-side divergence is ABL-400, deliberately not
    // folded in here.
    const nlPrice = getCrossCountryMetrics('price', NEXT_DAY.start, NEXT_DAY.end).NL;
    expect(nlPrice).toEqual({
      mae: 5,
      wape: 7.69,
      rmse: 5,
      bias: -5,
      dataPoints: 4,
      skillVsSeasonalNaive: { n: 0, skillPct: null, baselineWape: null },
    });
    expect(nlPrice).not.toHaveProperty('basis');
    expect(nlPrice).not.toHaveProperty('basisNote');
  });

  it('leaves every other country byte-identical — no basis key at all', () => {
    // A comparable entry must be indistinguishable from its pre-ABL-493 shape.
    // Stamping `basis: 'comparable'` across 8 types x 34 countries to record
    // one finding would cost the cheapest check on a change like this: diff
    // the payload and confirm nothing moved but the country named.
    const all = getCrossCountryMetrics('load', WINDOW.start, WINDOW.end);
    for (const [country, entry] of Object.entries(all)) {
      expect(entry, country).not.toHaveProperty('basis');
      expect(entry, country).not.toHaveProperty('basisNote');
      expect(entry.mae, country).not.toBeNull();
    }
    expect(Object.keys(all)).toContain('DE');
  });

  it('is driven off the registry, not off a hardcoded country code', () => {
    // ABL-283's pending BA/MK/MD/LT/EE/IE work has to flow through by adding a
    // registry entry, with no change here.
    const registered = Object.keys(DIVERGENT_LOAD_BASIS);
    expect(registered).toContain('NL');
    const suppressed = Object.entries(getCrossCountryMetrics('load', NEXT_DAY.start, NEXT_DAY.end))
      .filter(([, entry]) => entry.basis === 'divergent_basis')
      .map(([country]) => country);
    expect(suppressed).toEqual(registered.filter((cc) => cc === 'NL'));
  });
});

describe('separator-agnostic actuals + D-7 baseline join (ABL-214)', () => {
  // Neither country is in the shared fixture's base seed.
  beforeAll(() => {
    fixtureDb.exec(`
      -- PL: the actual AND its D-7 baseline exist ONLY in 'T' form — the
      -- genuinely dropped case for both joins in metricSelect().
      INSERT INTO energy_load (country_code, timestamp_utc, load_mw)
        VALUES ('PL', '2026-07-01T00:00:00', 700), ('PL', '2026-06-24T00:00:00', 690);
      INSERT INTO forecasts
        (country_code, forecast_type, target_timestamp_utc, generated_at, horizon_hours, forecast_value, model_name, model_version)
        VALUES ('PL', 'load', '2026-07-01T00:00:00', '2026-06-30T18:00:00.000000', 6, 650, 'catboost', 'v1');

      -- CZ: a genuine ABL-211/ABL-215 conflict on the actual side — both forms
      -- exist with different values (900 space, 999 'T'). Must score against
      -- exactly one row (the space-form 900), never both.
      --
      -- This was NL until ABL-493, and had to move: NL is the registered
      -- divergent-basis country, so its load measures are now withheld and the
      -- assertion below -- mae is 50 and not the 99.5 a fan-out would give --
      -- has no number to make. The country carrying a *value* property must be
      -- one with no finding against it. dataPoints alone would not do: a
      -- fan-out is visible in it, but the wrong-value half of the defect is
      -- not.
      INSERT INTO energy_load (country_code, timestamp_utc, load_mw)
        VALUES ('CZ', '2026-07-01 01:00:00', 900), ('CZ', '2026-07-01T01:00:00', 999);
      INSERT INTO forecasts
        (country_code, forecast_type, target_timestamp_utc, generated_at, horizon_hours, forecast_value, model_name, model_version)
        VALUES ('CZ', 'load', '2026-07-01T01:00:00', '2026-06-30T18:00:00.000000', 6, 850, 'catboost', 'v1');
    `);
  });

  it('rescues a T-form-only actual into the WAPE, and a T-form-only D-7 baseline into skill', () => {
    const result = getCrossCountryMetrics('load', WINDOW.start, WINDOW.end);
    expect(result.PL.dataPoints).toBe(1);
    expect(result.PL.mae).toBe(50); // |700 - 650|
    expect(result.PL.skillVsSeasonalNaive.n).toBe(1); // D-7 baseline (690) resolved via the 'T'-only fallback
  });

  it('never fans out on a conflicting T/space actual pair — one data point, the space-form value', () => {
    const result = getCrossCountryMetrics('load', WINDOW.start, WINDOW.end);
    // A naive `actual IN (spaceForm, tForm)` join would double this to 2.
    expect(result.CZ.dataPoints).toBe(1);
    expect(result.CZ.mae).toBe(50); // |900 - 850|, not |999 - 850|
  });
});
