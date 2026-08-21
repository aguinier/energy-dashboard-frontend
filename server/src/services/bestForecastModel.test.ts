import { describe, it, expect } from 'vitest';
import {
  rankCandidates,
  countHoursCovered,
  hourKey,
  ACCURACY_WINDOW_DAYS,
  MIN_PAIRED_POINTS,
  MIN_WINDOW_HOUR_COVERAGE,
  type MeasuredCandidate,
} from './bestForecastModel.js';

const WINDOW_HOURS = ACCURACY_WINDOW_DAYS * 24;

/** A candidate that clears both bars, so a test only states what it varies. */
function candidate(over: Partial<MeasuredCandidate> & { id: string }): MeasuredCandidate {
  return {
    label: over.id,
    source: 'ml',
    wape: 10,
    dataPoints: 720,
    hoursCovered: 720,
    ...over,
  };
}

describe('rankCandidates — the winner', () => {
  it('picks the lowest WAPE regardless of source', () => {
    // The measured DE load case: our catboost at 6.75 against the ENTSO-E
    // day-ahead series at 3.45 over the same 30 days.
    const { best } = rankCandidates(
      [
        candidate({ id: 'catboost', source: 'ml', wape: 6.75, dataPoints: 721, hoursCovered: 721 }),
        candidate({ id: 'tso-d1', source: 'tso', wape: 3.45, dataPoints: 721, hoursCovered: 721 }),
      ],
      WINDOW_HOURS,
      'catboost',
    );

    expect(best?.id).toBe('tso-d1');
    expect(best?.source).toBe('tso');
  });

  it('leaves our model in place when it wins', () => {
    const { best } = rankCandidates(
      [
        candidate({ id: 'catboost', source: 'ml', wape: 2.1 }),
        candidate({ id: 'tso-d1', source: 'tso', wape: 3.45 }),
      ],
      WINDOW_HOURS,
      'catboost',
    );

    expect(best?.id).toBe('catboost');
  });

  it('does not favour the production model on measurement — only on a tie', () => {
    const { best } = rankCandidates(
      [
        candidate({ id: 'xgboost', wape: 4.0 }),
        candidate({ id: 'catboost', wape: 4.1 }),
      ],
      WINDOW_HOURS,
      'catboost',
    );

    expect(best?.id).toBe('xgboost');
  });

  it('returns null when nothing qualifies', () => {
    const { best } = rankCandidates(
      [candidate({ id: 'catboost', dataPoints: 0, hoursCovered: 0 })],
      WINDOW_HOURS,
      'catboost',
    );

    expect(best).toBeNull();
  });

  it('handles an empty registry without throwing', () => {
    expect(rankCandidates([], WINDOW_HOURS, undefined)).toEqual({ best: null, candidates: [] });
  });
});

describe('rankCandidates — ties leave the incumbent in place', () => {
  it('breaks an equal WAPE on evidence first', () => {
    const { best } = rankCandidates(
      [
        candidate({ id: 'tso-d1', source: 'tso', wape: 5, dataPoints: 400 }),
        candidate({ id: 'catboost', wape: 5, dataPoints: 720 }),
      ],
      WINDOW_HOURS,
      'catboost',
    );

    expect(best?.id).toBe('catboost');
  });

  it('prefers the production model when WAPE and evidence are both equal', () => {
    // A coin-toss flip of the displayed source is worse than either outcome.
    const { best } = rankCandidates(
      [
        candidate({ id: 'tso-d1', source: 'tso', wape: 5 }),
        candidate({ id: 'catboost', wape: 5 }),
      ],
      WINDOW_HOURS,
      'catboost',
    );

    expect(best?.id).toBe('catboost');
  });

  it('falls back to registry order, so the answer never depends on input order', () => {
    const models = [candidate({ id: 'a', wape: 5 }), candidate({ id: 'b', wape: 5 })];

    expect(rankCandidates(models, WINDOW_HOURS, undefined).best?.id).toBe('a');
    expect(rankCandidates([...models].reverse(), WINDOW_HOURS, undefined).best?.id).toBe('b');
  });
});

describe('rankCandidates — qualification bars', () => {
  it('excludes a candidate with no paired points as no_pairs, not as a zero score', () => {
    const { candidates } = rankCandidates(
      [candidate({ id: 'xgboost', wape: null, dataPoints: 0, hoursCovered: 0 })],
      WINDOW_HOURS,
      undefined,
    );

    expect(candidates[0].excluded).toBe('no_pairs');
    expect(candidates[0].wape).toBeNull();
  });

  it('excludes a lucky handful of points', () => {
    const { best, candidates } = rankCandidates(
      [
        candidate({ id: 'lucky', wape: 0.1, dataPoints: MIN_PAIRED_POINTS - 1, hoursCovered: 23 }),
        candidate({ id: 'catboost', wape: 6.75 }),
      ],
      WINDOW_HOURS,
      'catboost',
    );

    expect(best?.id).toBe('catboost');
    expect(candidates.find((c) => c.id === 'lucky')?.excluded).toBe('too_few_points');
  });

  it('admits a candidate exactly on the point floor', () => {
    const { best } = rankCandidates(
      [candidate({ id: 'edge', wape: 3, dataPoints: MIN_PAIRED_POINTS, hoursCovered: WINDOW_HOURS })],
      WINDOW_HOURS,
      undefined,
    );

    expect(best?.id).toBe('edge');
  });

  it('excludes a series that only publishes at one hour of the day', () => {
    // ENTSO-E week-ahead: one value per day at noon. Measured on the replica,
    // DE's D+7 pairs 30 points over 30 days against 721 for the hourly series
    // — 4.2% of the window's hours, so its WAPE answers a narrower question.
    const { best, candidates } = rankCandidates(
      [
        candidate({ id: 'tso-d7', source: 'tso', wape: 1.0, dataPoints: 30, hoursCovered: 30 }),
        candidate({ id: 'tso-d1', source: 'tso', wape: 3.45, dataPoints: 721, hoursCovered: 721 }),
      ],
      WINDOW_HOURS,
      undefined,
    );

    expect(best?.id).toBe('tso-d1');
    expect(candidates.find((c) => c.id === 'tso-d7')?.excluded).toBe('sparse_coverage');
  });

  it('does not penalise a coarser-resolution candidate that still spans the window', () => {
    // The rule that was tried first — a share of the largest point count —
    // gets this wrong: the hourly ML model has a quarter of the 15-minute TSO
    // series' points and identical coverage.
    const { best } = rankCandidates(
      [
        candidate({ id: 'catboost', wape: 6.75, dataPoints: 721, hoursCovered: 721 }),
        candidate({ id: 'tso-d1', source: 'tso', wape: 9.0, dataPoints: 2881, hoursCovered: 721 }),
      ],
      WINDOW_HOURS,
      'catboost',
    );

    expect(best?.id).toBe('catboost');
  });

  it('admits a candidate exactly on the coverage floor', () => {
    const onFloor = WINDOW_HOURS * MIN_WINDOW_HOUR_COVERAGE;
    const { best } = rankCandidates(
      [candidate({ id: 'partial', wape: 3, dataPoints: 400, hoursCovered: onFloor })],
      WINDOW_HOURS,
      undefined,
    );

    expect(best?.id).toBe('partial');
  });

  it('reports a well-covered null WAPE as unmeasurable, never as too few points', () => {
    // NL's TSO load series: 721 paired points, and no score, because realized
    // load and the day-ahead forecast measure different quantities (ABL-277).
    // Reporting that as a sample-size problem would misattribute it.
    const { best, candidates } = rankCandidates(
      [candidate({ id: 'tso-d1', source: 'tso', wape: null, dataPoints: 721, hoursCovered: 721 })],
      WINDOW_HOURS,
      undefined,
    );

    expect(best).toBeNull();
    expect(candidates[0].excluded).toBe('unmeasurable_wape');
    expect(candidates[0].dataPoints).toBe(721);
  });

  it('reports a model with no accuracy path as not_measurable', () => {
    const { candidates } = rankCandidates(
      [candidate({ id: 'tso-d1', source: 'tso', wape: null, dataPoints: 0, hoursCovered: 0, notMeasurable: true })],
      WINDOW_HOURS,
      undefined,
    );

    expect(candidates[0].excluded).toBe('not_measurable');
  });

  it('keeps every registered model in the payload, ranked ones first', () => {
    const { candidates } = rankCandidates(
      [
        candidate({ id: 'empty', wape: null, dataPoints: 0, hoursCovered: 0 }),
        candidate({ id: 'worse', wape: 9 }),
        candidate({ id: 'better', wape: 3 }),
      ],
      WINDOW_HOURS,
      undefined,
    );

    expect(candidates.map((c) => c.id)).toEqual(['better', 'worse', 'empty']);
  });
});

describe('hourKey', () => {
  it('collapses the three timestamp spellings the accuracy paths return', () => {
    // ml (raw from `forecasts`), TSO load (strftime-bucketed), TSO generation
    // (raw, 15-minute) — one instant, three spellings, one key.
    expect(hourKey('2026-08-01T05:00:00')).toBe('2026-08-01 05');
    expect(hourKey('2026-08-01T05:00:00Z')).toBe('2026-08-01 05');
    expect(hourKey('2026-08-01 05:15:00')).toBe('2026-08-01 05');
  });

  it('counts four quarter-hours as one covered hour', () => {
    const quarters = ['00', '15', '30', '45'].map((m) => ({ timestamp: `2026-08-01 05:${m}:00` }));
    expect(countHoursCovered(quarters)).toBe(1);
  });

  it('counts distinct hours across separator forms without double-counting', () => {
    expect(
      countHoursCovered([
        { timestamp: '2026-08-01T05:00:00' },
        { timestamp: '2026-08-01 05:00:00' },
        { timestamp: '2026-08-01 06:00:00' },
      ]),
    ).toBe(2);
  });

  it('is zero for no points', () => {
    expect(countHoursCovered([])).toBe(0);
  });
});
