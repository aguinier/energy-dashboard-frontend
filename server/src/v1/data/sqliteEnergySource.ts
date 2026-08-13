import Database, { type Database as DatabaseType, type Statement } from 'better-sqlite3';
import path from 'node:path';
import { resolveApiKeysDbPath } from '../keys/sqliteApiKeyStore.js';
import type { EnergyDataSource, SqlParam } from './energySource.js';

/**
 * The public process's own **readonly** handle on the energy database.
 *
 * ## Why this module exists instead of `config/database.ts`
 *
 * `config/database.ts` is the private app's handle, and it is unreachable from
 * this process by construction — `publicAppGraph.test.ts` asserts that the whole
 * of `config/` is absent from both public entrypoints, because the two modules
 * in it are the readonly and writable handles on a database owned by somebody
 * else's ingest. ABL-303 needs to read that database, so the question was
 * whether to weaken the control or to open a second handle. It opens a second
 * handle, for reasons that survive the convenience argument:
 *
 * - **`config/database.ts` opens SQLite at import time and registers process
 *   signal handlers.** Importing it would give this process a database
 *   connection and two `process.on` handlers as a *side effect of an import*,
 *   which is exactly the shape `publicAppGraph.test.ts` avoids by reading
 *   modules as text. It also prints its path to stdout on connect, which is the
 *   kind of internal detail this surface is composed to keep off.
 * - **`config/` is one typo from `config/writeDatabase.ts`.** The prefix rule is
 *   coarse deliberately: keeping the whole directory unreachable means the
 *   writable handle cannot arrive by autocomplete. Making an exception for one
 *   file in it turns a structural control into a judgement call in review.
 * - **The two processes want different things.** This one wants a handle it can
 *   close, a prepared-statement cache scoped to its own queries, and a path that
 *   is checked rather than defaulted (see below). The private app wants a global
 *   singleton. Sharing would mean one of them compromising.
 *
 * So the public process holds a **third** database handle, and it is named
 * individually in `publicAppGraph.test.ts` rather than being covered by a count.
 * The properties that make it safe:
 *
 * - `readonly: true`, so no query from this process can write to a database
 *   owned by `energy-data-gathering`. That is the same posture the private
 *   server takes and the one ABL-300 kept when it added a key store.
 * - It is reachable only from `publicIndex.ts`. `createPublicApp` still names
 *   the *shape* of a data source and chooses no implementation, so the module
 *   that serves requests still has no database driver behind it.
 *
 * ## `ENERGY_DB_PATH` is required here, with no default
 *
 * `config/database.ts:7-8` falls back to `/data/energy_dashboard.db`. That
 * default is right for a container whose image puts the file there and wrong for
 * this process: a fallback means a misconfigured public API opens *something*,
 * or fails on the first customer request rather than at startup. Required, and
 * opened before `listen`, makes a path typo a startup failure — the same rule
 * ABL-300 applied to the key store and for the same reason.
 *
 * The guard against pointing this at the key store is the mirror of
 * `resolveApiKeysDbPath`'s, and it reuses that function rather than re-reading
 * `API_KEYS_DB_PATH` so there is still exactly one decision about where the key
 * store is.
 */

/** Resolve `ENERGY_DB_PATH`, refusing an unset value and the key store. */
export function resolveEnergyDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.ENERGY_DB_PATH ?? '').trim();
  if (configured === '') {
    throw new Error(
      'ENERGY_DB_PATH is not set. The public /v1 process reads the energy database directly ' +
        'and has no default path: a default would let a misconfigured deployment open the ' +
        'wrong file, or fail on a customer request rather than at startup. ' +
        'Set it to the same readonly database the dashboard reads (see server/.env.public.example).'
    );
  }

  const resolved = path.resolve(configured);
  const keysPath = resolveApiKeysDbPath(env);
  const same =
    process.platform === 'win32'
      ? resolved.toLowerCase() === keysPath.toLowerCase()
      : resolved === keysPath;

  if (same) {
    throw new Error(
      'ENERGY_DB_PATH and API_KEYS_DB_PATH resolve to the same file. They are different ' +
        'databases with different owners: the energy database is read-only to us and written ' +
        'by energy-data-gathering, while the key store holds credentials and usage records ' +
        'this process writes.'
    );
  }

  return resolved;
}

export interface OpenEnergyDatabaseOptions {
  env?: NodeJS.ProcessEnv;
}

export function openEnergyDatabase({
  env = process.env,
}: OpenEnergyDatabaseOptions = {}): EnergyDataSource {
  const dbPath = resolveEnergyDbPath(env);
  const db: DatabaseType = new Database(dbPath, { readonly: true, fileMustExist: true });
  return wrapDatabase(db);
}

/**
 * Wrap an open handle. Exported so tests can drive the real code path against a
 * seeded in-memory database rather than against a hand-written fake — the SQL in
 * `observationsRepo.ts` is where the two-separator traps live, and a fake that
 * returns rows would prove nothing about them.
 */
export function wrapDatabase(db: DatabaseType): EnergyDataSource {
  // `better-sqlite3` compiles a statement on every `prepare()`. These are a
  // handful of literal query strings executed once per request, so caching them
  // by text turns compilation into a one-off. The cache is per handle and is
  // discarded with it; the keys are literals from this codebase, never anything
  // a caller supplies, so it cannot be grown by traffic.
  const compiled = new Map<string, Statement>();
  const prepare = (sql: string): Statement => {
    const hit = compiled.get(sql);
    if (hit) return hit;
    const statement = db.prepare(sql);
    compiled.set(sql, statement);
    return statement;
  };

  return {
    all<Row>(sql: string, params: readonly SqlParam[] = []): Row[] {
      return prepare(sql).all(...params) as Row[];
    },
    get<Row>(sql: string, params: readonly SqlParam[] = []): Row | undefined {
      return prepare(sql).get(...params) as Row | undefined;
    },
    close(): void {
      compiled.clear();
      db.close();
    },
  };
}
