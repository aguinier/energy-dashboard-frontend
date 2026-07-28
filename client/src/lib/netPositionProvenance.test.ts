import { describe, it, expect } from 'vitest';
import { horizonDayLabel, summarizeVintages, dayLabelByVintage } from './netPositionProvenance';
import type { NetPositionForecastVintage } from '@/types';

describe('horizonDayLabel', () => {
  it('labels the measured D+2 run (26 Jul vintage, min horizon 40h)', () => {
    expect(horizonDayLabel(40)).toBe('D+2');
  });

  it('labels the measured D+2 run (27 Jul vintage, min horizon 41h)', () => {
    expect(horizonDayLabel(41)).toBe('D+2');
  });

  it('labels a hypothetical future D+1 run with no code change', () => {
    // A D+1 run generated ~06:00 targeting tomorrow 00:00 has ~18h min horizon.
    expect(horizonDayLabel(18)).toBe('D+1');
  });

  it('rounds a run generated exactly at midnight to the day it actually targets', () => {
    // Exactly 24h out -> genuinely next day (D+1), not two days.
    expect(horizonDayLabel(24)).toBe('D+1');
    // Exactly 48h out -> genuinely two days (D+2), not three.
    expect(horizonDayLabel(48)).toBe('D+2');
  });

  it('never reports D+0 for a non-negative horizon', () => {
    expect(horizonDayLabel(0)).toBe('D+1');
  });

  it('crosses into D+3 once the minimum horizon passes two full days', () => {
    expect(horizonDayLabel(49)).toBe('D+3');
  });

  it('labels a null horizon honestly instead of silently defaulting to D+1', () => {
    // `horizon_hours_min` is null when every row in the vintage had a null
    // `horizon_hours` (nullable column, unenforced at the ingest boundary).
    // `null / 24` coerces to `0` in JS, which would previously read as D+1
    // through this same ceil/max math - a silent mislabel this function must
    // not produce.
    expect(horizonDayLabel(null)).toBe('D+?');
  });
});

const VINTAGE_26: NetPositionForecastVintage = {
  generated_at: '2026-07-26T07:06:28.960696',
  model_version: '20260726_070628',
  horizon_hours_min: 40,
  horizon_hours_max: 63,
  target_count: 24,
  first_target: '2026-07-28T00:00:00',
  last_target: '2026-07-28T23:00:00',
};

const VINTAGE_27: NetPositionForecastVintage = {
  generated_at: '2026-07-27T06:00:35.035825',
  model_version: '20260727_060035',
  horizon_hours_min: 41,
  horizon_hours_max: 64,
  target_count: 24,
  first_target: '2026-07-29T00:00:00',
  last_target: '2026-07-29T23:00:00',
};

describe('summarizeVintages', () => {
  it('summarizes each vintage with its derived day label', () => {
    const out = summarizeVintages([VINTAGE_27, VINTAGE_26]);
    expect(out).toEqual([
      {
        generated_at: '2026-07-27T06:00:35.035825',
        dayLabel: 'D+2',
        target_count: 24,
        first_target: '2026-07-29T00:00:00',
        last_target: '2026-07-29T23:00:00',
      },
      {
        generated_at: '2026-07-26T07:06:28.960696',
        dayLabel: 'D+2',
        target_count: 24,
        first_target: '2026-07-28T00:00:00',
        last_target: '2026-07-28T23:00:00',
      },
    ]);
  });

  it('returns an empty list when there is nothing to forecast', () => {
    expect(summarizeVintages(undefined)).toEqual([]);
    expect(summarizeVintages([])).toEqual([]);
  });

  it('labels a vintage with an unknown horizon as D+? rather than a fabricated D+1', () => {
    const unknownHorizon: NetPositionForecastVintage = {
      ...VINTAGE_26,
      horizon_hours_min: null,
      horizon_hours_max: null,
    };
    const out = summarizeVintages([unknownHorizon]);
    expect(out[0].dayLabel).toBe('D+?');
  });
});

describe('dayLabelByVintage', () => {
  it('maps each generated_at to its day label', () => {
    const map = dayLabelByVintage([VINTAGE_26, VINTAGE_27]);
    expect(map.get('2026-07-26T07:06:28.960696')).toBe('D+2');
    expect(map.get('2026-07-27T06:00:35.035825')).toBe('D+2');
    expect(map.size).toBe(2);
  });

  it('returns an empty map when there are no vintages', () => {
    expect(dayLabelByVintage(undefined).size).toBe(0);
  });
});
