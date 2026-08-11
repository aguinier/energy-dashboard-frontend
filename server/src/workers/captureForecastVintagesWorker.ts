import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';
import type { CaptureResult } from '../services/forecastVintageArchiveService.js';

interface CaptureWork {
  dbPath: string;
}

/**
 * Runs off Express's main thread — see
 * `services/forecastVintageArchiveScheduler.ts` for why. Opens its own
 * writable connection (mirroring `config/writeDatabase.ts`'s WAL/busy-timeout
 * setup) rather than sharing one across threads, since better-sqlite3
 * connections are not thread-safe.
 *
 * Imports its sibling service with a dynamic, extension-matched specifier
 * rather than a static `../services/forecastVintageArchiveService.js` import.
 * A worker thread does not inherit whichever loader resolved *this* file
 * (Node's own native TypeScript support, running this file directly as
 * `.ts` in dev — no tsx loader involved), so a `.js` specifier pointing at a
 * `.ts` file fails inside the thread even though the identical specifier
 * resolves fine from the main thread. Asking for the extension THIS file
 * itself was loaded as sidesteps that: `.ts` in dev (Node's native stripping
 * handles it directly, confirmed against Node 24.18), the real compiled
 * `.js` in production.
 */
const work = workerData as CaptureWork;
const sourceExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const { captureForecastVintages } = (await import(
  `../services/forecastVintageArchiveService.${sourceExtension}`
)) as { captureForecastVintages: (db: DatabaseType) => CaptureResult };

const db = new Database(work.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 30000');

try {
  const result: CaptureResult = captureForecastVintages(db);
  parentPort?.postMessage({ result });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally {
  db.close();
}
