import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  shouldScheduleForecastVintageArchive,
  describeSchedulerStart,
  startForecastVintageArchiveScheduler,
} from './forecastVintageArchiveScheduler.js';

describe('shouldScheduleForecastVintageArchive', () => {
  it('is false when HELIO_WRITE_TOKEN is unset — matches getWriteDb() never opening', () => {
    expect(shouldScheduleForecastVintageArchive({})).toBe(false);
  });

  it('is false for an empty-string token, same as writeAuth treats it as disabled', () => {
    expect(shouldScheduleForecastVintageArchive({ HELIO_WRITE_TOKEN: '' })).toBe(false);
  });

  it('is true once HELIO_WRITE_TOKEN is set to any non-empty value', () => {
    expect(shouldScheduleForecastVintageArchive({ HELIO_WRITE_TOKEN: 'secret' })).toBe(true);
  });
});

describe('describeSchedulerStart', () => {
  it('reports disabled with a reason naming the missing token', () => {
    const decision = describeSchedulerStart({});
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain('HELIO_WRITE_TOKEN is not set');
  });

  it('reports enabled with the interval in minutes', () => {
    const decision = describeSchedulerStart({ HELIO_WRITE_TOKEN: 'secret' }, 900_000);
    expect(decision.enabled).toBe(true);
    expect(decision.reason).toContain('15m');
  });
});

describe('startForecastVintageArchiveScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null and never calls runCapture when the token is unset', () => {
    const runCapture = vi.fn();
    const handle = startForecastVintageArchiveScheduler({}, 1000, runCapture);
    expect(handle).toBeNull();
    expect(runCapture).not.toHaveBeenCalled();
  });

  it('runs once immediately when the token is set', async () => {
    const runCapture = vi.fn().mockResolvedValue({
      ml: 0, tsoLoad: 0, tsoSolar: 0, tsoWindOnshore: 0, tsoWindOffshore: 0, total: 0,
    });
    const handle = startForecastVintageArchiveScheduler({ HELIO_WRITE_TOKEN: 'secret' }, 1000, runCapture);
    expect(handle).not.toBeNull();
    await vi.waitFor(() => expect(runCapture).toHaveBeenCalledTimes(1));
    handle?.stop();
  });

  it('runs again after the interval elapses', async () => {
    const runCapture = vi.fn().mockResolvedValue({
      ml: 0, tsoLoad: 0, tsoSolar: 0, tsoWindOnshore: 0, tsoWindOffshore: 0, total: 0,
    });
    const handle = startForecastVintageArchiveScheduler({ HELIO_WRITE_TOKEN: 'secret' }, 1000, runCapture);
    await vi.waitFor(() => expect(runCapture).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(runCapture).toHaveBeenCalledTimes(2));
    handle?.stop();
  });

  it('skips a tick rather than overlapping when the previous capture is still running', async () => {
    let resolveFirst: (() => void) | undefined;
    const runCapture = vi.fn().mockImplementation(
      () =>
        new Promise<{ ml: number; tsoLoad: number; tsoSolar: number; tsoWindOnshore: number; tsoWindOffshore: number; total: number }>(
          (resolve) => {
            resolveFirst = () =>
              resolve({ ml: 0, tsoLoad: 0, tsoSolar: 0, tsoWindOnshore: 0, tsoWindOffshore: 0, total: 0 });
          }
        )
    );

    const handle = startForecastVintageArchiveScheduler({ HELIO_WRITE_TOKEN: 'secret' }, 1000, runCapture);
    await vi.waitFor(() => expect(runCapture).toHaveBeenCalledTimes(1));

    // The interval fires while the first call is still pending — must not overlap.
    await vi.advanceTimersByTimeAsync(1000);
    expect(runCapture).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await vi.waitFor(() => expect(runCapture).toHaveBeenCalledTimes(1));
    handle?.stop();
  });

  it('stop() prevents any further scheduled call', async () => {
    const runCapture = vi.fn().mockResolvedValue({
      ml: 0, tsoLoad: 0, tsoSolar: 0, tsoWindOnshore: 0, tsoWindOffshore: 0, total: 0,
    });
    const handle = startForecastVintageArchiveScheduler({ HELIO_WRITE_TOKEN: 'secret' }, 1000, runCapture);
    await vi.waitFor(() => expect(runCapture).toHaveBeenCalledTimes(1));

    handle?.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runCapture).toHaveBeenCalledTimes(1);
  });
});
