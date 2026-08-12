import { describe, it, expect } from 'vitest';
import { checkSyncBlackoutWindow } from './syncBlackoutWindow.js';

const at = (hour: number, minute: number) => new Date(2026, 7, 11, hour, minute, 0);

describe('checkSyncBlackoutWindow', () => {
  it('is inactive well outside either window', () => {
    expect(checkSyncBlackoutWindow(at(12, 0))).toEqual({ active: false, label: null });
  });

  it('is active right at the 07:00 scheduled start', () => {
    expect(checkSyncBlackoutWindow(at(7, 0))).toEqual({ active: true, label: '~07:00 daily DB sync' });
  });

  it('is active a couple minutes before 07:00 — the task can fire early', () => {
    expect(checkSyncBlackoutWindow(at(6, 58)).active).toBe(true);
  });

  it('is inactive just before the 07:00 pad starts', () => {
    expect(checkSyncBlackoutWindow(at(6, 57)).active).toBe(false);
  });

  it('is active 34m07s after 07:00 — the ABL-249 incident (forecast_vintage_archive swept into Stage 2)', () => {
    expect(checkSyncBlackoutWindow(at(7, 34)).active).toBe(true);
  });

  it('is active at the padded 07:00 tail, 60 minutes out', () => {
    expect(checkSyncBlackoutWindow(at(8, 0)).active).toBe(true);
  });

  it('is inactive just past the padded 07:00 tail', () => {
    expect(checkSyncBlackoutWindow(at(8, 1)).active).toBe(false);
  });

  it('is active at 16:30, the scheduled start of the second window', () => {
    const status = checkSyncBlackoutWindow(at(16, 30));
    expect(status).toEqual({ active: true, label: '~16:30 daily DB sync' });
  });

  it('is active at the padded 16:30 tail, 60 minutes out', () => {
    expect(checkSyncBlackoutWindow(at(17, 30)).active).toBe(true);
  });

  it('is inactive just past the padded 16:30 tail', () => {
    expect(checkSyncBlackoutWindow(at(17, 31)).active).toBe(false);
  });
});
