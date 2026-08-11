import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';
import type { CoreNetPositionCaptureResult } from '../services/jaoCoreNetPositionCapture.js';

interface CaptureWork {
  dbPath: string;
  fromUtc: string;
  toUtc: string;
}

/**
 * Runs off Express's main thread — see `services/coreNetPositionScheduler.ts`
 * for why, and `workers/captureForecastVintagesWorker.ts` (ABL-184) for the
 * pattern this mirrors. Opens its own writable connection (mirroring
 * `config/writeDatabase.ts`'s WAL/busy-timeout setup) rather than sharing one
 * across threads, since better-sqlite3 connections are not thread-safe.
 *
 * Imports its sibling service with a dynamic, extension-matched specifier —
 * see `captureForecastVintagesWorker.ts`'s doc comment for exactly why a
 * static `.js` import breaks inside a worker thread in dev.
 */
const work = workerData as CaptureWork;
const sourceExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const { captureCoreNetPosition } = (await import(
  `../services/jaoCoreNetPositionCapture.${sourceExtension}`
)) as {
  captureCoreNetPosition: (
    db: DatabaseType,
    fromUtc: string,
    toUtc: string
  ) => Promise<CoreNetPositionCaptureResult>;
};

const db = new Database(work.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 30000');

try {
  const result: CoreNetPositionCaptureResult = await captureCoreNetPosition(db, work.fromUtc, work.toUtc);
  parentPort?.postMessage({ result });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally {
  db.close();
}
