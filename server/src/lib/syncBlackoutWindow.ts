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
 */

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

export function checkSyncBlackoutWindow(now: Date): BlackoutStatus {
  const minutesSinceMidnight = now.getHours() * 60 + now.getMinutes();

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
