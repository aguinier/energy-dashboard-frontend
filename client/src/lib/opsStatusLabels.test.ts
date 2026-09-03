import { describe, it, expect } from 'vitest';
import { describeFreshnessRollup, shouldShowBlackoutBanner } from './opsStatusLabels';
import type { CombinedOpsStatus, FreshnessRollup, OpsSideStatus, OpsStatus } from '@/types';

const rollup = (overrides: Partial<FreshnessRollup> = {}): FreshnessRollup => ({
  status: 'live',
  countriesChecked: 39,
  streamsChecked: 195,
  counts: { live: 195, stale: 0, ended: 0, none: 0 },
  staleCountries: [],
  ...overrides,
});

/** The empty rollup the server sends when its database read threw (ABL-657). */
const unmeasured = (reason: string): FreshnessRollup => ({
  status: 'none',
  countriesChecked: 0,
  streamsChecked: 0,
  counts: { live: 0, stale: 0, ended: 0, none: 0 },
  staleCountries: [],
  unmeasured: reason,
});

describe('describeFreshnessRollup', () => {
  it('reads live', () => {
    expect(describeFreshnessRollup(rollup())).toBe('live');
  });

  it('reads stale with the count that earned it', () => {
    const stale = rollup({ status: 'stale', counts: { live: 190, stale: 5, ended: 0, none: 0 } });
    expect(describeFreshnessRollup(stale)).toBe('stale (5/195 streams)');
  });

  it('marks ended as the non-alarm it is', () => {
    expect(describeFreshnessRollup(rollup({ status: 'ended' }))).toBe('ended (not an alarm)');
  });

  it('reads an empty fleet as no data held', () => {
    expect(describeFreshnessRollup(rollup({ status: 'none', streamsChecked: 0 }))).toBe('no data held');
  });

  /**
   * The case this file exists for. "We could not read the database" and "the
   * database holds nothing" arrive with identical numbers and identical
   * `status: 'none'`; only `unmeasured` separates them, and printing the wrong
   * one of the two is a statement about the data that we have no basis for.
   */
  it('says the read failed rather than "no data held" when the rollup is unmeasured', () => {
    const label = describeFreshnessRollup(unmeasured('attempt to write a readonly database'));
    expect(label).toBe('not measured — database read failed');
    expect(label).not.toContain('no data held');
  });

  it('checks `unmeasured` before `status`, whatever `status` happens to say', () => {
    // Guards the ordering: a future edit that put the `status` switch first
    // would render a locked replica as `live` on a payload like this.
    expect(describeFreshnessRollup({ ...rollup(), unmeasured: 'database is locked' })).toBe(
      'not measured — database read failed',
    );
  });
});

const side = (freshness: FreshnessRollup): OpsSideStatus => ({
  reachable: true,
  latencyMs: 8,
  status: { freshness } as OpsStatus,
});

const UNREACHABLE: OpsSideStatus = { reachable: false, latencyMs: null, error: 'connect ECONNREFUSED' };

const combined = (
  local: OpsSideStatus,
  peer: OpsSideStatus,
  blackoutActive: boolean,
): CombinedOpsStatus =>
  ({
    timestamp: '2026-09-03T14:48:09.499Z',
    local,
    peer,
    peerConfigured: true,
    syncBlackout: { active: blackoutActive, label: blackoutActive ? '~16:30 daily DB sync' : null },
  }) as CombinedOpsStatus;

describe('shouldShowBlackoutBanner', () => {
  it('stays silent outside the window, even with a side down', () => {
    // A peer that is genuinely down at 11:00 has nothing to do with the sync,
    // and blaming the window for it would be a wrong explanation.
    expect(shouldShowBlackoutBanner(combined(side(rollup()), UNREACHABLE, false))).toBe(false);
  });

  it('stays silent during an uneventful window — both sides fine', () => {
    expect(shouldShowBlackoutBanner(combined(side(rollup()), side(rollup()), true))).toBe(false);
  });

  it('explains an unreachable side inside the window', () => {
    expect(shouldShowBlackoutBanner(combined(side(rollup()), UNREACHABLE, true))).toBe(true);
  });

  /**
   * ABL-657's shape. The sync lock no longer makes the side unreachable — it
   * answers and reports an unmeasured rollup — so keying only on `reachable`
   * would leave the degraded freshness row unexplained on the page for the
   * whole scheduled window.
   */
  it('explains a reachable side whose database read failed inside the window', () => {
    const local = side(unmeasured('attempt to write a readonly database'));
    expect(shouldShowBlackoutBanner(combined(local, side(rollup()), true))).toBe(true);
  });

  it('fires on either lane, not just the local one', () => {
    const peer = side(unmeasured('database is locked'));
    expect(shouldShowBlackoutBanner(combined(side(rollup()), peer, true))).toBe(true);
  });
});
