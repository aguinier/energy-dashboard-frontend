import { describe, it, expect } from 'vitest';
import { trailingGapLabel } from './trailingGap';

const NOW = new Date('2026-07-27T13:00:00Z');

describe('trailingGapLabel', () => {
  it('stays silent when actuals are current', () => {
    expect(trailingGapLabel('2026-07-27T12:30:00Z', NOW)).toBeNull();
  });

  it('names the lag once it exceeds the threshold', () => {
    expect(trailingGapLabel('2026-07-27T06:00:00Z', NOW)).toBe('last actual 7h ago');
  });

  it('rounds down to whole hours', () => {
    expect(trailingGapLabel('2026-07-27T05:45:00Z', NOW)).toBe('last actual 7h ago');
  });

  it('returns null for a missing or unparseable timestamp', () => {
    expect(trailingGapLabel(undefined, NOW)).toBeNull();
    expect(trailingGapLabel('not-a-date', NOW)).toBeNull();
  });
});
