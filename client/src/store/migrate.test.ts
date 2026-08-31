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
  //
  // migratePersisted always runs every clause up to the current version in one
  // pass, so a fromVersion-6 blob also crosses v9 (ABL-203) in the same call —
  // these assert the final `selectedModelsByType` shape a real caller would
  // actually see, not v7's now-intermediate `selectedModelByType`.
  describe('splits the pinned model from the hidden flag (v7)', () => {
    it('moves a null entry to forecastHiddenByType', () => {
      const out = migratePersisted({ selectedModelByType: { load: null } }, 6);
      expect(out.forecastHiddenByType).toEqual({ load: true });
      expect(out.selectedModelsByType).toEqual({});
    });

    // Every dropdown entry wrote a pin under the old picker, "Default" and the
    // on-switch included, so a stored pin cannot be told apart from an
    // artefact of the bug. Dropping them is what frees users already trapped.
    it('drops stored pins so the server ladder applies again', () => {
      const out = migratePersisted(
        { selectedModelByType: { price: 'catboost', load: 'tso-d7' } },
        6,
      );
      expect(out.selectedModelsByType).toEqual({});
      expect(out.forecastHiddenByType).toEqual({});
    });

    it('keeps hidden types while dropping pins in the same blob', () => {
      const out = migratePersisted(
        { selectedModelByType: { price: 'catboost', load: null, net_position: null } },
        6,
      );
      expect(out.selectedModelsByType).toEqual({});
      expect(out.forecastHiddenByType).toEqual({ load: true, net_position: true });
    });

    it('initialises both maps when the blob predates model selection entirely', () => {
      const out = migratePersisted({ timePreset: '7d' }, 0);
      expect(out.selectedModelsByType).toEqual({});
      expect(out.forecastHiddenByType).toEqual({});
    });
  });

  describe('portfolio home default (v8)', () => {
    it('moves the legacy all-types landing state to load', () => {
      expect(migratePersisted({ comparisonForecastType: 'all' }, 7).comparisonForecastType).toBe('load');
    });

    it('preserves an already selected forecast type', () => {
      expect(migratePersisted({ comparisonForecastType: 'price' }, 7).comparisonForecastType).toBe('price');
    });

    it('does not re-run the v7 model migration for a v7 persisted blob', () => {
      const out = migratePersisted({ selectedModelByType: { load: 'tso-d7' }, forecastHiddenByType: { price: true } }, 7);
      // v7 already ran (this blob is past it) — v9 still converts the single
      // surviving pin into a one-element selection.
      expect(out.selectedModelsByType).toEqual({ load: ['tso-d7'] });
      expect(out.forecastHiddenByType).toEqual({ price: true });
    });
  });

  // v9 (ABL-203) — selectedModelByType (one pin) -> selectedModelsByType
  // (an array), for the net-position multi-select picker.
  describe('converts the single pin to a one-element selection (v9)', () => {
    it('migrates a single stored pin into a one-element array, keyed the same', () => {
      const out = migratePersisted(
        { selectedModelByType: { net_position: 'chronos-2-V010', load: 'catboost' } },
        8,
      );
      expect(out.selectedModelByType).toBeUndefined();
      expect(out.selectedModelsByType).toEqual({
        net_position: ['chronos-2-V010'],
        load: ['catboost'],
      });
    });

    it('produces an empty selection map when no pins were stored', () => {
      const out = migratePersisted({ selectedModelByType: {} }, 8);
      expect(out.selectedModelsByType).toEqual({});
    });

    it('initialises the map when the blob predates model selection entirely', () => {
      const out = migratePersisted({ timePreset: '7d' }, 0);
      expect(out.selectedModelsByType).toEqual({});
    });

    // Runs after the v7 split, on whatever v7 left behind (an empty pin map,
    // since v7 drops every stored pin) — not the pre-v7 shape.
    it('composes with the v7 migration for a pre-v7 blob', () => {
      const out = migratePersisted(
        { selectedModelByType: { price: 'catboost', net_position: null } },
        6,
      );
      expect(out.selectedModelsByType).toEqual({});
      expect(out.forecastHiddenByType).toEqual({ net_position: true });
    });

    it('is a no-op re-run for a blob already at v9 or later', () => {
      const s = { selectedModelsByType: { net_position: ['baseline-V012'] } };
      expect(migratePersisted(s, PERSIST_VERSION)).toEqual(s);
    });
  });

  it('is a no-op at the current version', () => {
    const s = { currentView: 'map' as const };
    expect(migratePersisted(s, PERSIST_VERSION)).toEqual(s);
  });

  // v10 (ABL-234) — netPositionScope joins partialize. The two scopes can
  // disagree in SIGN (France 2026-08-09 08:00 UTC: Core -368.9 MW importing
  // vs all-coupled +1,494.6 MW exporting), so an unrecognised persisted value
  // must never survive to a chart whose legend then names a scope the query
  // did not use.
  describe('validates the net position scope (v10)', () => {
    it('defaults a blob that predates the field', () => {
      expect(migratePersisted({ currentView: 'map' }, 9).netPositionScope).toBe('all_coupled');
    });

    it('keeps a legitimately stored scope', () => {
      expect(migratePersisted({ netPositionScope: 'core' }, 9).netPositionScope).toBe('core');
      expect(migratePersisted({ netPositionScope: 'all_coupled' }, 9).netPositionScope).toBe(
        'all_coupled',
      );
    });

    it.each([
      ['an unknown string', 'ac'],
      ['the wrong case', 'Core'],
      ['an empty string', ''],
      ['null', null],
      ['a number', 3],
      ['an object', { scope: 'core' }],
      ['an array', ['core']],
    ])('coerces %s to all_coupled', (_label, value) => {
      expect(migratePersisted({ netPositionScope: value }, 9).netPositionScope).toBe('all_coupled');
    });

    it('coerces to the view that always has data, not to Core', () => {
      // Core capture is off by default in a deployment (see
      // server/src/services/coreNetPositionScheduler.ts), so all_coupled is
      // also the only choice guaranteed to render something.
      expect(migratePersisted({ netPositionScope: 'core-ish' }, 0).netPositionScope).toBe(
        'all_coupled',
      );
    });

    it('leaves a blob already at the current version untouched', () => {
      const s = { netPositionScope: 'core' };
      expect(migratePersisted(s, PERSIST_VERSION)).toEqual(s);
    });
  });

  // Task 9b (PERSIST_VERSION bumped to 11 for this) — `activeChartTab`
  // belonged to the deleted tab view (CountryDashboardView.tsx); the
  // scrolling document that replaced it has no "current tab" concept, so the
  // field is dropped outright rather than validated against a set of tab ids
  // that no longer mean anything.
  //
  // The clause in migrate.ts is deliberately NOT gated `if (fromVersion < 11)`
  // — see its comment for why such a gate on the *current* PERSIST_VERSION is
  // always true and untestable in isolation (the function's own top guard
  // already excludes every `fromVersion` where it could be false). These
  // tests exercise the reachable domain directly instead: every `fromVersion`
  // that can actually reach this line (0 through 10, the boundary right below
  // the current version) drops the key.
  describe('drops activeChartTab entirely', () => {
    it.each([0, 6, 9, 10])('removes a previously-valid persisted value from fromVersion %i', (fromVersion) => {
      expect(migratePersisted({ activeChartTab: 'load' }, fromVersion).activeChartTab).toBeUndefined();
    });

    it('removes a persisted value that was never valid', () => {
      expect(migratePersisted({ activeChartTab: 'bogus-tab' }, 0).activeChartTab).toBeUndefined();
    });

    it('is a no-op when activeChartTab is already absent', () => {
      expect(migratePersisted({ timePreset: '7d' }, 0).activeChartTab).toBeUndefined();
    });
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
      ['selectedModelByType holding an array', { selectedModelByType: { load: ['catboost'] } }],
    ];

    it.each(garbageInputs)('%s', (_label, input) => {
      expect(() => migratePersisted(input, 0)).not.toThrow();
    });
  });
});
