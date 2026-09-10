/**
 * Is `now` inside the twice-daily DB-sync write-lock blackout (ABL-220)?
 *
 * `sync-db-v2.ps1`'s Stage 2 holds an exclusive `BEGIN IMMEDIATE` on the
 * acceptance replica at ~07:00 and ~16:30 local, and any concurrent reader —
 * including this process's own freshness rollup, and CAT's `/api/ops/status`
 * when acceptance is polled as a peer — gets `DATABASE_LOCKED` and 500s for
 * the whole lock duration (`../../../../WORKFLOWS.md`, "Acceptance blackout
 * during Stage 2"). The pad only ever softens a real alarm into a known-state
 * annotation — it never suppresses one outside the window — so a generous pad
 * costs a slightly-too-long "known cause" label, not a missed real outage.
 *
 * **Re-measured per window 2026-09-03 (ABL-672) — the shared 60-minute pad
 * ABL-249 set from a single 07:00 data point (34m07s) turned out to undercount
 * 16:30 by more than double.** Every run from 2026-08-12 (ABL-249's cutoff)
 * through 2026-09-03, elapsed time from the scheduled trigger minute to
 * `Done.`, from `C:\Code\able\logs\sync-db-v2.log`:
 *
 * - **07:00 (22 runs):** 16m06s - **44m06s** (2026-09-02). Never came close to
 *   the old 60-minute pad.
 * - **16:30 (23 runs):** 21m45s - **138m21s** (2026-08-28). Five of the 23
 *   runs — not the one-in-five ABL-634's sample suggested — overran the old
 *   60-minute pad: 74m10s (08-12), 99m46s (08-25), 120m38s (08-27), 138m21s
 *   (08-28), and the 86m35s ABL-634 itself caught (09-01). Every overrun is on
 *   this window; the worst cleared the old pad by 78 minutes. `REFRESH_TABLES`
 *   grew from 22 (ABL-249's figure) to 29 across the period —
 *   `net_position_backup_abl67` and three more `*_backup_abl21x`/`abl25x`
 *   tables joined `forecast_vintage_archive` in the swept set — so the two
 *   windows no longer share one number, and this will likely need
 *   re-measuring again as more get added.
 *
 * New pads, each comfortably above its own window's observed max: **07:00 ->
 * 75 minutes** (44m06s + ~31 min margin), **16:30 -> 180 minutes** (138m21s +
 * ~42 min margin). **Known limit, unchanged from ABL-249:** this is still a
 * static pad against a table set that is expected to keep growing, so it does
 * not self-calibrate. A durable fix would have `sync-db-v2.ps1` write its own
 * completion timestamp into a small marker file inside `DB_DIR` (already
 * bind-mounted into the container at `/data`, `docker/docker-compose.yml`),
 * so this check could read the sync's *actual* last-completion time instead
 * of guessing a fixed window. That needs a change to
 * `energy-data-gathering/scripts/workstation/sync-db-v2.ps1`, outside this
 * repo, and is left as a follow-up rather than folded into this fix.
 *
 * **The window is host wall-clock, and it is evaluated as such (ABL-657).**
 * The schedule is a Windows Scheduled Task on the acceptance workstation, so
 * `07:00` and `16:30` below are that machine's local clock. This check used to
 * read `now.getHours()` — *this process's* local clock — which is the same
 * number only when the process happens to share the workstation's zone. The
 * deployed acceptance container does not: `docker/Dockerfile` sets no `TZ` and
 * `node:20-slim` is `Etc/UTC`, so 16:38 local read as 14:38 and **neither
 * window ever matched inside the container**. The blackout hold was dead code
 * on the one deployment it exists for, which is why ABL-634 saw the badge go
 * `error` (not the intended `warn`) twice a day for six days. Verdicts are now
 * taken in `SYNC_HOST_TIME_ZONE` via `Intl`, so they are independent of the
 * container's `TZ` and follow CET/CEST across a DST change instead of drifting
 * an hour twice a year.
 */

/**
 * The acceptance workstation's zone — Windows "Romance Standard Time", the zone
 * whose wall clock the `able-db-sync` Scheduled Task fires on.
 *
 * A constant, not an env var: this is a fact about where the machine is, and a
 * settable one would just be a second place for it to be wrong. The check is
 * lane-agnostic — `combinedOpsStatusService.ts` computes one `syncBlackout`
 * verdict per call and applies it to both the `local` and `peer` sides, so
 * `active` is `true` on prod during these windows too. What is actually true:
 * prod's own database is never locked by this script (it only ever runs
 * against the acceptance replica), so the softening never has anything to do
 * on prod's `local` side — it is prod's *view of the CAT peer* that it
 * correctly softens, because CAT's database really is locked in these
 * windows.
 */
export const SYNC_HOST_TIME_ZONE = 'Europe/Paris';

export interface SyncBlackoutWindow {
  hour: number;
  minute: number;
  label: string;
  /** Minutes after the scheduled minute the window stays active — measured and justified per window above, not shared. */
  padAfterMin: number;
}

const PAD_BEFORE_MIN = 2;

const WINDOWS: SyncBlackoutWindow[] = [
  { hour: 7, minute: 0, label: '~07:00 daily DB sync', padAfterMin: 75 },
  { hour: 16, minute: 30, label: '~16:30 daily DB sync', padAfterMin: 180 },
];

export interface BlackoutStatus {
  active: boolean;
  label: string | null;
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();

/** One formatter per zone, built once. `null` records a zone this runtime's ICU cannot resolve. */
function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  if (!formatters.has(timeZone)) {
    let formatter: Intl.DateTimeFormat | null = null;
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      // A small-ICU runtime knows only UTC. Recorded, warned about once, and
      // then treated as "cannot tell" below — never as "not in a window
      // measured some other way".
      console.warn(
        `⚠️  Sync blackout window disabled: this runtime cannot resolve the time zone ${timeZone}. ` +
          'Ops alerts will fire during the DB sync window rather than being held.',
      );
    }
    formatters.set(timeZone, formatter);
  }
  return formatters.get(timeZone) ?? null;
}

/** Minutes past midnight `at` falls on in `timeZone`, or `null` if the zone is unresolvable. */
function minutesSinceMidnightIn(timeZone: string, at: Date): number | null {
  const formatter = formatterFor(timeZone);
  if (formatter === null) return null;

  const parts = formatter.formatToParts(at);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  // `hour12: false` renders midnight as "24" on some ICU versions.
  return (hour % 24) * 60 + minute;
}

/**
 * `timeZone` is a parameter only so the tests can drive a second zone and prove
 * the verdict does not come from the process's own clock. Production callers
 * pass nothing.
 *
 * An unresolvable zone reports **inactive**. The pad only ever softens an
 * alarm, so failing that way costs a red badge in a known window; failing the
 * other way would silence a real outage for the length of a window (up to
 * `PAD_BEFORE_MIN + padAfterMin`, currently as long as 182 minutes for 16:30)
 * twice a day.
 */
export function checkSyncBlackoutWindow(
  now: Date,
  timeZone: string = SYNC_HOST_TIME_ZONE,
): BlackoutStatus {
  const minutesSinceMidnight = minutesSinceMidnightIn(timeZone, now);
  if (minutesSinceMidnight === null) return { active: false, label: null };

  for (const window of WINDOWS) {
    const scheduled = window.hour * 60 + window.minute;
    const windowStart = scheduled - PAD_BEFORE_MIN;
    const windowEnd = scheduled + window.padAfterMin;
    if (minutesSinceMidnight >= windowStart && minutesSinceMidnight <= windowEnd) {
      return { active: true, label: window.label };
    }
  }

  return { active: false, label: null };
}
