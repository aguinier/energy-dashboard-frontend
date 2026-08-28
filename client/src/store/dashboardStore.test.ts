import { describe, it, expect, beforeEach } from 'vitest';
import { useDashboardStore } from './dashboardStore';
import { PERSIST_VERSION } from './migrate';
import { PRESET_SHIFT_HOURS } from '@/lib/constants';

// setServedModel is written from a useEffect in useLoadChartData/usePriceChartData
// on every render where servedModelId is computed, not just when it changes.
// Without the equality guard, that would replace `servedModelByType` with a new
// object identity on every render even when nothing changed, which would
// invalidate anything memoized off it (and, in a real component tree, cause an
// effect/render loop). These tests exercise the guard directly, without React.
describe('setServedModel equality guard', () => {
  beforeEach(() => {
    useDashboardStore.setState({ servedModelByType: {} });
  });

  it('is a no-op — same object identity — when the value has not changed', () => {
    useDashboardStore.getState().setServedModel('load', 'xgboost');
    const before = useDashboardStore.getState().servedModelByType;

    useDashboardStore.getState().setServedModel('load', 'xgboost');
    const after = useDashboardStore.getState().servedModelByType;

    expect(after).toBe(before);
  });

  it('is a no-op when re-asserting null for a type already explicitly cleared', () => {
    useDashboardStore.getState().setServedModel('price', null);
    const before = useDashboardStore.getState().servedModelByType;

    useDashboardStore.getState().setServedModel('price', null);
    const after = useDashboardStore.getState().servedModelByType;

    expect(after).toBe(before);
  });

  it('produces a new object and the new value when the value actually changes', () => {
    useDashboardStore.getState().setServedModel('load', 'catboost');
    const before = useDashboardStore.getState().servedModelByType;

    useDashboardStore.getState().setServedModel('load', 'xgboost');
    const after = useDashboardStore.getState().servedModelByType;

    expect(after).not.toBe(before);
    expect(after.load).toBe('xgboost');
  });

  it('clearing a served model (e.g. the layer got disabled) changes identity and value', () => {
    useDashboardStore.getState().setServedModel('load', 'xgboost');
    const before = useDashboardStore.getState().servedModelByType;

    useDashboardStore.getState().setServedModel('load', null);
    const after = useDashboardStore.getState().servedModelByType;

    expect(after).not.toBe(before);
    expect(after.load).toBeNull();
  });

  it('keeps other forecast types untouched when one type changes', () => {
    useDashboardStore.getState().setServedModel('load', 'catboost');
    useDashboardStore.getState().setServedModel('price', 'xgboost');

    useDashboardStore.getState().setServedModel('load', 'xgboost');

    expect(useDashboardStore.getState().servedModelByType).toEqual({
      load: 'xgboost',
      price: 'xgboost',
    });
  });
});

// ============================================================================
// Time window navigation (ABL-12)
// ============================================================================
//
// `shiftTimeWindow` and `jumpToLive` existed with no callers in the whole
// client, so `timeOffset` was structurally always 0 and `isLive` was written
// but never read. The picker's arrows and Now button call them now; these pin
// the semantics those controls depend on.
describe('shiftTimeWindow', () => {
  beforeEach(() => {
    useDashboardStore.setState({ timePreset: '7d', timeAnchor: 'past', timeOffset: 0, isLive: false });
  });

  it('steps back by the preset\'s own step', () => {
    useDashboardStore.getState().shiftTimeWindow('back');
    expect(useDashboardStore.getState().timeOffset).toBe(-PRESET_SHIFT_HOURS['7d']);
  });

  it('moves the two day-aligned presets by exactly one market day', () => {
    for (const preset of ['today', 'next1d'] as const) {
      useDashboardStore.setState({ timePreset: preset, timeOffset: 0 });
      useDashboardStore.getState().shiftTimeWindow('back');
      // Half a 24h window would have been 12h, which re-derives the same
      // Brussels calendar day about half the time.
      expect(useDashboardStore.getState().timeOffset).toBe(-24);
    }
  });

  // 0 is the live position. A positive offset would run a historical window
  // past now into a region with no actuals, and a forecast window past the
  // ~D+2 horizon anything is stored for.
  it('clamps forward navigation at the live position', () => {
    useDashboardStore.getState().shiftTimeWindow('forward');
    expect(useDashboardStore.getState().timeOffset).toBe(0);

    useDashboardStore.getState().shiftTimeWindow('back');
    useDashboardStore.getState().shiftTimeWindow('forward');
    useDashboardStore.getState().shiftTimeWindow('forward');
    expect(useDashboardStore.getState().timeOffset).toBe(0);
  });

  it('never leaves the offset positive, whatever the sequence', () => {
    for (const dir of ['forward', 'back', 'forward', 'forward', 'back', 'back'] as const) {
      useDashboardStore.getState().shiftTimeWindow(dir);
      expect(useDashboardStore.getState().timeOffset).toBeLessThanOrEqual(0);
    }
  });

  it('walking back then forward the same number of steps returns to live', () => {
    useDashboardStore.setState({ timePreset: 'today', timeOffset: 0 });
    useDashboardStore.getState().shiftTimeWindow('back');
    useDashboardStore.getState().shiftTimeWindow('back');
    expect(useDashboardStore.getState().timeOffset).toBe(-48);
    useDashboardStore.getState().shiftTimeWindow('forward');
    useDashboardStore.getState().shiftTimeWindow('forward');
    expect(useDashboardStore.getState().timeOffset).toBe(0);
  });

  it('drops out of live as soon as the window moves', () => {
    useDashboardStore.setState({ timePreset: 'today', timeOffset: 0, isLive: true });
    useDashboardStore.getState().shiftTimeWindow('back');
    expect(useDashboardStore.getState().isLive).toBe(false);
  });
});

describe('jumpToLive', () => {
  it('returns to the current market day from a shifted window', () => {
    useDashboardStore.setState({ timePreset: '30d', timeAnchor: 'past', timeOffset: -360, isLive: false });
    useDashboardStore.getState().jumpToLive();

    const s = useDashboardStore.getState();
    expect(s.timePreset).toBe('today');
    expect(s.timeAnchor).toBe('now');
    expect(s.timeOffset).toBe(0);
    expect(s.isLive).toBe(true);
  });
});

describe('setTimePreset', () => {
  // The picker's quick buttons show as active only at offset 0, so choosing a
  // preset has to actually return to the live position rather than carry a
  // stale offset into a window whose label no longer accounts for it.
  it('resets a shifted window back to the live position', () => {
    useDashboardStore.setState({ timePreset: '7d', timeOffset: -84 });
    useDashboardStore.getState().setTimePreset('24h');
    expect(useDashboardStore.getState().timeOffset).toBe(0);
  });
});

// Everything above would still pass with the persist middleware disabled — and
// for the whole life of this file it *was* disabled, because vitest ran without
// a usable `localStorage` and zustand degrades to a no-op when it cannot get
// one (ABL-320). These assertions are what tell the difference: they fail if
// the store stops persisting, which is the state the rest of the file cannot
// see. `migratePersisted` and `PERSIST_VERSION` exist to protect this blob.
describe('persisted blob', () => {
  const KEY = 'energy-dashboard-storage';

  const readBlob = () => {
    const raw = globalThis.localStorage.getItem(KEY);
    expect(raw, `nothing was written to ${KEY} — is the persist middleware live?`).not.toBeNull();
    return JSON.parse(raw as string) as { state: Record<string, unknown>; version: number };
  };

  it('writes a state change through to storage, stamped with the current version', () => {
    useDashboardStore.setState({ selectedCountry: 'PT' });

    const blob = readBlob();
    expect(blob.version).toBe(PERSIST_VERSION);
    expect(blob.state.selectedCountry).toBe('PT');
  });

  it('carries only the partialized keys, not the whole store', () => {
    useDashboardStore.setState({ selectedCountry: 'PT' });
    const { state } = readBlob();

    // Partialized in, so a reload restores them.
    expect(state).toHaveProperty('selectedCountry');
    expect(state).toHaveProperty('timePreset');

    // Deliberately out: `servedModelByType` describes the last network
    // response, and `timeOffset` is a live cursor. Persisting either would
    // restore a stale answer as though it had just been fetched.
    expect(state).not.toHaveProperty('servedModelByType');
    expect(state).not.toHaveProperty('timeOffset');

    // Actions are not state; zustand would happily serialise them to null.
    expect(state).not.toHaveProperty('setTimePreset');
  });
});
