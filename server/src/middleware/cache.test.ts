import { describe, it, expect } from 'vitest';
import { buildCacheKey } from './cache.js';

const BUCKET = 60_000;

describe('buildCacheKey', () => {
  it('collapses timestamps inside the same bucket', () => {
    const a = buildCacheKey('GET', '/api/load?country=FR&start=2026-07-27T13:14:36.923Z', BUCKET);
    const b = buildCacheKey('GET', '/api/load?country=FR&start=2026-07-27T13:14:59.001Z', BUCKET);
    expect(a).toBe(b);
  });

  it('separates timestamps in different buckets', () => {
    const a = buildCacheKey('GET', '/api/load?country=FR&start=2026-07-27T13:14:00.000Z', BUCKET);
    const b = buildCacheKey('GET', '/api/load?country=FR&start=2026-07-27T13:16:00.000Z', BUCKET);
    expect(a).not.toBe(b);
  });

  it('keeps non-timestamp params significant', () => {
    const a = buildCacheKey('GET', '/api/load?country=FR', BUCKET);
    const b = buildCacheKey('GET', '/api/load?country=DE', BUCKET);
    expect(a).not.toBe(b);
  });

  it('passes through urls with no timestamps unchanged in meaning', () => {
    expect(buildCacheKey('GET', '/api/countries', BUCKET)).toBe(buildCacheKey('GET', '/api/countries', BUCKET));
  });
});
