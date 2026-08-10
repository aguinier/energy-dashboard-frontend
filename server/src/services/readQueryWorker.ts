import { Worker } from 'node:worker_threads';
import { dbPath } from '../config/database.js';

interface WorkerReply<T> {
  rows?: T[];
  error?: string;
}

/** Execute an internal readonly query without occupying Express's event loop. */
export function runReadQueryInWorker<T>(sql: string, params: readonly unknown[]): Promise<T[]> {
  const sourceExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const workerUrl = new URL(`../workers/readQueryWorker.${sourceExtension}`, import.meta.url);

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: { dbPath, sql, params: [...params] },
    });

    worker.once('message', (reply: WorkerReply<T>) => {
      if (reply.error) reject(new Error(reply.error));
      else resolve(reply.rows ?? []);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Readonly query worker exited with code ${code}`));
    });
  });
}
