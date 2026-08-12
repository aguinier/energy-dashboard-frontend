import type { CombinedOpsStatus } from './combinedOpsStatusService.js';
import { toOpsSnapshot, type OpsSnapshot } from './opsSnapshot.js';
import {
  appendSnapshot,
  resolveSnapshotConfig,
  type AppendSnapshotResult,
  type OpsSnapshotConfig,
} from './opsSnapshotStore.js';

/**
 * Takes an ops-status snapshot on a timer (ABL-288), so `/ops-status` can show
 * a trend instead of only the current reading.
 *
 * WHY THIS ONE RUNS ON THE MAIN THREAD, UNLIKE THE OTHER TWO SCHEDULERS
 *
 * `forecastVintageArchiveScheduler.ts` and `coreNetPositionScheduler.ts` hand
 * their work to a worker thread because each opens a *writable better-sqlite3
 * connection* and runs a synchronous transaction — thousands of rows — which
 * would block every in-flight API response for its duration. A capture here is
 * the same work `GET /api/ops/status/combined` already does on the request
 * thread every time the page polls (every 30s per open tab), plus one
 * `appendFileSync` of a few hundred bytes. Moving that to a worker would buy
 * nothing and would need a second peer-fetch path to maintain.
 *
 * WHY IT IS ON BY DEFAULT
 *
 * See `resolveSnapshotConfig` in `opsSnapshotStore.ts`: this writes only its
 * own file, never the shared database, so it does not carry the "flipping
 * ingest on is its own coordinated decision" constraint the other two do.
 *
 * A failed capture — locked DB during the ABL-220 sync blackout, unreachable
 * peer, unwritable path — is logged and dropped. It is never retried into a
 * backlog and never throws: a monitoring sidecar that can take the API down is
 * worse than a gap in a chart, and a gap is the honest record of a window
 * where we could not read the environment.
 */

export interface SnapshotSchedulerHandle {
  stop: () => void;
}

export interface CaptureResult {
  snapshot: OpsSnapshot | null;
  append: AppendSnapshotResult | null;
  error: string | null;
}

/** Pure: the decision plus a reason, for one startup log line. */
export function describeSnapshotSchedulerStart(config: OpsSnapshotConfig): {
  enabled: boolean;
  reason: string;
} {
  if (!config.enabled) {
    return { enabled: false, reason: 'OPS_SNAPSHOT_ENABLED is off; no snapshots will be captured' };
  }
  return {
    enabled: true,
    reason: `capturing every ${config.intervalMinutes}m to ${config.path}, keeping ${config.retentionDays}d`,
  };
}

export interface CaptureDeps {
  getCombined?: (now: Date) => Promise<CombinedOpsStatus>;
  append?: typeof appendSnapshot;
}

/**
 * Imported lazily, and only on a real capture.
 *
 * `combinedOpsStatusService` reaches `config/database.js`, whose mere import
 * opens a (readonly) connection as a side effect — the same hazard
 * `coreNetPositionScheduler.ts:4-8` calls out for its own `dbPath`. A static
 * import here would mean that importing this scheduler in a test, or from
 * anywhere that only wants `describeSnapshotSchedulerStart`, opens a database.
 */
async function loadCombinedOpsStatus(now: Date): Promise<CombinedOpsStatus> {
  const { getCombinedOpsStatus } = await import('./combinedOpsStatusService.js');
  return getCombinedOpsStatus(now);
}

/** One capture pass. Resolves with an error string rather than rejecting. */
export async function captureOpsSnapshot(
  config: OpsSnapshotConfig,
  now: Date = new Date(),
  deps: CaptureDeps = {},
): Promise<CaptureResult> {
  const getCombined = deps.getCombined ?? loadCombinedOpsStatus;
  const append = deps.append ?? appendSnapshot;

  let snapshot: OpsSnapshot;
  try {
    snapshot = toOpsSnapshot(await getCombined(now));
  } catch (error) {
    return {
      snapshot: null,
      append: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const result = append(snapshot, config, now);
  return { snapshot, append: result, error: result.error };
}

export interface SnapshotSchedulerDeps extends CaptureDeps {
  capture?: (config: OpsSnapshotConfig, now: Date) => Promise<CaptureResult>;
}

/**
 * Starts the recurring capture, or returns `null` when capture is switched
 * off. The in-flight guard skips a tick rather than overlapping it, mirroring
 * the other two schedulers.
 */
export function startOpsSnapshotScheduler(
  env: NodeJS.ProcessEnv = process.env,
  deps: SnapshotSchedulerDeps = {},
): SnapshotSchedulerHandle | null {
  const config = resolveSnapshotConfig(env);
  const decision = describeSnapshotSchedulerStart(config);
  console.log(`📈 Ops snapshot scheduler: ${decision.reason}`);
  if (!decision.enabled) return null;

  const capture =
    deps.capture ?? ((cfg: OpsSnapshotConfig, now: Date) => captureOpsSnapshot(cfg, now, deps));

  let running = false;
  const tick = () => {
    if (running) {
      console.log('📈 Ops snapshot: previous capture still running, skipping this tick.');
      return;
    }
    running = true;
    capture(config, new Date())
      .then((result) => {
        if (result.error) console.error(`📈 Ops snapshot capture failed: ${result.error}`);
        else if (result.append?.pruned) {
          console.log(`📈 Ops snapshot captured; pruned ${result.append.pruned} past retention.`);
        }
      })
      .catch((error) => {
        console.error('📈 Ops snapshot capture failed:', error);
      })
      .finally(() => {
        running = false;
      });
  };

  tick();
  const timer = setInterval(tick, config.intervalMinutes * 60 * 1000);
  timer.unref();

  return { stop: () => clearInterval(timer) };
}
