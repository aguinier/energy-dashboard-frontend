import Database, { type Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Use ENERGY_DB_PATH env var if set, otherwise resolve relative to compiled output
const dbPath = process.env.ENERGY_DB_PATH
  || '/data/energy_dashboard.db';

// Create a single database connection (readonly for safety)
const db: DatabaseType = new Database(dbPath, { readonly: true });

// Note: pragma cache_size disabled due to WAL lock issues with readonly mode

console.log(`📊 Connected to database: ${dbPath}`);

// Graceful shutdown
process.on('SIGINT', () => {
  db.close();
  console.log('Database connection closed.');
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.close();
  console.log('Database connection closed.');
  process.exit(0);
});

export default db;
