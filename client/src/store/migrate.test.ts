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

  it('derives legacy booleans from layers', () => {
    const out = migratePersisted({ layers: { showActuals: true, tso: { enabled: true, showAccuracy: false, horizon: 'day_ahead' }, ml: { enabled: false, showAccuracy: false } } }, 0);
    expect(out.showTSOForecast).toBe(true);
    expect(out.showForecast).toBe(false);
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
