import Database, { type Database as DatabaseType } from 'better-sqlite3';

/**
 * Writable SQLite connection used only by the weather-snapshot write endpoint.
 *
 * Kept separate from the readonly connection in `./database.ts` so the rest
 * of the API cannot accidentally write. better-sqlite3 is synchronous and
 * single-connection by default; we open a second handle here for writes.
 *
 * SQLite is in WAL mode (set by the canonical writer — `energy-data-gathering`),
 * so concurrent reads + one writer are safe.
 *
 * Opened LAZILY on first use (not at import time). The write endpoint is gated
 * behind HELIO_WRITE_TOKEN; on deployments where the token is unset (e.g. the
 * Windows / Docker-Desktop acceptance box, whose bind-mounted filesystem cannot
 * provide the WAL shared-memory `-shm` file) the connection is never opened, so
 * the server starts cleanly instead of crashing at import with
 * SQLITE_IOERR_SHMOPEN.
 */
const dbPath = process.env.ENERGY_DB_PATH || '/data/energy_dashboard.db';

let writeDb: DatabaseType | null = null;

export function getWriteDb(): DatabaseType {
  if (writeDb === null) {
    writeDb = new Database(dbPath);
    writeDb.pragma('journal_mode = WAL');
    writeDb.pragma('busy_timeout = 30000');
    console.log(`✍️  Write connection opened: ${dbPath}`);
  }
  return writeDb;
}

process.on('SIGINT', () => {
  if (writeDb) writeDb.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (writeDb) writeDb.close();
  process.exit(0);
});
