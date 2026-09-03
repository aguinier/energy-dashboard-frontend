import { Router } from 'express';
import { getOpsStatus } from '../services/opsStatusService.js';
import { getCombinedOpsStatus } from '../services/combinedOpsStatusService.js';
import { getOpsStatusHistory } from '../services/opsHistoryService.js';
import { AppError } from '../middleware/errorHandler.js';

const router = Router();

/**
 * GET /ops/status
 *
 * Host + process KPIs for the acceptance/prod status dashboard (ABL-236):
 * disk space for the DB volume, process memory/uptime, CPU load (`null` on
 * Windows — `os.loadavg()` fabricates `[0,0,0]` there rather than reporting
 * "unavailable", see `services/hostMetrics.ts`), and a fleet-wide worst-case
 * data-freshness rollup reusing `dataFreshnessService.ts`'s per-country
 * verdicts. Every metric that cannot be measured on this host is `null`,
 * never invented (ABL-237).
 *
 * Additive to `/api/health` (`routes/index.ts`), not a replacement — that
 * endpoint's provenance contract is depended on by ABL-172's acceptance
 * checks (see `../../../../WORKFLOWS.md`, "Proving the container answered")
 * and is unchanged here.
 *
 * **This route answers 200 whether or not the database is readable** (ABL-657).
 * It used to 500 for the duration of the twice-daily DB-sync write lock
 * (`../../../../WORKFLOWS.md`, "Acceptance blackout during Stage 2", ABL-220 —
 * ~07:00 and ~16:30 workstation-local), which was documented right here as a
 * known window rather than a defect. It was a defect: this is the endpoint the
 * peer poll and the alert engine decide `reachable` from, so one unreadable KPI
 * made a live, serving process report as a down environment and flapped the
 * badge twice a day. The freshness rollup now degrades to `unmeasured` with its
 * reason, like every other unmeasurable field in this payload — see
 * `services/opsStatusService.ts`.
 */
router.get('/status', (_req, res) => {
  res.json({ success: true, data: getOpsStatus() });
});

/**
 * GET /ops/status/combined
 *
 * This side's `/ops/status` plus the peer environment's (fetched over HTTP
 * via `OPS_PEER_URL` — prod's peer is acceptance and vice versa, never
 * hardcoded, see `combinedOpsStatusService.ts`), for the acceptance/prod
 * status comparison page (ABL-238). Either side degrades to `reachable: false`
 * rather than failing the whole request — an unreachable peer must never
 * blank this environment's own KPIs, and a locked local DB during the ABL-220
 * sync blackout must never blank the peer's. `syncBlackout` tells the client
 * when to render that as a known, expected state instead of a red alarm.
 *
 * `derived` (ABL-292) carries the warn/error verdict per KPI for both lanes,
 * computed from `lib/opsStatusThresholds.ts` — the single home of the disk
 * ratios and their ABL-586 free-bytes floors since the derivation moved off
 * the client, where a server-side scheduled job (ABL-287's alert engine) could
 * not reach it. Purely additive: every raw field above is unchanged, so anything
 * still reading the old shape is unaffected.
 */
router.get('/status/combined', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await getCombinedOpsStatus() });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /ops/status/history?hours=168
 *
 * The stored snapshots of `/ops/status/combined` inside a trailing window,
 * plus the disk headroom projection derived from them (ABL-288). Snapshots are
 * captured on a timer by `opsSnapshotScheduler.ts` into a JSONL file, not into
 * the shared database — see `opsSnapshotStore.ts` for why.
 *
 * Unlike the two routes above this one does NOT touch the database, so it is
 * unaffected by the ABL-220 sync blackout: during the window where
 * `/status/combined` degrades this side to `reachable: false`, the history
 * endpoint still answers, and the snapshots it returns are the record of that
 * degradation rather than a hole.
 *
 * `hours` is clamped to what is actually retained and echoed back as
 * `windowHours`, so a client asking for 90 days of a 14-day file is told it
 * got 14 rather than being handed 14 days labelled 90.
 */
router.get('/status/history', (req, res) => {
  const raw = req.query.hours;
  let hours: number | undefined;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new AppError('hours must be a positive number', 400, 'INVALID_HOURS');
    }
    hours = parsed;
  }

  res.json({ success: true, data: getOpsStatusHistory(new Date(), hours) });
});

export default router;
