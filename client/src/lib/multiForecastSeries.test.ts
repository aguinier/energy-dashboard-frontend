import { describe, it, expect } from 'vitest';
import { buildMultiForecastSeries } from './multiForecastSeries';
import type { MultiForecastEntry } from './multiForecastSeries';

const NOW = new Date('2026-08-11T10:00:00Z');

function actualPoint(timestamp: string, load: number) {
  return { timestamp, load };
}

describe('buildMultiForecastSeries', () => {
  const ACTUAL = [actualPoint('2026-08-11T00:00:00Z', 100), actualPoint('2026-08-11T01:00:00Z', 110)];

  it('draws one entry per model, each under its own key in forecasts', () => {
    const catboost: MultiForecastEntry = {
      id: 'catboost',
      label: 'able-ml · catboost',
      color: '#2C8A6B',
      dash: '8 3',
      points: [{ timestamp: '2026-08-11T00:00:00Z', value: 90 }],
    };
    const xgboost: MultiForecastEntry = {
      id: 'xgboost',
      label: 'able-ml · xgboost',
      color: '#756BB1',
      dash: '2 2',
      points: [{ timestamp: '2026-08-11T00:00:00Z', value: 95 }],
    };

    const { series, forecastSeries } = buildMultiForecastSeries({
      actual: ACTUAL,
      actualValue: (p) => p.load,
      entries: [catboost, xgboost],
      countryLabel: 'France',
      now: NOW,
    });

    expect(forecastSeries.map((s) => s.id)).toEqual(['catboost', 'xgboost']);
    expect(forecastSeries.every((s) => s.covered)).toBe(true);
    const p0 = series.find((p) => p.ts === '2026-08-11T00:00:00.000Z')!;
    expect(p0.value).toBe(100);
    expect(p0.forecasts).toEqual({ catboost: 90, xgboost: 95 });
  });

  // The acceptance case: catboost and xgboost cover near-disjoint country
  // sets. Selecting both for a country only one of them forecasts must still
  // draw the covered one and name the other as absent — not drop it silently.
  it('marks a selected model with zero rows as not covered, naming the country, without dropping the covered one', () => {
    const catboost: MultiForecastEntry = {
      id: 'catboost',
      label: 'able-ml · catboost',
      color: '#2C8A6B',
      dash: '8 3',
      points: [],
    };
    const xgboost: MultiForecastEntry = {
      id: 'xgboost',
      label: 'able-ml · xgboost',
      color: '#756BB1',
      dash: '2 2',
      points: [{ timestamp: '2026-08-11T00:00:00Z', value: 95 }],
    };

    const { series, forecastSeries } = buildMultiForecastSeries({
      actual: ACTUAL,
      actualValue: (p) => p.load,
      entries: [catboost, xgboost],
      countryLabel: 'France',
      now: NOW,
    });

    expect(forecastSeries).toEqual([
      { id: 'catboost', label: 'able-ml · catboost', color: '#2C8A6B', dash: '8 3', covered: false, coverageNote: 'Not available in France' },
      { id: 'xgboost', label: 'able-ml · xgboost', color: '#756BB1', dash: '2 2', covered: true, coverageNote: undefined },
    ]);
    const p0 = series.find((p) => p.ts === '2026-08-11T00:00:00.000Z')!;
    expect(p0.forecasts).toEqual({ xgboost: 95 });
  });

  it('treats a model whose query has not resolved yet as covered, not as a gap', () => {
    const stillLoading: MultiForecastEntry = {
      id: 'catboost',
      label: 'able-ml · catboost',
      color: '#2C8A6B',
      dash: '8 3',
      points: undefined,
    };
    const ready: MultiForecastEntry = {
      id: 'xgboost',
      label: 'able-ml · xgboost',
      color: '#756BB1',
      dash: '2 2',
      points: [{ timestamp: '2026-08-11T00:00:00Z', value: 95 }],
    };

    const { forecastSeries } = buildMultiForecastSeries({
      actual: ACTUAL,
      actualValue: (p) => p.load,
      entries: [stillLoading, ready],
      countryLabel: 'France',
      now: NOW,
    });

    expect(forecastSeries.find((s) => s.id === 'catboost')).toMatchObject({ covered: true, coverageNote: undefined });
  });

  it('draws a band only when exactly one model is selected — a mixed ml+tso selection', () => {
    const tsoD7: MultiForecastEntry = {
      id: 'tso-d7',
      label: 'ENTSO-E TSO · D+7',
      color: '#8E3D2C',
      dash: '6 2',
      points: [{ timestamp: '2026-08-11T00:00:00Z', value: 100, min: 80, max: 120 }],
    };

    const solo = buildMultiForecastSeries({
      actual: ACTUAL,
      actualValue: (p) => p.load,
      entries: [tsoD7],
      countryLabel: 'Germany',
      now: NOW,
    });
    const p0Solo = solo.series.find((p) => p.ts === '2026-08-11T00:00:00.000Z')!;
    expect(p0Solo.min).toBe(80);
    expect(p0Solo.max).toBe(120);

    const catboost: MultiForecastEntry = {
      id: 'catboost',
      label: 'able-ml · catboost',
      color: '#2C8A6B',
      dash: '8 3',
      points: [{ timestamp: '2026-08-11T00:00:00Z', value: 90 }],
    };
    const mixed = buildMultiForecastSeries({
      actual: ACTUAL,
      actualValue: (p) => p.load,
      entries: [catboost, tsoD7],
      countryLabel: 'Germany',
      now: NOW,
    });
    const p0Mixed = mixed.series.find((p) => p.ts === '2026-08-11T00:00:00.000Z')!;
    expect(p0Mixed.min).toBeUndefined();
    expect(p0Mixed.max).toBeUndefined();
    expect(p0Mixed.forecasts).toEqual({ catboost: 90, 'tso-d7': 100 });
  });

  it('bounds the grid to the given window rather than the full fetched range', () => {
    const catboost: MultiForecastEntry = {
      id: 'catboost',
      label: 'able-ml · catboost',
      color: '#2C8A6B',
      dash: '8 3',
      points: [{ timestamp: '2026-08-12T00:00:00Z', value: 90 }],
    };
    const { series } = buildMultiForecastSeries({
      actual: ACTUAL,
      actualValue: (p) => p.load,
      entries: [catboost],
      countryLabel: 'France',
      window: { start: new Date('2026-08-11T00:00:00Z'), end: new Date('2026-08-11T01:00:00Z') },
      now: NOW,
    });
    expect(series.every((p) => new Date(p.ts).getTime() <= new Date('2026-08-11T01:00:00Z').getTime())).toBe(true);
  });

  it('returns an empty series when there is nothing at all', () => {
    expect(
      buildMultiForecastSeries({ actual: [], actualValue: () => null, entries: [], countryLabel: 'France' }),
    ).toEqual({ series: [], nowIndex: 0, forecastSeries: [] });
  });
});

// ABL-501 — "empty" has two causes and they get two legends.
describe('buildMultiForecastSeries — withheld entries', () => {
  const ACTUAL = [actualPoint('2026-08-11T00:00:00Z', 100), actualPoint('2026-08-11T01:00:00Z', 110)];
  const base = { id: 'catboost', label: 'able-ml · catboost', color: '#2C8A6B', dash: '8 3' };

  const build = (entries: MultiForecastEntry[]) =>
    buildMultiForecastSeries({
      actual: ACTUAL,
      actualValue: (p) => p.load,
      entries,
      countryLabel: 'the Netherlands',
      now: NOW,
    });

  it('marks a withheld entry uncovered with its own wording', () => {
    const { forecastSeries } = build([{ ...base, points: [], withheldNote: 'Withheld — different basis' }]);
    expect(forecastSeries[0].covered).toBe(false);
    expect(forecastSeries[0].coverageNote).toBe('Withheld — different basis');
  });

  it('never labels a withheld entry "Not available in <country>"', () => {
    // That copy is for a coverage gap. Here the rows exist and the server is
    // declining to serve them, so the sentence would be false.
    const { forecastSeries } = build([{ ...base, points: [], withheldNote: 'Withheld — different basis' }]);
    expect(forecastSeries[0].coverageNote).not.toContain('Not available');
  });

  it('is uncovered even if rows somehow arrive alongside the note', () => {
    // Belt and braces: the server sends no rows with a withheld verdict, but
    // if the two ever disagreed the verdict has to win — drawing the line is
    // the failure this whole rule exists to stop.
    const { forecastSeries, series } = build([
      { ...base, points: [{ timestamp: '2026-08-11T00:00:00Z', value: 9400 }], withheldNote: 'Withheld — different basis' },
    ]);
    expect(forecastSeries[0].covered).toBe(false);
    expect(series.every((p) => p.forecasts?.catboost == null)).toBe(true);
  });

  it('leaves an ordinary uncovered entry on the existing wording', () => {
    const { forecastSeries } = build([{ ...base, points: [] }]);
    expect(forecastSeries[0].covered).toBe(false);
    expect(forecastSeries[0].coverageNote).toBe('Not available in the Netherlands');
  });

  it('leaves a covered entry untouched', () => {
    const { forecastSeries } = build([
      { ...base, points: [{ timestamp: '2026-08-11T00:00:00Z', value: 90 }], withheldNote: null },
    ]);
    expect(forecastSeries[0].covered).toBe(true);
    expect(forecastSeries[0].coverageNote).toBeUndefined();
  });
});
