import { describe, it, expect } from 'vitest';
import { describeForecastVintage, parseGeneratedAt } from './forecastVintage';
import type { ForecastDataPoint } from '@/types';

const NOW = new Date('2026-08-12T12:00:00Z');

function point(
  timestamp: string,
  generated_at: string,
  extra: Partial<ForecastDataPoint> = {},
): ForecastDataPoint {
  return {
    timestamp,
    value: 42_000,
    type: 'load',
    generated_at,
    horizon_hours: 28,
    model_name: 'catboost',
    model_version: '20260202_154855',
    ...extra,
  };
}

describe('parseGeneratedAt', () => {
  it('reads a bare stored timestamp as UTC, not as local time', () => {
    // The defect CLAUDE.md records against the header freshness pill: V8 parses
    // an un-zoned timestamp as local, understating every age by the viewer's
    // offset. Asserted against an absolute epoch so it fails in any timezone.
    expect(parseGeneratedAt('2026-08-11T19:00:58.721815')?.getTime()).toBe(
      Date.UTC(2026, 7, 11, 19, 0, 58, 721),
    );
  });

  it('reads both stored separators as the same instant', () => {
    expect(parseGeneratedAt('2026-08-11 19:00:58.721815')?.getTime()).toBe(
      parseGeneratedAt('2026-08-11T19:00:58.721815')?.getTime(),
    );
  });

  it('accepts a value with no fractional seconds', () => {
    expect(parseGeneratedAt('2026-08-11 06:00:55')?.getTime()).toBe(
      Date.UTC(2026, 7, 11, 6, 0, 55),
    );
  });

  it('honours an explicit zone rather than overriding it with UTC', () => {
    expect(parseGeneratedAt('2026-08-11T19:00:58+02:00')?.getTime()).toBe(
      Date.UTC(2026, 7, 11, 17, 0, 58),
    );
    expect(parseGeneratedAt('2026-08-11T19:00:58Z')?.getTime()).toBe(
      Date.UTC(2026, 7, 11, 19, 0, 58),
    );
  });

  it('rejects a date that does not exist instead of rolling it forward', () => {
    // `Date.UTC(2026, 1, 30)` is 2 March. Reporting that as a generation time
    // would be a plausible, wrong number.
    expect(parseGeneratedAt('2026-02-30T06:00:00')).toBeNull();
    expect(parseGeneratedAt('2026-13-01T06:00:00')).toBeNull();
  });

  it('returns null for anything it cannot parse', () => {
    expect(parseGeneratedAt('')).toBeNull();
    expect(parseGeneratedAt(undefined)).toBeNull();
    expect(parseGeneratedAt('yesterday')).toBeNull();
  });
});

describe('describeForecastVintage', () => {
  it('says nothing when there is no forecast on the chart', () => {
    expect(describeForecastVintage(undefined, { now: NOW })).toBeNull();
    expect(describeForecastVintage([], { now: NOW })).toBeNull();
  });

  it('names the model, version and age of a single-run batch', () => {
    const v = describeForecastVintage(
      [
        point('2026-08-13T00:00:00', '2026-08-11T19:00:58.721815'),
        point('2026-08-13T01:00:00', '2026-08-11T19:00:58.721815'),
      ],
      { now: NOW },
    )!;

    expect(v.runCount).toBe(1);
    expect(v.ageHours).toBe(16);
    expect(v.models).toEqual(['catboost']);
    expect(v.summary).toBe('catboost 20260202_154855 · generated 16h ago (11 Aug 19:00 UTC)');
    expect(v.detail).toBe(
      'catboost 20260202_154855 — one forecast run on screen, generated 2026-08-11 19:00:58 UTC.',
    );
  });

  it('names every model in a mixed batch instead of labelling it from row zero', () => {
    // The trap ABL-285 was filed on. Today `/forecasts` cannot actually return
    // a mixed batch — the candidate ladder pins one model per response
    // (`forecastService.ts:32-37`) — so this pins the *degradation*: if that
    // read is ever widened, the label names every model rather than silently
    // inheriting row zero's.
    const v = describeForecastVintage(
      [
        point('2026-08-13T00:00:00', '2026-08-11T19:00:58', { model_name: 'xgboost', model_version: 'a' }),
        point('2026-08-13T01:00:00', '2026-08-11T19:00:58', { model_name: 'catboost', model_version: 'b' }),
      ],
      { now: NOW },
    )!;

    expect(v.models).toEqual(['catboost', 'xgboost']);
    expect(v.summary).toBe('catboost, xgboost · generated 16h ago (11 Aug 19:00 UTC)');
  });

  it('counts versions rather than picking one when a model spans several', () => {
    const v = describeForecastVintage(
      [
        point('2026-08-12T00:00:00', '2026-08-11T14:00:11', { model_version: '20260201_222000' }),
        point('2026-08-13T00:00:00', '2026-08-11T19:00:58', { model_version: '20260202_154855' }),
      ],
      { now: NOW },
    )!;

    expect(v.versions).toEqual(['20260201_222000', '20260202_154855']);
    expect(v.summary).toBe('catboost · 2 versions · newest of 2 runs generated 16h ago (11 Aug 19:00 UTC)');
  });

  it('counts the runs on screen instead of claiming one generation time', () => {
    // `/forecasts` pins each target timestamp to its own MAX(generated_at), so
    // one window routinely spans several runs — DE load had three on
    // 2026-08-11 alone.
    const v = describeForecastVintage(
      [
        point('2026-08-11T00:00:00', '2026-08-11T14:00:11.172681'),
        point('2026-08-12T00:00:00', '2026-08-11T15:30:38.030929'),
        point('2026-08-13T00:00:00', '2026-08-11T19:00:58.721815'),
      ],
      { now: NOW },
    )!;

    expect(v.runCount).toBe(3);
    expect(v.newestGeneratedAt).toBe('2026-08-11T19:00:58.721815');
    expect(v.oldestGeneratedAt).toBe('2026-08-11T14:00:11.172681');
    expect(v.summary).toBe('catboost 20260202_154855 · newest of 3 runs generated 16h ago (11 Aug 19:00 UTC)');
    expect(v.detail).toBe(
      'catboost 20260202_154855 — 3 forecast runs on screen; newest generated 2026-08-11 19:00:58 UTC, ' +
        'oldest 2026-08-11 14:00:11 UTC.',
    );
  });

  it('treats one batch stamped per row as one run, not several', () => {
    // Measured against production on 2026-08-12: a single DE `load` window
    // returned 47 points split across `…19:00:41.756470` and `…19:00:41.919369`
    // — one scheduled 19:00 batch, 163 microseconds apart. "newest of 2 runs"
    // there would tell the reader the line mixes two forecast runs.
    const v = describeForecastVintage(
      [
        point('2026-08-13T00:00:00', '2026-08-11T19:00:41.756470'),
        point('2026-08-13T01:00:00', '2026-08-11T19:00:41.919369'),
      ],
      { now: NOW },
    )!;

    expect(v.runCount).toBe(1);
    expect(v.summary).toBe('catboost 20260202_154855 · generated 16h ago (11 Aug 19:00 UTC)');
    // The raw extremes stay honest even though they collapsed to one run.
    expect(v.newestGeneratedAt).toBe('2026-08-11T19:00:41.919369');
    expect(v.oldestGeneratedAt).toBe('2026-08-11T19:00:41.756470');
  });

  it('still separates runs that are genuinely minutes apart', () => {
    // The same DE `load` target really did have separate runs at 14:00, 15:30
    // and 19:00 on 2026-08-11. Those must not be folded together.
    const v = describeForecastVintage(
      [
        point('2026-08-11T00:00:00', '2026-08-11T14:00:11.172681'),
        point('2026-08-12T00:00:00', '2026-08-11T15:30:38.030929'),
        point('2026-08-13T00:00:00', '2026-08-11T19:00:58.721815'),
      ],
      { now: NOW },
    )!;
    expect(v.runCount).toBe(3);
  });

  it('does not split one batch that straddles a minute boundary', () => {
    // Why the gap is clustered rather than bucketed to a fixed minute.
    const v = describeForecastVintage(
      [
        point('2026-08-13T00:00:00', '2026-08-11T18:59:59.999000'),
        point('2026-08-13T01:00:00', '2026-08-11T19:00:00.001000'),
      ],
      { now: NOW },
    )!;
    expect(v.runCount).toBe(1);
  });

  it('orders runs by instant, not by string — the two separators do not sort', () => {
    // `'T' > ' '`, so a lexical MAX would call the older T-form run the newest.
    const v = describeForecastVintage(
      [
        point('2026-08-12T00:00:00', '2026-08-11T06:00:00'),
        point('2026-08-13T00:00:00', '2026-08-11 18:00:00'),
      ],
      { now: NOW },
    )!;

    expect(v.newestGeneratedAt).toBe('2026-08-11 18:00:00');
    expect(v.ageHours).toBe(18);
  });

  it('reports the vintage without a model claim when the rows name none', () => {
    // The aggregated (daily/weekly) branch of `getForecastData` selects
    // MAX(generated_at) but no model_name or model_version.
    const v = describeForecastVintage(
      [
        point('2026-08-12T00:00:00', '2026-08-11T19:00:58', {
          model_name: undefined,
          model_version: undefined,
        }),
      ],
      { now: NOW },
    )!;

    expect(v.models).toEqual([]);
    expect(v.summary).toBe('generated 16h ago (11 Aug 19:00 UTC)');
  });

  it('describes only the runs inside the chart window', () => {
    // "Today" fetches to now+48h but draws only today, so the newest run in the
    // response can be one whose points are entirely off-screen.
    // Target timestamps in `Z` form here only so the clip is timezone-stable in
    // this test — the filter itself bins them exactly the way `buildSeriesGrid`
    // does, whatever form the API returns.
    const points = [
      point('2026-08-12T06:00:00Z', '2026-08-11T06:00:00'),
      point('2026-08-14T06:00:00Z', '2026-08-12T11:00:00'),
    ];
    const window = {
      start: new Date('2026-08-11T22:00:00Z'),
      end: new Date('2026-08-12T21:59:59Z'),
    };

    const clipped = describeForecastVintage(points, { now: NOW, window })!;
    expect(clipped.runCount).toBe(1);
    expect(clipped.newestGeneratedAt).toBe('2026-08-11T06:00:00');
    expect(clipped.ageHours).toBe(30);

    // Same rows, no clip: the off-canvas run is the newest and is reported.
    expect(describeForecastVintage(points, { now: NOW })!.ageHours).toBe(1);
  });

  it('says nothing when the window excludes every forecast point', () => {
    expect(
      describeForecastVintage([point('2026-08-20T06:00:00Z', '2026-08-11T06:00:00')], {
        now: NOW,
        window: { start: new Date('2026-08-11T22:00:00Z'), end: new Date('2026-08-12T21:59:59Z') },
      }),
    ).toBeNull();
  });

  it('ignores a run whose points the chart would not paint', () => {
    // `buildSeriesGrid` paints a forecast point only when its value is finite
    // (`chartAdapters.ts:92`). A newer run present in the response but not on
    // the canvas must not be reported as the vintage of the line that is.
    const v = describeForecastVintage(
      [
        point('2026-08-13T00:00:00', '2026-08-11T06:00:00'),
        point('2026-08-13T01:00:00', '2026-08-12T11:00:00', {
          value: null as unknown as number,
        }),
      ],
      { now: NOW },
    )!;

    expect(v.runCount).toBe(1);
    expect(v.newestGeneratedAt).toBe('2026-08-11T06:00:00');
    expect(v.ageHours).toBe(30);
  });

  it('says nothing when no point in the batch is paintable', () => {
    expect(
      describeForecastVintage(
        [point('2026-08-13T00:00:00', '2026-08-11T06:00:00', { value: NaN })],
        { now: NOW },
      ),
    ).toBeNull();
  });

  it('gives no relative age for a run stamped in the future', () => {
    // Clock skew between the model host and the viewer. "generated 0h ago" for
    // a run that has not happened yet is a claim we cannot make; the absolute
    // stamp still renders.
    const v = describeForecastVintage(
      [point('2026-08-14T00:00:00', '2026-08-12T18:00:00')],
      { now: NOW },
    )!;

    expect(v.ageHours).toBeNull();
    expect(v.summary).toBe('catboost 20260202_154855 · generated 12 Aug 18:00 UTC');
  });

  it('reports minutes under the hour and days past two', () => {
    const minutes = describeForecastVintage(
      [point('2026-08-13T00:00:00', '2026-08-12T11:38:00')],
      { now: NOW },
    )!;
    expect(minutes.summary).toContain('generated 22m ago');

    const days = describeForecastVintage(
      [point('2026-08-13T00:00:00', '2026-08-08T12:00:00')],
      { now: NOW },
    )!;
    expect(days.summary).toContain('generated 4d ago');
  });

  it('says nothing when no generated_at in the batch is parseable', () => {
    expect(
      describeForecastVintage([point('2026-08-13T00:00:00', 'not a timestamp')], { now: NOW }),
    ).toBeNull();
  });
});
