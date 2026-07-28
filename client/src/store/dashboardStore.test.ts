import { describe, it, expect, beforeEach } from 'vitest';
import { useDashboardStore } from './dashboardStore';

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
