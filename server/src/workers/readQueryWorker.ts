import Database from 'better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';

interface QueryWork {
  dbPath: string;
  sql: string;
  params: unknown[];
}

const work = workerData as QueryWork;
const db = new Database(work.dbPath, { readonly: true });

try {
  const rows = db.prepare(work.sql).all(...work.params);
  parentPort?.postMessage({ rows });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally {
  db.close();
}
