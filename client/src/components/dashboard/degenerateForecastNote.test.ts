import { describe, it, expect } from 'vitest';
import { describeDegenerateActual, describeDegenerateForecast } from './degenerateForecastNote';
import type { NetPositionResponse } from '@/types';

type Meta = NetPositionResponse['meta'];

const base: Meta = {
  bidding_zone: 'GR',
  model_name: 'chronos-2-V010',
  vintages: [],
  has_band: false,
  last_seen: '2026-07-24T21:00:00',
  forecast_coverage: 'served',
  degenerate_forecast: null,
  actual_coverage: 'served',
  degenerate_actual: null,
};

/** GR as the server reports it — 168 rows, largest |value| 0.0038 MW (its p90 ceiling). */
const gr: Meta = {
  ...base,
  forecast_coverage: 'degenerate_zero',
  degenerate_forecast: { points: 168, max_abs_mw: 0.003754783421754837 },
};

describe('describeDegenerateForecast', () => {
  it('names the model, the count and the measured magnitude for GR', () => {
    const note = describeDegenerateForecast(gr, 'Greece')!;
    expect(note.headline).toBe('No usable net position forecast for Greece.');
    expect(note.detail).toContain('chronos-2-V010 returned 168 values');
    expect(note.detail).toContain('0.0038 MW');
    // The reason has to be on screen, not just the absence.
    expect(note.detail).toContain('reads as a confident forecast');
  });

  it('uses exponential notation below a milliwatt rather than rounding to zero', () => {
    // GR's medians go down to 2.3e-11 MW. "0.0000 MW" would read as a
    // rounding artefact instead of as the evidence.
    const note = describeDegenerateForecast(
      { ...gr, degenerate_forecast: { points: 24, max_abs_mw: 4.582052497426048e-7 } },
      'Greece',
    )!;
    expect(note.detail).toContain('4.6e-7 MW');
    expect(note.detail).not.toContain('0.0000');
  });

  it('says nothing at all when a real forecast was served', () => {
    expect(describeDegenerateForecast(base, 'Belgium')).toBeNull();
  });

  it('says nothing when there was simply no forecast', () => {
    // 'no_forecast' is a different fact and already has its own empty state —
    // claiming a model "returned values" here would be an invention.
    expect(
      describeDegenerateForecast(
        { ...base, forecast_coverage: 'no_forecast', model_name: null },
        'Portugal',
      ),
    ).toBeNull();
  });

  it('says nothing when there is no payload yet', () => {
    expect(describeDegenerateForecast(undefined, 'Greece')).toBeNull();
  });

  it('does not invent a count when the measurement is missing from the payload', () => {
    expect(
      describeDegenerateForecast(
        { ...gr, degenerate_forecast: null },
        'Greece',
      ),
    ).toBeNull();
  });

  it('falls back to a neutral producer when no model is named', () => {
    const note = describeDegenerateForecast({ ...gr, model_name: null }, 'Greece')!;
    expect(note.detail).toContain('The forecast model returned 168 values');
  });

  it('reads as singular for a one-point window', () => {
    const note = describeDegenerateForecast(
      { ...gr, degenerate_forecast: { points: 1, max_abs_mw: 1e-9 } },
      'Greece',
    )!;
    expect(note.detail).toContain('returned 1 value for this window');
  });
});

/** GR's actuals as the server reports them — published rows, all exactly 0.0. */
const grActual: Meta = {
  ...base,
  last_seen: '2025-09-30T21:00:00',
  actual_coverage: 'degenerate_zero',
  degenerate_actual: { points: 192, max_abs_mw: 0 },
};

describe('describeDegenerateActual', () => {
  it('names the count and the measured magnitude for GR', () => {
    const note = describeDegenerateActual(grActual, 'Greece')!;
    expect(note.headline).toBe('No usable net position published for Greece.');
    expect(note.detail).toContain('ENTSO-E returned 192 values');
    expect(note.detail).toContain('0 MW');
  });

  it('blames the numbers, never a series that ended', () => {
    // The distinction is the whole point: ENTSO-E is still returning rows for
    // GR. "Stopped publishing" would be a confident, wrong story about why the
    // chart is empty, and it is the sentence the empty state used to show.
    const note = describeDegenerateActual(grActual, 'Greece')!;
    expect(note.detail).toContain('a gap wearing a number');
    expect(note.detail.toLowerCase()).not.toContain('stopped publishing');
  });

  it('points at the contradicting evidence rather than just asserting', () => {
    const note = describeDegenerateActual(grActual, 'Greece')!;
    expect(note.detail).toContain('cross-border flow');
  });

  it('says nothing at all when real actuals were served', () => {
    expect(describeDegenerateActual(base, 'Belgium')).toBeNull();
  });

  it('says nothing when there were simply no actuals', () => {
    // 'no_actuals' already has its own empty state, and claiming ENTSO-E
    // "returned values" there would be an invention.
    expect(
      describeDegenerateActual({ ...base, actual_coverage: 'no_actuals' }, 'Portugal'),
    ).toBeNull();
  });

  it('says nothing when there is no payload yet', () => {
    expect(describeDegenerateActual(undefined, 'Greece')).toBeNull();
  });

  it('does not invent a count when the measurement is missing from the payload', () => {
    expect(
      describeDegenerateActual({ ...grActual, degenerate_actual: null }, 'Greece'),
    ).toBeNull();
  });

  it('reads as singular for a one-point window', () => {
    const note = describeDegenerateActual(
      { ...grActual, degenerate_actual: { points: 1, max_abs_mw: 0 } },
      'Greece',
    )!;
    expect(note.detail).toContain('returned 1 value for this window');
  });

  it('is independent of the forecast half', () => {
    // GR has both defects at once, and each note must fire on its own field.
    const both: Meta = { ...grActual, ...gr, actual_coverage: 'degenerate_zero',
      degenerate_actual: { points: 192, max_abs_mw: 0 } };
    expect(describeDegenerateActual(both, 'Greece')).not.toBeNull();
    expect(describeDegenerateForecast(both, 'Greece')).not.toBeNull();
  });
});
