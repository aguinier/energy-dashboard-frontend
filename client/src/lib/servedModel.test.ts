import { describe, it, expect } from 'vitest';
import { servedLabel } from './servedModel';
import type { ForecastModel } from '@/types';

const MODELS: ForecastModel[] = [
  { id: 'catboost', label: 'able-ml · catboost', source: 'ml', modelName: 'catboost' },
  { id: 'xgboost', label: 'able-ml · xgboost', source: 'ml', modelName: 'xgboost' },
];

describe('servedLabel', () => {
  it('shows the served model when it differs from the provisional one', () => {
    expect(servedLabel(MODELS, 'xgboost', MODELS[0])).toBe('able-ml · xgboost');
  });

  it('shows the provisional label before a response arrives', () => {
    expect(servedLabel(MODELS, null, MODELS[0])).toBe('able-ml · catboost');
  });

  it('falls back to the raw id when the served model is unregistered', () => {
    expect(servedLabel(MODELS, 'mystery', MODELS[0])).toBe('mystery');
  });

  it('returns empty string when nothing is selected', () => {
    expect(servedLabel(MODELS, null, null)).toBe('');
  });
});
