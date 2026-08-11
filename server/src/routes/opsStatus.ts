import { Router } from 'express';
import { getOpsStatus } from '../services/opsStatusService.js';

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
 * checks (see `../../WORKFLOWS.md`, "Proving the container answered") and is
 * unchanged here.
 *
 * Unlike `/health`, this route touches the database (the freshness rollup),
 * so it is expected to fail during the twice-daily DB sync's write-lock
 * blackout (`../../WORKFLOWS.md`, "Acceptance blackout during Stage 2",
 * ABL-220 — ~07:00 and ~16:30 local) — a known window, not a defect.
 */
router.get('/status', (_req, res) => {
  res.json({ success: true, data: getOpsStatus() });
});

export default router;
