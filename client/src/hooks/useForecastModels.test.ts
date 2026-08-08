import { describe, it, expect } from 'vitest';
import { resolveSelection } from './useForecastModels';
import type { ForecastModelRegistry } from '@/types';

const REGISTRY: ForecastModelRegistry = {
  load: {
    production: 'catboost',
    models: [
      { id: 'catboost', label: 'able-ml · catboost', source: 'ml', modelName: 'catboost' },
      { id: 'xgboost', label: 'able-ml · xgboost', source: 'ml', modelName: 'xgboost' },
    ],
  },
};

describe('resolveSelection', () => {
  it('does not pin a model when the user has not chosen one', () => {
    const r = resolveSelection(REGISTRY, 'load', undefined, false);
    expect(r.requestModelId).toBeUndefined();
    expect(r.selected?.id).toBe('catboost');
    expect(r.hidden).toBe(false);
  });

  it('pins the model when the user chose one explicitly', () => {
    const r = resolveSelection(REGISTRY, 'load', 'xgboost', false);
    expect(r.requestModelId).toBe('xgboost');
    expect(r.selected?.id).toBe('xgboost');
  });

  it('hides the forecast when the overlay is switched off', () => {
    const r = resolveSelection(REGISTRY, 'load', undefined, true);
    expect(r.hidden).toBe(true);
    expect(r.selected).toBeNull();
    expect(r.requestModelId).toBeUndefined();
  });

  // Hiding used to overwrite the pin (they shared one persisted slot), so
  // showing again had to fabricate one. They are independent now: the pin
  // survives an off/on cycle untouched. ABL-16.
  it('keeps the pin while hidden and restores it when shown again', () => {
    const off = resolveSelection(REGISTRY, 'load', 'xgboost', true);
    expect(off.hidden).toBe(true);
    expect(off.requestModelId).toBeUndefined(); // nothing requested while off

    const on = resolveSelection(REGISTRY, 'load', 'xgboost', false);
    expect(on.requestModelId).toBe('xgboost');
    expect(on.selected?.id).toBe('xgboost');
  });

  // The state the whole fix exists to protect: no pin means no `model=` on the
  // wire, which is the only way the server reaches its fallback ladder and
  // serves a country the production model does not cover.
  it('sends nothing on the wire once a pin is cleared', () => {
    const pinned = resolveSelection(REGISTRY, 'load', 'catboost', false);
    expect(pinned.requestModelId).toBe('catboost');

    const cleared = resolveSelection(REGISTRY, 'load', undefined, false);
    expect(cleared.requestModelId).toBeUndefined();
    // Still labelled with production — a label is not an instruction.
    expect(cleared.selected?.id).toBe('catboost');
  });

  it('falls back to production when the stored id is no longer registered', () => {
    const r = resolveSelection(REGISTRY, 'load', 'removed-model', false);
    expect(r.selected?.id).toBe('catboost');
    expect(r.requestModelId).toBeUndefined();
  });

  // Defensive: a `null` can only reach here from a pre-v7 blob that dodged the
  // migration. It means "no pin", never "hidden" — hidden is its own argument.
  it('treats a leftover null pin as no pin, not as hidden', () => {
    const r = resolveSelection(REGISTRY, 'load', null, false);
    expect(r.hidden).toBe(false);
    expect(r.requestModelId).toBeUndefined();
    expect(r.selected?.id).toBe('catboost');
  });
});
