import Database from 'better-sqlite3';
import { resolveApiKeysDbPath } from '../../v1/keys/sqliteApiKeyStore.js';
import { createAuthFailureStore } from '../../v1/security/sqliteAuthFailureStore.js';
import type { AuthFailureAdminStore } from '../../v1/security/authFailureStore.js';

/**
 * A **readonly** handle on the tables ABL-530 fills, for the watcher that reads
 * them (ABL-578).
 *
 * ## Why the watcher runs in the private process and not the public one
 *
 * This was the one architectural choice in ABL-578 and it is not obvious, so it
 * is written down rather than left to be re-derived.
 *
 * The tables live in `api_keys.db`, which today has exactly two legitimate
 * openers: the `/v1` serving process (`publicIndex.ts`) and the keys/usage CLI.
 * The obvious home for a watcher is therefore the public process, which already
 * holds a read-write handle. That is the wrong answer for one decisive reason:
 *
 * **The alarm channel needs a Paperclip API credential, and the public process is
 * the one we intend to expose to the internet** (ABL-291, still undecided). A
 * credential that can create and comment on issues in our own control plane,
 * sitting in the process most exposed to attack, means an attacker who takes that
 * process can silence the alarm that describes them — and can reach a great deal
 * more besides. `publicEnv.ts`'s `FORBIDDEN_PUBLIC_ENV` exists to keep exactly
 * this class of secret out of that process. A detector whose alarm can be turned
 * off by the thing it detects is not a detector.
 *
 * So the watcher runs in the private server (`index.ts`), on the LAN, beside the
 * four schedulers already there — which is also what ABL-578 asks for when it
 * says to run it wherever the existing scheduled work runs and not to introduce a
 * new scheduling mechanism.
 *
 * ## The cost of that choice, stated rather than buried
 *
 * It adds a **third** legitimate reader of `api_keys.db`, and ABL-524 §0 makes
 * "who touched that file" the highest-value unbuilt signal on the list — Tier 2,
 * which the Board is reconsidering. A third reader does not weaken that signal
 * as long as it is *documented*: an allowlist of three is no harder to check than
 * one of two, and the failure mode S1 guards against is an *unknown* opener. This
 * comment, and the `readonly: true` below, are the documentation. Whoever builds
 * Tier 2 needs to add this process to the baseline.
 *
 * The handle is readonly, so this process cannot write a key, a usage row or an
 * auth-failure record even by mistake — it can only read what the serving process
 * already decided.
 */

export interface AuthFailureReader {
  store: AuthFailureAdminStore;
  path: string;
  close(): void;
}

export interface ReaderUnavailable {
  /** Why there is nothing to read. Never an alarm — see below. */
  reason: string;
}

export type OpenAuthFailureReaderResult = AuthFailureReader | ReaderUnavailable;

export function isUnavailable(
  result: OpenAuthFailureReaderResult
): result is ReaderUnavailable {
  return (result as ReaderUnavailable).reason !== undefined;
}

/** Both tables the four reads need; `keyOrigins` and the S4 join go to `usage_events`. */
const REQUIRED_TABLES = ['auth_failures', 'usage_events'] as const;

/**
 * Open the store, or say why it cannot be opened.
 *
 * **Never throws, and an absent store is never an alarm.** The states this
 * degrades through are all ordinary:
 *
 * - `API_KEYS_DB_PATH` unset — the overwhelming case today. `/v1` is not running
 *   in this deployment, so there is no auth-failure table anywhere and nothing to
 *   watch. Reporting that as a breach signal would be an alarm that fires on
 *   *not having an API*.
 * - The file exists but the tables do not — `/v1` has been configured but has
 *   never started, so it has never applied its schema. Also not a finding.
 *
 * The tables are probed **before** `createAuthFailureStore`, which is not
 * defensive tidiness: that function applies its schema with
 * `CREATE TABLE IF NOT EXISTS`, and on a readonly connection SQLite tolerates
 * that only when the table already exists. Against a fresh file it raises
 * "attempt to write a readonly database" — a confusing error for a condition that
 * is simply "nothing has been recorded yet". Verified against a real handle
 * rather than assumed.
 */
export function openAuthFailureReader(
  env: NodeJS.ProcessEnv = process.env
): OpenAuthFailureReaderResult {
  let dbPath: string;
  try {
    dbPath = resolveApiKeysDbPath(env);
  } catch (err) {
    return {
      reason:
        `no /v1 key store is configured in this process (${(err as Error).message}) — ` +
        'there are no auth-failure tables to watch.',
    };
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return { reason: `cannot open ${dbPath} readonly: ${(err as Error).message}` };
  }

  try {
    const present = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
    );
    const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
    if (missing.length > 0) {
      db.close();
      return {
        reason:
          `${dbPath} has no ${missing.join(' or ')} table, so /v1 has never recorded a ` +
          'request or a refusal here. Nothing to watch yet.',
      };
    }

    return {
      store: createAuthFailureStore(db),
      path: dbPath,
      close: () => db.close(),
    };
  } catch (err) {
    db.close();
    return { reason: `cannot read ${dbPath}: ${(err as Error).message}` };
  }
}
