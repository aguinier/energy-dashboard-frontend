import { describe, it, expect } from 'vitest';
import { resolveSelection, resolveMultiSelection } from './useForecastModels';
import type { ForecastModelRegistry, RecommendedModel } from '@/types';

const REGISTRY: ForecastModelRegistry = {
  load: {
    production: 'catboost',
    models: [
      { id: 'catboost', label: 'able-ml · catboost', source: 'ml', modelName: 'catboost' },
      { id: 'xgboost', label: 'able-ml · xgboost', source: 'ml', modelName: 'xgboost' },
      { id: 'tso-d1', label: 'ENTSO-E TSO · D+1', source: 'tso', tsoHorizon: 'day_ahead' },
    ],
  },
  net_position: {
    production: 'chronos-2-V010',
    models: [
      { id: 'chronos-2-V010', label: 'Chronos-2 · V010', source: 'ml', modelName: 'chronos-2-V010' },
      { id: 'baseline-V012', label: 'Baseline · V012', source: 'ml', modelName: 'baseline-V012' },
      { id: 'xgboost-V014', label: 'XGBoost · V014', source: 'ml', modelName: 'xgboost-V014' },
      { id: 'chronos-2-V016', label: 'Chronos-2 · V016', source: 'ml', modelName: 'chronos-2-V016' },
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

// ABL-469. The default is resolved per (country, forecast type) from measured
// accuracy across both sources, instead of from the type's one hand-picked
// `production` id. Two properties carry the whole change: the recommendation
// decides what is *displayed*, and it still never reaches the wire.
describe('resolveSelection — auto-selection', () => {
  const tsoWins: RecommendedModel = {
    modelId: 'tso-d1',
    label: 'ENTSO-E TSO · D+1',
    source: 'tso',
    wape: 3.45,
    dataPoints: 721,
    fallback: false,
    windowStart: '2026-07-21T00:00:00.000Z',
    windowEnd: '2026-08-20T00:00:00.000Z',
    windowDays: 30,
    candidates: [
      { id: 'tso-d1', label: 'ENTSO-E TSO · D+1', source: 'tso', wape: 3.45, dataPoints: 721, hoursCovered: 720, excluded: null },
      { id: 'catboost', label: 'able-ml · catboost', source: 'ml', wape: 6.75, dataPoints: 721, hoursCovered: 720, excluded: null },
    ],
  };

  it('displays the ENTSO-E series where it measures better than ours', () => {
    const r = resolveSelection(REGISTRY, 'load', undefined, false, tsoWins);
    expect(r.selected?.id).toBe('tso-d1');
    expect(r.selected?.source).toBe('tso');
    expect(r.autoSelected).toBe(tsoWins);
  });

  // The property CLAUDE.md's "client sends model= only when the user picked
  // one" claim depends on. A recommendation is measured over the last 30 days
  // and says nothing about a window the user has shifted back six months;
  // pinning it there would blank the chart exactly where the server's fallback
  // ladder exists to cover.
  it('never puts the recommended id on the wire', () => {
    const r = resolveSelection(REGISTRY, 'load', undefined, false, tsoWins);
    expect(r.requestModelId).toBeUndefined();
  });

  it('leaves a user pin untouched, and does not label it as auto-selected', () => {
    const r = resolveSelection(REGISTRY, 'load', 'xgboost', false, tsoWins);
    expect(r.selected?.id).toBe('xgboost');
    expect(r.requestModelId).toBe('xgboost');
    expect(r.autoSelected).toBeNull();
  });

  it('resolves to production, unlabelled, when nothing has a track record yet', () => {
    const noHistory: RecommendedModel = {
      ...tsoWins,
      modelId: 'catboost',
      label: 'able-ml · catboost',
      source: 'ml',
      wape: null,
      dataPoints: 0,
      fallback: true,
    };
    const r = resolveSelection(REGISTRY, 'load', undefined, false, noHistory);
    expect(r.selected?.id).toBe('catboost');
    expect(r.autoSelected).toBeNull();
  });

  it('ignores a recommendation naming a model that is no longer registered', () => {
    const stale: RecommendedModel = { ...tsoWins, modelId: 'retired-model' };
    const r = resolveSelection(REGISTRY, 'load', undefined, false, stale);
    expect(r.selected?.id).toBe('catboost');
    expect(r.autoSelected).toBeNull();
  });

  it('stays on production, unlabelled, before the measurement lands', () => {
    const r = resolveSelection(REGISTRY, 'load', undefined, false, undefined);
    expect(r.selected?.id).toBe('catboost');
    expect(r.autoSelected).toBeNull();
  });

  it('labels nothing while the overlay is switched off', () => {
    const r = resolveSelection(REGISTRY, 'load', undefined, false, tsoWins);
    expect(r.autoSelected).not.toBeNull();
    const off = resolveSelection(REGISTRY, 'load', undefined, true, tsoWins);
    expect(off.autoSelected).toBeNull();
    expect(off.selected).toBeNull();
  });

  // An ml recommendation is not self-evidently what got drawn: nothing is
  // pinned, so the server's coverage ladder chooses between our models and
  // could serve one while the measurement named another. The label waits for
  // `meta.model` to agree, so it can never name a model that did not draw the
  // line. A tso recommendation needs no such check — the tab fetches that
  // horizon directly.
  describe('an ml label waits for the served model to agree', () => {
    const mlWins: RecommendedModel = {
      ...tsoWins,
      modelId: 'catboost',
      label: 'able-ml · catboost',
      source: 'ml',
      wape: 2.10,
    };

    it('labels our model once the response confirms it served', () => {
      const r = resolveSelection(REGISTRY, 'load', undefined, false, mlWins, 'catboost');
      expect(r.selected?.id).toBe('catboost');
      expect(r.autoSelected).toBe(mlWins);
    });

    it('withholds the label when the ladder served a different model', () => {
      const r = resolveSelection(REGISTRY, 'load', undefined, false, mlWins, 'xgboost');
      expect(r.autoSelected).toBeNull();
    });

    it('withholds the label until a response has been seen at all', () => {
      const r = resolveSelection(REGISTRY, 'load', undefined, false, mlWins, undefined);
      expect(r.autoSelected).toBeNull();
    });

    it('labels a tso winner without waiting, since the tab fetches it directly', () => {
      const r = resolveSelection(REGISTRY, 'load', undefined, false, tsoWins, undefined);
      expect(r.autoSelected).toBe(tsoWins);
    });
  });
});

describe('resolveMultiSelection', () => {
  it('is empty ("Default") when nothing is pinned', () => {
    const r = resolveMultiSelection(REGISTRY, 'net_position', undefined, false);
    expect(r.selectedIds).toEqual([]);
    expect(r.models).toHaveLength(4);
    expect(r.hidden).toBe(false);
  });

  it('carries every pinned id through, in the order given', () => {
    const r = resolveMultiSelection(
      REGISTRY,
      'net_position',
      ['xgboost-V014', 'chronos-2-V010'],
      false,
    );
    expect(r.selectedIds).toEqual(['xgboost-V014', 'chronos-2-V010']);
  });

  it('a single stored pin resolves to a one-element selection — the v9 migration path', () => {
    const r = resolveMultiSelection(REGISTRY, 'net_position', ['baseline-V012'], false);
    expect(r.selectedIds).toEqual(['baseline-V012']);
  });

  it('drops ids no longer registered rather than sending them on the wire', () => {
    const r = resolveMultiSelection(
      REGISTRY,
      'net_position',
      ['chronos-2-V010', 'retired-model'],
      false,
    );
    expect(r.selectedIds).toEqual(['chronos-2-V010']);
  });

  it('de-duplicates a repeated id', () => {
    const r = resolveMultiSelection(
      REGISTRY,
      'net_position',
      ['chronos-2-V010', 'chronos-2-V010'],
      false,
    );
    expect(r.selectedIds).toEqual(['chronos-2-V010']);
  });

  it('empties the selection when hidden, without losing what was pinned in the store', () => {
    const r = resolveMultiSelection(
      REGISTRY,
      'net_position',
      ['chronos-2-V010', 'baseline-V012'],
      true,
    );
    expect(r.hidden).toBe(true);
    expect(r.selectedIds).toEqual([]);
    // models still populated, so a picker toggled back on has something to show
    expect(r.models).toHaveLength(4);
  });

  it('is empty for an unknown forecast type', () => {
    const r = resolveMultiSelection(REGISTRY, 'solar', ['catboost'], false);
    expect(r.models).toEqual([]);
    expect(r.selectedIds).toEqual([]);
  });
});
