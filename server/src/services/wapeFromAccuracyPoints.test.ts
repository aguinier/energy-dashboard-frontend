import { describe, it, expect } from 'vitest';
import { wapeFromAccuracyPoints } from './wapeFromAccuracyPoints.js';

describe('wapeFromAccuracyPoints', () => {
  it('reconstructs forecast as actual - error and reduces through wape()', () => {
    // error is actual - forecast, so forecast = 90 and 110 respectively.
    // WAPE = 100 * (|10| + |-10|) / (100 + 100) = 10
    expect(wapeFromAccuracyPoints([
      { actual_value: 100, error: 10 },
      { actual_value: 100, error: -10 },
    ])).toBe(10);
  });

  it('weights by magnitude, so a big actual dominates a small one', () => {
    // 100 * (5 + 5) / (1000 + 10) = 0.99
    expect(wapeFromAccuracyPoints([
      { actual_value: 1000, error: 5 },
      { actual_value: 10, error: 5 },
    ])).toBe(0.99);
  });

  it('returns null when the actuals sum to zero rather than dividing by it', () => {
    expect(wapeFromAccuracyPoints([{ actual_value: 0, error: 5 }])).toBeNull();
  });

  it('returns null on an empty window', () => {
    expect(wapeFromAccuracyPoints([])).toBeNull();
  });
});
