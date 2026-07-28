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

  // comparisonMetric 'mape' -> 'wape' — the entire reason PERSIST_VERSION
  // moved past 1 (WAPE replaced MAPE as a degenerate cross-country metric).
  it('migrates a persisted mape comparisonMetric to wape', () => {
    const out = migratePersisted({ comparisonMetric: 'mape' }, 0);
    expect(out.comparisonMetric).toBe('wape');
  });

  it('leaves a valid comparisonMetric untouched', () => {
    const out = migratePersisted({ comparisonMetric: 'rmse' }, 0);
    expect(out.comparisonMetric).toBe('rmse');
  });

  it('is a no-op at the current version', () => {
    const s = { currentView: 'map' as const };
    expect(migratePersisted(s, PERSIST_VERSION)).toEqual(s);
  });

  // activeChartTab validation — an invalid persisted value renders a
  // completely blank tab panel (no chart, no message). Real values read off
  // the TabsTrigger elements in CountryDashboardView.tsx: `renewables` and
  // `analytics` do NOT match their visible labels ("Generation" and
  // "Forecast accuracy").
  it('drops a persisted activeChartTab that no longer exists', () => {
    const out = migratePersisted({ activeChartTab: 'bogus-tab' }, 0);
    expect(out.activeChartTab).toBe('load');
  });

  it.each(['price', 'load', 'renewables', 'net-position', 'analytics'])(
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
      ['completely empty object', {}],
      ['unrelated junk fields only', { foo: 'bar', baz: [1, 2, 3] }],
    ];

    it.each(garbageInputs)('%s', (_label, input) => {
      expect(() => migratePersisted(input, 0)).not.toThrow();
    });
  });
});
