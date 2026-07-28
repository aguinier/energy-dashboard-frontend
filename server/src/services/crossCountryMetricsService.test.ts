import { describe, it, expect, vi } from 'vitest';

// The module under test imports the shared database connection, which opens
// a real SQLite file at import time (same pattern as renewableService.test.ts
// and netPositionService.test.ts). `wape` is a pure function and never
// touches `db`, so the default export just needs to not exist.
vi.mock('../config/database.js', () => ({ default: null }));

const { wape } = await import('./crossCountryMetricsService.js');

describe('wape', () => {
  it('is zero for a perfect forecast', () => {
    expect(wape([{ actual: 50, forecast: 50 }, { actual: 20, forecast: 20 }])).toBe(0);
  });

  it('does not explode on a near-zero actual', () => {
    const v = wape([{ actual: 0.01, forecast: 5 }, { actual: 100, forecast: 100 }]);
    expect(v).toBeLessThan(20);
  });

  it('does not let negative actuals cancel error', () => {
    const v = wape([{ actual: -50, forecast: 0 }, { actual: 50, forecast: 0 }]);
    expect(v).toBe(100);
  });

  it('returns null when the summed magnitude is zero', () => {
    expect(wape([{ actual: 0, forecast: 3 }])).toBeNull();
  });

  it('returns null for an empty series', () => {
    expect(wape([])).toBeNull();
  });
});
