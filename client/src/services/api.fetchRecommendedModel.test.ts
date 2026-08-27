/**
 * Verifies that fetchRecommendedModel returns null (not undefined) when the
 * server omits the `recommended` key — React Query throws on undefined queryFn
 * results (ABL-543).
 */
import { describe, it, expect, vi } from 'vitest';

const mockGet = vi.fn();

vi.mock('axios', () => ({
  default: {
    create: () => ({
      get: mockGet,
      interceptors: {
        request: { use: vi.fn() },
        response: { use: vi.fn() },
      },
    }),
  },
}));

// Import AFTER the mock is set up (vitest hoists vi.mock automatically)
const { fetchRecommendedModel } = await import('./api');

describe('fetchRecommendedModel', () => {
  it('returns null when server omits recommended (React Query contract)', async () => {
    mockGet.mockResolvedValueOnce({
      data: { success: true, data: { load: { production: 'catboost', models: [] } } },
    });
    const result = await fetchRecommendedModel({ country: 'DE', type: 'load' });
    expect(result).toBeNull();
  });

  it('returns the recommendation object when present', async () => {
    const rec = {
      modelId: 'catboost',
      label: 'able-ml · catboost',
      source: 'ml',
      wape: 4.2,
      dataPoints: 720,
      fallback: false,
      windowStart: '2026-07-01T00:00:00',
      windowEnd: '2026-07-31T23:00:00',
      windowDays: 30,
      candidates: [],
    };
    mockGet.mockResolvedValueOnce({
      data: { success: true, data: { load: { production: 'catboost', models: [], recommended: rec } } },
    });
    const result = await fetchRecommendedModel({ country: 'DE', type: 'load' });
    expect(result).toEqual(rec);
  });
});
