import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  shouldScheduleCoreNetPositionCapture,
  describeCoreNetPositionSchedulerStart,
  computeCaptureWindow,
  startCoreNetPositionScheduler,
} from './coreNetPositionScheduler.js';

describe('shouldScheduleCoreNetPositionCapture', () => {
  it('is false when neither var is set', () => {
    expect(shouldScheduleCoreNetPositionCapture({})).toBe(false);
  });

  it('is false when only JAO_CORE_NET_POSITION_ENABLED is set — a write connection still cannot be assumed', () => {
    expect(shouldScheduleCoreNetPositionCapture({ JAO_CORE_NET_POSITION_ENABLED: 'true' })).toBe(false);
  });

  it('is false when only HELIO_WRITE_TOKEN is set — reusing it alone would enable this without a deliberate opt-in', () => {
    expect(shouldScheduleCoreNetPositionCapture({ HELIO_WRITE_TOKEN: 'secret' })).toBe(false);
  });

  it('is true once both are set to any non-empty value', () => {
    expect(
      shouldScheduleCoreNetPositionCapture({ JAO_CORE_NET_POSITION_ENABLED: '1', HELIO_WRITE_TOKEN: 'secret' })
    ).toBe(true);
  });

  it('is false for an empty-string value on either var', () => {
    expect(
      shouldScheduleCoreNetPositionCapture({ JAO_CORE_NET_POSITION_ENABLED: '', HELIO_WRITE_TOKEN: 'secret' })
    ).toBe(false);
  });
});

describe('describeCoreNetPositionSchedulerStart', () => {
  it('names the missing var when only the enable flag is missing', () => {
    const decision = describeCoreNetPositionSchedulerStart({ HELIO_WRITE_TOKEN: 'secret' });
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain('JAO_CORE_NET_POSITION_ENABLED is not set');
  });

  it('names the missing var when only HELIO_WRITE_TOKEN is missing', () => {
    const decision = describeCoreNetPositionSchedulerStart({ JAO_CORE_NET_POSITION_ENABLED: '1' });
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain('HELIO_WRITE_TOKEN is not set');
  });

  it('reports enabled with the interval in minutes', () => {
    const decision = describeCoreNetPositionSchedulerStart(
      { JAO_CORE_NET_POSITION_ENABLED: '1', HELIO_WRITE_TOKEN: 'secret' },
      900_000
    );
    expect(decision.enabled).toBe(true);
    expect(decision.reason).toContain('15m');
  });
});

describe('computeCaptureWindow', () => {
  it('defaults to a 7-day trailing window ending at "now"', () => {
    const now = new Date('2026-08-11T20:00:00.000Z');
    expect(computeCaptureWindow(now)).toEqual({
      fromUtc: '2026-08-04T20:00:00Z',
      toUtc: '2026-08-11T20:00:00Z',
    });
  });

  it('honours a custom window size', () => {
    const now = new Date('2026-08-11T00:00:00.000Z');
    expect(computeCaptureWindow(now, 1)).toEqual({
      fromUtc: '2026-08-10T00:00:00Z',
      toUtc: '2026-08-11T00:00:00Z',
    });
  });
});

describe('startCoreNetPositionScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const bothSet = { JAO_CORE_NET_POSITION_ENABLED: '1', HELIO_WRITE_TOKEN: 'secret' };

  it('returns null and never calls runCapture when disabled', () => {
    const runCapture = vi.fn();
    const handle = startCoreNetPositionScheduler({}, 1000, runCapture);
    expect(handle).toBeNull();
    expect(runCapture).not.toHaveBeenCalled();
  });

  it('runs once immediately when enabled', async () => {
    const runCapture = vi.fn().mockResolvedValue({ parsed: 0, inserted: 0 });
    const handle = startCoreNetPositionScheduler(bothSet, 1000, runCapture);
    expect(handle).not.toBeNull();
    await vi.waitFor(() => expect(runCapture).toHaveBeenCalledTimes(1));
    handle?.stop();
  });

  it('runs again after the interval elapses', async () => {
    const runCapture = vi.fn().mockResolvedValue({ parsed: 0, inserted: 0 });
    const handle = startCoreNetPositionScheduler(bothSet, 1000, runCapture);
    await vi.waitFor(() => expect(runCapture).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(runCapture).toHaveBeenCalledTimes(2));
    handle?.stop();
  });

  it('skips a tick rather than overlapping when the previous capture is still running', async () => {
    let resolveFirst: (() => void) | undefined;
    const runCapture = vi.fn().mockImplementation(
      () =>
        new Promise<{ parsed: number; inserted: number }>((resolve) => {
          resolveFirst = () => resolve({ parsed: 0, inserted: 0 });
        })
    );

    const handle = startCoreNetPositionScheduler(bothSet, 1000, runCapture);
    await vi.waitFor(() => expect(runCapture).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(1000);
    expect(runCapture).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await vi.waitFor(() => expect(runCapture).toHaveBeenCalledTimes(1));
    handle?.stop();
  });

  it('stop() prevents any further scheduled call', async () => {
    const runCapture = vi.fn().mockResolvedValue({ parsed: 0, inserted: 0 });
    const handle = startCoreNetPositionScheduler(bothSet, 1000, runCapture);
    await vi.waitFor(() => expect(runCapture).toHaveBeenCalledTimes(1));

    handle?.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runCapture).toHaveBeenCalledTimes(1);
  });
});
