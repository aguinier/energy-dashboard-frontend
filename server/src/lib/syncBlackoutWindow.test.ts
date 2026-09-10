import { describe, it, expect } from 'vitest';
import { checkSyncBlackoutWindow, SYNC_HOST_TIME_ZONE } from './syncBlackoutWindow.js';

/**
 * A wall-clock instant **in the acceptance workstation's zone**, expressed as a
 * real UTC instant — which is the only way to write these now that the check no
 * longer reads the process's own clock (ABL-657).
 *
 * 2026-08-11 is inside CEST, so host-local is UTC+2. Every case below is
 * written as `at(h, m)` meaning "the host's clock reads h:m", and the suite
 * therefore passes identically on a UTC container and a CEST workstation —
 * which is exactly the property that was missing.
 */
const at = (hour: number, minute: number) =>
  new Date(Date.UTC(2026, 7, 11, hour - 2, minute, 0));

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

  it('is active 44m06s after 07:00 — the ABL-672 07:00 max (2026-09-02)', () => {
    expect(checkSyncBlackoutWindow(at(7, 44)).active).toBe(true);
  });

  it('is active at the padded 07:00 tail, 75 minutes out', () => {
    expect(checkSyncBlackoutWindow(at(8, 15)).active).toBe(true);
  });

  it('is inactive just past the padded 07:00 tail', () => {
    expect(checkSyncBlackoutWindow(at(8, 16)).active).toBe(false);
  });

  it('is active at 16:30, the scheduled start of the second window', () => {
    const status = checkSyncBlackoutWindow(at(16, 30));
    expect(status).toEqual({ active: true, label: '~16:30 daily DB sync' });
  });

  it('is active 138m21s after 16:30 — the ABL-672 16:30 max (2026-08-28)', () => {
    expect(checkSyncBlackoutWindow(at(18, 48)).active).toBe(true);
  });

  it('is active at the padded 16:30 tail, 180 minutes out', () => {
    expect(checkSyncBlackoutWindow(at(19, 30)).active).toBe(true);
  });

  it('is inactive just past the padded 16:30 tail', () => {
    expect(checkSyncBlackoutWindow(at(19, 31)).active).toBe(false);
  });
});

/**
 * ABL-657 — the defect this file exists to keep fixed.
 *
 * `docker/Dockerfile` sets no `TZ` and `node:20-slim` is `Etc/UTC`, so the old
 * `now.getHours()` read UTC hours against a schedule written in the
 * workstation's wall clock. Neither window ever matched inside the acceptance
 * container, and the reachability alert went `error` instead of the intended
 * `warn` on every one of the 172 breaches ABL-634 counted.
 *
 * These cases are the **real UTC instants from that issue's breach table**, so
 * they fail against the pre-fix implementation on any machine whose zone is not
 * the workstation's — including CI and a UTC container.
 */
describe('ABL-634 breach instants, evaluated in the host zone rather than the process zone', () => {
  const BREACHES_INSIDE_A_WINDOW = [
    { at: '2026-08-28T05:03:30Z', label: '~07:00 daily DB sync' },
    { at: '2026-09-01T05:03:23Z', label: '~07:00 daily DB sync' },
    { at: '2026-09-01T14:38:22Z', label: '~16:30 daily DB sync' },
    { at: '2026-09-02T05:08:21Z', label: '~07:00 daily DB sync' },
    { at: '2026-09-02T14:38:20Z', label: '~16:30 daily DB sync' },
    // The live one this fix was written against, read straight out of the CAT
    // container's log: "reachability on this environment: ok -> error".
    { at: '2026-09-03T14:48:09Z', label: '~16:30 daily DB sync' },
  ];

  it.each(BREACHES_INSIDE_A_WINDOW)('holds the alert at $at', ({ at: instant, label }) => {
    expect(checkSyncBlackoutWindow(new Date(instant))).toEqual({ active: true, label });
  });

  it('does not simply answer "active" — the same clock time a day-shift away is inactive', () => {
    // 12:38Z is 14:38 host-local: two hours before the 16:30 window, and the
    // exact minute-of-hour of two breaches above. Guards against a fix that
    // widened the window instead of correcting the zone.
    expect(checkSyncBlackoutWindow(new Date('2026-09-02T12:38:20Z')).active).toBe(false);
  });
});

describe('time zone handling', () => {
  it('reads the window in the named zone, not in the process zone', () => {
    const instant = new Date('2026-09-02T14:38:20Z');

    // 16:38 in the host zone (inside a window), 14:38 in UTC (outside both).
    // The pre-fix code returned the UTC answer on the deployed container.
    expect(checkSyncBlackoutWindow(instant, SYNC_HOST_TIME_ZONE).active).toBe(true);
    expect(checkSyncBlackoutWindow(instant, 'UTC').active).toBe(false);
  });

  it('follows the host zone across a DST change instead of drifting an hour', () => {
    // 2026-10-25 is the CEST→CET switch. 07:05 host-local is 05:05Z in summer
    // and 06:05Z in winter; a fixed +2 offset would miss one of them.
    expect(checkSyncBlackoutWindow(new Date('2026-09-02T05:05:00Z')).active).toBe(true); // CEST
    expect(checkSyncBlackoutWindow(new Date('2026-11-02T06:05:00Z')).active).toBe(true); // CET
    expect(checkSyncBlackoutWindow(new Date('2026-11-02T05:05:00Z')).active).toBe(false); // 06:05 CET
  });

  it('reports inactive — never a guessed window — for a zone this runtime cannot resolve', () => {
    // The pad only ever softens an alarm, so failing this way costs a red badge
    // in a known window; failing the other way would silence a real outage.
    expect(checkSyncBlackoutWindow(new Date('2026-09-02T05:05:00Z'), 'Mars/Olympus_Mons')).toEqual({
      active: false,
      label: null,
    });
  });
});
