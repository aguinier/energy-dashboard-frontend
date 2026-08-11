import { Worker } from 'node:worker_threads';
import type { CaptureResult } from './forecastVintageArchiveService.js';

// Computed locally rather than imported from `config/database.js`, whose mere
// import opens a real (readonly) connection as a side effect — exactly the
// reason `config/writeDatabase.ts` also computes its own copy of this line
// instead of importing it. Importing it here would make merely importing
// this scheduler module (e.g. from a test) try to open the database.
const dbPath = process.env.ENERGY_DB_PATH || '/data/energy_dashboard.db';

/**
 * Runs `captureForecastVintages` automatically, on a timer, off Express's
 * main thread (ABL-184).
 *
 * WHY A WORKER THREAD
 *
 * Measured against a full-size local replica (2026-08-11): a first capture
 * pass over `forecasts` (2.1M rows), `energy_load_forecast` (2.4M) and
 * `energy_generation_forecast` (3.0M, unpivoted into 3 metrics) takes ~147s;
 * even a fully idempotent no-op rescan of the same data takes ~23s.
 * better-sqlite3 is synchronous, so running that inside the process serving
 * dashboard API requests would freeze every other response for the
 * duration — the exact failure class `services/readQueryWorker.ts` already
 * exists to avoid for a single expensive read. `workers/
 * captureForecastVintagesWorker.ts` opens its own connection on a separate
 * thread, so the scan never blocks the request-handling event loop.
 *
 * WHY GATED ON HELIO_WRITE_TOKEN
 *
 * This capability requires a writable connection, exactly like
 * `getWriteDb()`. `config/writeDatabase.ts` documents that some deployments
 * (the Windows/Docker-Desktop acceptance box) cannot open one at all — the
 * bind-mounted filesystem can't provide WAL's `-shm` file, and opening it
 * crashes with `SQLITE_IOERR_SHMOPEN`. Today `HELIO_WRITE_TOKEN` is the
 * existing signal for "this deployment supports writes" (unset on that box,
 * set wherever `/api/weather/snapshot` already runs), so reusing it here
 * — rather than inventing a second flag — means this scheduler is silent
 * exactly where a write connection would already crash.
 */

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

export interface SchedulerDecision {
  enabled: boolean;
  intervalMs: number;
  reason: string;
}

/** Pure: should the scheduler run at all, given the process environment? */
export function shouldScheduleForecastVintageArchive(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.HELIO_WRITE_TOKEN);
}

/** Pure: the decision plus a human-readable reason, for a single log line. */
export function describeSchedulerStart(
  env: NodeJS.ProcessEnv,
  intervalMs: number = DEFAULT_INTERVAL_MS
): SchedulerDecision {
  const enabled = shouldScheduleForecastVintageArchive(env);
  return {
    enabled,
    intervalMs,
    reason: enabled
      ? `HELIO_WRITE_TOKEN is set; capturing every ${Math.round(intervalMs / 60000)}m`
      : 'HELIO_WRITE_TOKEN is not set; this deployment cannot open a write connection',
  };
}

/** Spawns the worker once and resolves with its result. Rejects on worker error/failure. */
export function runForecastVintageArchiveCapture(): Promise<CaptureResult> {
  const isTsSource = import.meta.url.endsWith('.ts');
  const sourceExtension = isTsSource ? 'ts' : 'js';
  const workerUrl = new URL(
    `../workers/captureForecastVintagesWorker.${sourceExtension}`,
    import.meta.url
  );

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: { dbPath } });

    worker.once('message', (reply: { result?: CaptureResult; error?: string }) => {
      if (reply.error) reject(new Error(reply.error));
      else if (reply.result) resolve(reply.result);
      else reject(new Error('Capture worker returned no result and no error.'));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Forecast vintage archive worker exited with code ${code}`));
    });
  });
}

export interface SchedulerHandle {
  stop: () => void;
}

/**
 * Starts the recurring capture. No-op (returns null) when
 * `shouldScheduleForecastVintageArchive` is false. An in-flight guard skips a
 * tick rather than overlapping it if a previous pass is still running past
 * the next interval — one full first pass is already ~147s, and two
 * concurrent writers to the same archive table serve no purpose.
 */
export function startForecastVintageArchiveScheduler(
  env: NodeJS.ProcessEnv = process.env,
  intervalMs: number = DEFAULT_INTERVAL_MS,
  runCapture: () => Promise<CaptureResult> = runForecastVintageArchiveCapture
): SchedulerHandle | null {
  const decision = describeSchedulerStart(env, intervalMs);
  console.log(`🗄️  Forecast vintage archive scheduler: ${decision.reason}`);
  if (!decision.enabled) return null;

  let running = false;
  const tick = () => {
    if (running) {
      console.log('🗄️  Forecast vintage archive: previous capture still running, skipping this tick.');
      return;
    }
    running = true;
    runCapture()
      .then((result) => {
        console.log(`🗄️  Forecast vintage archive: captured ${result.total} new row(s).`);
      })
      .catch((error) => {
        console.error('🗄️  Forecast vintage archive capture failed:', error);
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
