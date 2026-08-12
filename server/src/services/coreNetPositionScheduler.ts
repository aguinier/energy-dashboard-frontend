import { Worker } from 'node:worker_threads';
import type { CoreNetPositionCaptureResult } from './jaoCoreNetPositionCapture.js';

// Computed locally rather than imported from `config/database.js`, whose mere
// import opens a real (readonly) connection as a side effect — the same
// reason `forecastVintageArchiveScheduler.ts` computes its own copy instead
// of importing it. Importing it here would make merely importing this
// scheduler module (e.g. from a test) try to open the database.
const dbPath = process.env.ENERGY_DB_PATH || '/data/energy_dashboard.db';

/**
 * Runs `captureCoreNetPosition` automatically, on a timer, off Express's main
 * thread — the same shape as `forecastVintageArchiveScheduler.ts` (ABL-184),
 * adapted for a capture step that also makes a network call.
 *
 * WHY A WORKER THREAD
 *
 * `captureCoreNetPosition` opens a writable better-sqlite3 connection and
 * runs a transaction of `INSERT OR IGNORE` statements — synchronous, like
 * every other write in this codebase. Running it on the thread serving
 * dashboard API requests would freeze every other response for the duration
 * of the fetch-plus-write, the same class of problem
 * `services/readQueryWorker.ts` already exists to avoid for a single
 * expensive read and `workers/captureForecastVintagesWorker.ts` avoids for
 * the forecast archive.
 *
 * WHY A SEPARATE, DEDICATED ENV VAR — NOT A REUSE OF `HELIO_WRITE_TOKEN`
 *
 * `forecastVintageArchiveScheduler.ts` reuses `HELIO_WRITE_TOKEN` because
 * that variable is already the deployment's one signal for "a write
 * connection can safely be opened here" (see `config/writeDatabase.ts`).
 * This scheduler needs that SAME prerequisite — `shouldScheduleCoreNetPositionCapture`
 * checks it too, below — but gating on it ALONE would be wrong here
 * specifically: `HELIO_WRITE_TOKEN` is very plausibly already set in
 * production today, since it also gates the live weather-snapshot and
 * net-position-forecast write endpoints. ABL-230 is explicit that merging
 * and deploying this code must change nothing in prod until a SEPARATE,
 * deliberate step — flipping this ingest on is its own decision, coordinated
 * with the CEO, not a side effect of a token that may already be set for an
 * unrelated write path. So this scheduler additionally requires
 * `JAO_CORE_NET_POSITION_ENABLED`, a new variable that is not set anywhere
 * today and is not set as part of this issue.
 */

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Trailing window this pipeline asks JAO for on each pass, mirroring the
 * sibling `energy-data-gathering` ENTSO-E cron's own rolling-window cadence
 * (documented in `CLAUDE.md`, "Uniform freshness across zones": it refetches
 * a rolling 7-day window every run and upserts everything it gets, so any
 * hole inside that window self-heals as soon as it fills upstream). Given
 * `storeCoreNetPositionRows` is idempotent per `(country_code,
 * timestamp_utc)`, re-asking for already-captured intervals on every pass
 * costs a skipped `INSERT OR IGNORE`, not a duplicate or an overwrite.
 *
 * A full historical backfill to JAO's 2022-06-09 go-live is deliberately out
 * of scope here — a one-time job with its own shape, not something a
 * 15-minute recurring capture should attempt.
 */
const DEFAULT_CAPTURE_WINDOW_DAYS = 7;

/** Pure: should the scheduler run at all, given the process environment? */
export function shouldScheduleCoreNetPositionCapture(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.JAO_CORE_NET_POSITION_ENABLED) && Boolean(env.HELIO_WRITE_TOKEN);
}

/** Pure: the decision plus a human-readable reason, for a single log line. */
export function describeCoreNetPositionSchedulerStart(
  env: NodeJS.ProcessEnv,
  intervalMs: number = DEFAULT_INTERVAL_MS
): { enabled: boolean; intervalMs: number; reason: string } {
  const enabled = shouldScheduleCoreNetPositionCapture(env);
  let reason: string;
  if (enabled) {
    reason = `JAO_CORE_NET_POSITION_ENABLED and HELIO_WRITE_TOKEN are both set; capturing every ${Math.round(intervalMs / 60000)}m`;
  } else if (!env.JAO_CORE_NET_POSITION_ENABLED) {
    reason = 'JAO_CORE_NET_POSITION_ENABLED is not set';
  } else {
    reason = 'HELIO_WRITE_TOKEN is not set; this deployment cannot open a write connection';
  }
  return { enabled, intervalMs, reason };
}

/**
 * Pure: the `[fromUtc, toUtc]` pair one capture pass asks JAO for, as the
 * exact ISO-8601-with-`Z` strings the endpoint expects (see
 * `jaoCoreNetPositionCapture.ts`'s sample URL). `now` is a parameter, not
 * `new Date()` read internally, so this is deterministic under test.
 */
export function computeCaptureWindow(
  now: Date = new Date(),
  windowDays: number = DEFAULT_CAPTURE_WINDOW_DAYS
): { fromUtc: string; toUtc: string } {
  const toIso = (d: Date) => `${d.toISOString().split('.')[0]}Z`;
  const from = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  return { fromUtc: toIso(from), toUtc: toIso(now) };
}

/** Spawns the worker once and resolves with its result. Rejects on worker error/failure. */
export function runCoreNetPositionCapture(
  now: Date = new Date()
): Promise<CoreNetPositionCaptureResult> {
  const { fromUtc, toUtc } = computeCaptureWindow(now);
  const isTsSource = import.meta.url.endsWith('.ts');
  const sourceExtension = isTsSource ? 'ts' : 'js';
  const workerUrl = new URL(
    `../workers/captureCoreNetPositionWorker.${sourceExtension}`,
    import.meta.url
  );

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: { dbPath, fromUtc, toUtc } });

    worker.once('message', (reply: { result?: CoreNetPositionCaptureResult; error?: string }) => {
      if (reply.error) reject(new Error(reply.error));
      else if (reply.result) resolve(reply.result);
      else reject(new Error('Core net position capture worker returned no result and no error.'));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Core net position capture worker exited with code ${code}`));
    });
  });
}

export interface SchedulerHandle {
  stop: () => void;
}

/**
 * Starts the recurring capture. No-op (returns null) when
 * `shouldScheduleCoreNetPositionCapture` is false. An in-flight guard skips a
 * tick rather than overlapping it if a previous pass is still running past
 * the next interval, mirroring `startForecastVintageArchiveScheduler`.
 */
export function startCoreNetPositionScheduler(
  env: NodeJS.ProcessEnv = process.env,
  intervalMs: number = DEFAULT_INTERVAL_MS,
  runCapture: () => Promise<CoreNetPositionCaptureResult> = runCoreNetPositionCapture
): SchedulerHandle | null {
  const decision = describeCoreNetPositionSchedulerStart(env, intervalMs);
  console.log(`🇪🇺 JAO Core net position scheduler: ${decision.reason}`);
  if (!decision.enabled) return null;

  let running = false;
  const tick = () => {
    if (running) {
      console.log('🇪🇺 JAO Core net position: previous capture still running, skipping this tick.');
      return;
    }
    running = true;
    runCapture()
      .then((result) => {
        console.log(
          `🇪🇺 JAO Core net position: parsed ${result.parsed} row(s), captured ${result.inserted} new.`
        );
      })
      .catch((error) => {
        console.error('🇪🇺 JAO Core net position capture failed:', error);
      })
      .finally(() => {
        running = false;
      });
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();

  return { stop: () => clearInterval(timer) };
}
