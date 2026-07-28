import { describe, it, expect } from 'vitest';
import { shouldRetryQuery } from './queryRetry';

describe('shouldRetryQuery', () => {
  it('never retries a 4xx — asking again cannot fix a client error', () => {
    expect(shouldRetryQuery(0, { response: { status: 404 } })).toBe(false);
    expect(shouldRetryQuery(0, { response: { status: 400 } })).toBe(false);
    expect(shouldRetryQuery(0, { response: { status: 499 } })).toBe(false);
  });

  it('allows exactly one retry on a 5xx, then stops', () => {
    const error = { response: { status: 500 } };
    expect(shouldRetryQuery(0, error)).toBe(true);
    expect(shouldRetryQuery(1, error)).toBe(false);
  });

  it('allows exactly one retry on a timeout with no response, then stops', () => {
    // axios ECONNABORTED: no `response` at all, so `status` is undefined.
    // On this single-threaded backend a timeout usually means the request
    // thread was busy with someone else's slow query, so one bounded retry
    // is worth it — but never more than the 5xx/network case gets.
    const timeoutError = { code: 'ECONNABORTED', message: 'timeout of 15000ms exceeded' };
    expect(shouldRetryQuery(0, timeoutError)).toBe(true);
    expect(shouldRetryQuery(1, timeoutError)).toBe(false);
  });

  it('treats a bare network error (no response, no status) the same as a timeout', () => {
    const networkError = { message: 'Network Error' };
    expect(shouldRetryQuery(0, networkError)).toBe(true);
    expect(shouldRetryQuery(1, networkError)).toBe(false);
  });

  it('never retries past the failureCount ceiling, regardless of error shape', () => {
    expect(shouldRetryQuery(2, { response: { status: 500 } })).toBe(false);
    expect(shouldRetryQuery(5, undefined)).toBe(false);
  });

  it('is defensive against a missing or malformed error object', () => {
    expect(shouldRetryQuery(0, undefined)).toBe(true);
    expect(shouldRetryQuery(0, null)).toBe(true);
    expect(shouldRetryQuery(0, 'boom')).toBe(true);
    expect(shouldRetryQuery(0, {})).toBe(true);
  });
});
