import { describe, it, expect } from 'vitest';
import { migratePersisted, PERSIST_VERSION } from './migrate';

describe('migratePersisted', () => {
  it('drops a persisted view that no longer exists', () => {
    const out = migratePersisted({ currentView: 'analytics', selectedCountry: 'BE' }, 0);
    expect(out.currentView).toBe('map');
  });

  it('keeps a valid view', () => {
    expect(migratePersisted({ currentView: 'country' }, 0).currentView).toBe('country');
  });

  // `layers` is dead state (see migrate.ts) — migration must not derive
  // anything from it, and must not let it survive to shallow-merge back in.
  it('drops the dead layers blob without touching forecast booleans', () => {
    const out = migratePersisted(
      {
        layers: { showActuals: true, tso: { enabled: true, showAccuracy: false, horizon: 'day_ahead' }, ml: { enabled: false, showAccuracy: false } },
        showForecast: true,
      },
      0,
    );
    expect(out.layers).toBeUndefined();
    // A `showForecast` the current code already set must survive untouched —
    // it must NOT be clobbered back to `layers.ml.enabled` (false).
    expect(out.showForecast).toBe(true);
  });

  it('is a no-op on forecast booleans when layers is absent', () => {
    const out = migratePersisted({ showForecast: true, showTSOForecast: false }, 0);
    expect(out.showForecast).toBe(true);
    expect(out.showTSOForecast).toBe(false);
  });

  // `timeRange` (the legacy TimeRange enum hand-synced from `timePreset`) was
  // removed from the store — see dashboardStore.ts/windowLabel.ts. A blob
  // persisted before that change may still carry it; migration must strip it
  // rather than let it keep re-appearing via the persist middleware's shallow
  // merge of old state onto new.
  it('drops a persisted timeRange — the field no longer exists', () => {
    const out = migratePersisted({ timeRange: '7d', timePreset: 'next24h' }, 0);
    expect(out.timeRange).toBeUndefined();
    expect(out.timePreset).toBe('next24h'); // untouched
  });

  it('is a no-op when timeRange is already absent', () => {
    const out = migratePersisted({ timePreset: '7d' }, 0);
    expect(out.timeRange).toBeUndefined();
  });

  // `analyticsConfig` (the last holder of a nested `timeRange` field) backed
  // the now-deleted analytics dashboard — see migrate.ts. A blob persisted
  // before that removal may still carry it; migration must strip it rather
  // than let it keep re-appearing via the persist middleware's shallow merge.
  it('drops a persisted analyticsConfig — the slice no longer exists', () => {
    const out = migratePersisted(
      { analyticsConfig: { forecastType: 'load', timeRange: '30d', rollingWindow: 7 }, timePreset: 'next24h' },
      0,
    );
    expect(out.analyticsConfig).toBeUndefined();
    expect(out.timePreset).toBe('next24h'); // untouched
  });

  it('is a no-op when analyticsConfig is already absent', () => {
    const out = migratePersisted({ timePreset: '7d' }, 0);
    expect(out.analyticsConfig).toBeUndefined();
  });

  // `90d`/`1y` left the `TimePreset` union in ABL-4 (nothing in the UI could
  // set them). Left unmigrated, the persist middleware's shallow merge keeps a
  // stored '90d' alive in a store with no branch for it: `getDateRangeForPreset`
  // silently serves its `default` 7-day window while the header qualifier says
  // "90d" — a wrong window under a confident label.
  it.each(['90d', '1y'])('resets a persisted %s timePreset that no longer exists', (preset) => {
    const out = migratePersisted({ timePreset: preset, timeAnchor: 'past' }, 0);
    expect(out.timePreset).toBe('7d');
    expect(out.timeAnchor).toBe('past');
  });

  it.each(['24h', '7d', '30d', 'today', 'thisWeek', 'next1d', 'next24h', 'next48h', 'next7d'])(
    'keeps the still-valid timePreset %s',
    (preset) => {
      expect(migratePersisted({ timePreset: preset }, 0).timePreset).toBe(preset);
    },
  );

  it('defaults timePreset when absent entirely', () => {
    const out = migratePersisted({}, 0);
    expect(out.timePreset).toBe('7d');
    expect(out.timeAnchor).toBe('past');
  });

  // The anchor is persisted separately from the preset and only `setTimePreset`
  // keeps the pair in step, so a mismatched pair must not survive: a 'past'
  // anchor on 'next7d' describes a window the fetch never uses.
  it('re-derives a stale timeAnchor from the preset', () => {
    expect(migratePersisted({ timePreset: 'next7d', timeAnchor: 'past' }, 0).timeAnchor).toBe('future');
    expect(migratePersisted({ timePreset: 'today', timeAnchor: 'past' }, 0).timeAnchor).toBe('now');
    expect(migratePersisted({ timePreset: '30d', timeAnchor: 'future' }, 0).timeAnchor).toBe('past');
  });

  // v7 — `selectedModelByType` used to mean two things at once: a pinned model
  // id, or `null` for "forecast hidden". See migrate.ts and ABL-16.
  describe('splits the pinned model from the hidden flag (v7)', () => {
    it('moves a null entry to forecastHiddenByType', () => {
      const out = migratePersisted({ selectedModelByType: { load: null } }, 6);
      expect(out.forecastHiddenByType).toEqual({ load: true });
      expect(out.selectedModelByType).toEqual({});
    });

    // Every dropdown entry wrote a pin under the old picker, "Default" and the
    // on-switch included, so a stored pin cannot be told apart from an
    // artefact of the bug. Dropping them is what frees users already trapped.
    it('drops stored pins so the server ladder applies again', () => {
      const out = migratePersisted(
        { selectedModelByType: { price: 'catboost', load: 'tso-d7' } },
        6,
      );
      expect(out.selectedModelByType).toEqual({});
      expect(out.forecastHiddenByType).toEqual({});
    });

    it('keeps hidden types while dropping pins in the same blob', () => {
      const out = migratePersisted(
        { selectedModelByType: { price: 'catboost', load: null, net_position: null } },
        6,
      );
      expect(out.selectedModelByType).toEqual({});
      expect(out.forecastHiddenByType).toEqual({ load: true, net_position: true });
    });

    it('initialises both maps when the blob predates model selection entirely', () => {
      const out = migratePersisted({ timePreset: '7d' }, 0);
      expect(out.selectedModelByType).toEqual({});
      expect(out.forecastHiddenByType).toEqual({});
    });
  });

  it('does not re-run the v7 model migration for a v7 persisted blob', () => {
    const out = migratePersisted({ selectedModelByType: { load: 'tso-d7' }, forecastHiddenByType: { price: true } }, 7);
    expect(out.selectedModelByType).toEqual({ load: 'tso-d7' });
    expect(out.forecastHiddenByType).toEqual({ price: true });
  });

  // v9 (ABL-158) — the Forecast quality page (ComparisonView) and its
  // per-country `analytics` drill-down tab are gone.
  describe('removes the Forecast quality page state (v9)', () => {
    it('falls back a persisted comparison view to map', () => {
      expect(migratePersisted({ currentView: 'comparison' }, 0).currentView).toBe('map');
    });

    it('falls back a persisted analytics chart tab to load', () => {
      expect(migratePersisted({ activeChartTab: 'analytics' }, 0).activeChartTab).toBe('load');
    });

    it('drops every cross-country-comparison field regardless of its value', () => {
      const out = migratePersisted(
        {
          comparisonCountries: ['DE', 'FR'],
          comparisonMetric: 'wape',
          comparisonForecastType: 'all',
          comparisonTimeRange: '90d',
        },
        7,
      );
      expect(out.comparisonCountries).toBeUndefined();
      expect(out.comparisonMetric).toBeUndefined();
      expect(out.comparisonForecastType).toBeUndefined();
      expect(out.comparisonTimeRange).toBeUndefined();
    });

    it('is a no-op when none of those fields are present', () => {
      const out = migratePersisted({ timePreset: '7d' }, 0);
      expect(out.comparisonCountries).toBeUndefined();
      expect(out.comparisonMetric).toBeUndefined();
      expect(out.comparisonForecastType).toBeUndefined();
      expect(out.comparisonTimeRange).toBeUndefined();
    });
  });

  it('is a no-op at the current version', () => {
    const s = { currentView: 'map' as const };
    expect(migratePersisted(s, PERSIST_VERSION)).toEqual(s);
  });

  // activeChartTab validation — an invalid persisted value renders a
  // completely blank tab panel (no chart, no message). Real values read off
  // the TabsTrigger elements in CountryDashboardView.tsx: `renewables` does
  // NOT match its visible label ("Generation").
  it('drops a persisted activeChartTab that no longer exists', () => {
    const out = migratePersisted({ activeChartTab: 'bogus-tab' }, 0);
    expect(out.activeChartTab).toBe('load');
  });

  it.each(['price', 'load', 'renewables', 'net-position'])(
    'keeps a valid activeChartTab %s',
    (tab) => {
      expect(migratePersisted({ activeChartTab: tab }, 0).activeChartTab).toBe(tab);
    },
  );

  it('defaults activeChartTab when absent entirely', () => {
    expect(migratePersisted({}, 0).activeChartTab).toBe('load');
  });

  // migratePersisted runs against arbitrary old persisted blobs — every
  // field must be treated as untrusted. None of these should throw.
  describe('survives garbage input without throwing', () => {
    const garbageInputs: Array<[string, Record<string, unknown>]> = [
      ['null currentView', { currentView: null }],
      ['numeric currentView', { currentView: 42 }],
      ['null activeChartTab', { activeChartTab: null }],
      ['numeric activeChartTab', { activeChartTab: 123 }],
      ['layers as a string', { layers: 'not-an-object' }],
      ['layers as null', { layers: null }],
      ['layers.tso as a string', { layers: { tso: 'nope', ml: {} } }],
      ['layers missing tso/ml', { layers: {} }],
      ['null timePreset', { timePreset: null }],
      ['numeric timePreset', { timePreset: 90 }],
      ['object timePreset', { timePreset: { value: '90d' } }],
      ['null timeAnchor', { timePreset: '7d', timeAnchor: null }],
      ['completely empty object', {}],
      ['unrelated junk fields only', { foo: 'bar', baz: [1, 2, 3] }],
      ['selectedModelByType as a string', { selectedModelByType: 'catboost' }],
      ['selectedModelByType as null', { selectedModelByType: null }],
      ['selectedModelByType as an array', { selectedModelByType: ['catboost'] }],
      ['selectedModelByType holding numbers', { selectedModelByType: { load: 7 } }],
    ];

    it.each(garbageInputs)('%s', (_label, input) => {
      expect(() => migratePersisted(input, 0)).not.toThrow();
    });
  });
});
