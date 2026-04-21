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
 */
const dbPath = process.env.ENERGY_DB_PATH || '/data/energy_dashboard.db';

const writeDb: DatabaseType = new Database(dbPath);
writeDb.pragma('journal_mode = WAL');
writeDb.pragma('busy_timeout = 30000');

console.log(`✍️  Write connection opened: ${dbPath}`);

process.on('SIGINT', () => {
  writeDb.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  writeDb.close();
  process.exit(0);
});

export default writeDb;
