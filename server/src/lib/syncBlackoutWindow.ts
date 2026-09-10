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
 * **Re-sized per window 2026-08-12 (ABL-249) — the original 4m04s-10m12s /
 * up-to-14m01s figures and the single shared 20-minute pad they justified are
 * now stale.** From `C:\Code\able\logs\sync-db-v2.log`:
 *
 * - **07:00, 2026-08-01 -> 2026-08-11 (11 runs):** elapsed time from the
 *   07:00 scheduled minute to `Done.` ranged 5m53s-12m00s — the old 20-minute
 *   pad covered it with margin to spare.
 * - **07:00, 2026-08-12: 34m07s** — a step change, not a continuation of that
 *   trend (~2.85x the prior 11-day max), and it overran the health check that
 *   found this bug (`/api/ops/status` polled at 07:31-07:34 local). Root
 *   cause, from the same log: `REFRESH_TABLES` jumped from 22 to **24** and
 *   the exported file grew from ~2.6 GB to **4205 MB** on the same run where
 *   `forecast_vintage_archive` (ABL-184) first appears in the log's `FRESH`
 *   table list. Stage 2 enumerates tables from `sqlite_master`, so prod's
 *   append-only vintage archive is now swept into the full-refresh
 *   transaction and re-transferred/re-inserted whole on every run — this is
 *   expected to recur, and to keep growing, not a one-off blip.
 * - **16:30** has not been re-measured against the post-archive table set —
 *   today's 16:30 run had not happened yet as of this fix. Its pad is widened
 *   here on the same reasoning (the archive table is swept into every Stage 2
 *   run, not only 07:00) rather than waiting on a second incident to confirm
 *   it independently.
 *
 * Both windows get a generous 60-minute pad: comfortable margin above the
 * 34m07s observed, chosen wide because nothing is yet known about the
 * archive table's growth rate. **Known limit:** this is still a static pad
 * against a table that is expected to keep growing, so it will likely need
 * re-measuring again — this does not self-calibrate. A durable fix would have
 * `sync-db-v2.ps1` write its own completion timestamp into a small marker
 * file inside `DB_DIR` (already bind-mounted into the container at `/data`,
 * `docker/docker-compose.yml`), so this check could read the sync's *actual*
 * last-completion time instead of guessing a fixed window. That needs a
 * change to `energy-data-gathering/scripts/workstation/sync-db-v2.ps1`,
 * outside this repo, and was left as a follow-up rather than folded into this
 * fix.
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
 * settable one would just be a second place for it to be wrong. Both deployed
 * lanes may read it — prod is not synced by that script, so its blackout is
 * simply never active, which is correct.
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
  { hour: 7, minute: 0, label: '~07:00 daily DB sync', padAfterMin: 60 },
  { hour: 16, minute: 30, label: '~16:30 daily DB sync', padAfterMin: 60 },
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
 * other way would silence a real outage for 62 minutes twice a day.
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
