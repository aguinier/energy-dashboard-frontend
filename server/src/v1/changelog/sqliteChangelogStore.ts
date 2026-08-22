import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { resolveApiKeysDbPath } from '../keys/sqliteApiKeyStore.js';
import {
  assertPublishable,
  sortEntriesNewestFirst,
  type ChangelogEntry,
  type ChangelogEntryType,
} from './changelogEntry.js';
import type { ChangelogAdminStore, ChangelogReader } from './changelogStore.js';

/**
 * Where published entries live, and why publishing one is not a deployment.
 *
 * ABL-532. This is the load-bearing decision on that issue, so the reasoning is
 * here rather than only in the PR.
 *
 * §9.3.2 lets us serve a correction to wrong values immediately, and requires
 * the change-log entry to go up **at the same time as the change**. That makes
 * *publish latency* a contractual property rather than an implementation
 * detail — and it is the reason entries are data in a table instead of source
 * files rendered at build time.
 *
 * Deployment in this repository is manual and human-gated: there is no CI/CD
 * step, and production is updated by somebody running `git pull` and
 * `docker compose build` on the host (`CLAUDE.md` → *Deployment*). ABL-120 found
 * merged work still undeployed. A change log whose entries are committed files
 * therefore has a publish path measured in *whenever the next deploy happens*,
 * so on a correction we would serve the corrected values instantly and publish
 * the required notice hours or days later — the fastest lawful action available,
 * gated by our own tooling. Publishing here is one CLI command against a table
 * the serving process reads on the next request: seconds, no build, no restart.
 *
 * The cost is real and worth naming: entry prose is written at a terminal rather
 * than reviewed in a diff. That is what the same-time requirement forces —
 * review latency *is* publish latency — and it is bounded by the three
 * properties below.
 *
 * ## Which file, and the fourth handle
 *
 * The same file as the key store and the usage tables: `API_KEYS_DB_PATH`,
 * resolved through {@link resolveApiKeysDbPath} rather than by reading the
 * variable here, so the "this is never the 376 GiB energy database" guard stays
 * a single decision in a single module. That is the rule
 * `v1/usage/sqliteUsageStore.ts` follows and `publicAppGraph.test.ts` asserts.
 *
 * `publicAppGraph.test.ts` names *a fourth module opening a database* as one of
 * the three things it exists to catch. This module is that fourth, so:
 *
 * - it opens **no new file** — the same small store we already own, not a new
 *   path for an operator to get wrong;
 * - the serving side is **readonly**, so the process answering public requests
 *   cannot alter a published notice;
 * - the read-write handle is reachable **only from `changelogCli.ts`**, which
 *   the graph test asserts is unreachable from either entrypoint.
 *
 * ## Three properties that bound the "not reviewed in a diff" cost
 *
 * 1. **`published_at` is stamped here and cannot be supplied.** There is no
 *    parameter for it and no `UPDATE` statement in this module, so a thirty-day
 *    notice cannot be manufactured after the fact.
 * 2. **Publication has a total order.** See {@link nextPublishedAt}.
 * 3. **Every insert is validated** by `assertPublishable`, so the rules the
 *    Terms impose on the two instants are enforced by the store rather than by
 *    the operator remembering them.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS changelog_entries (
  id             TEXT PRIMARY KEY,
  -- 'planned' | 'correction'. Not a CHECK constraint: the readable refusal is
  -- in changelogEntry.ts, which can say *why* a planned change needs 30 days,
  -- and a constraint that duplicates it would report SQLITE_CONSTRAINT instead.
  entry_type     TEXT NOT NULL,
  -- Stamped at insert. There is no code path that sets this from an argument.
  published_at   TEXT NOT NULL,
  effective_at   TEXT NOT NULL,
  title          TEXT NOT NULL,
  detail         TEXT NOT NULL,
  -- Required on a correction, NULL on anything else.
  what_was_wrong TEXT,
  is_example     INTEGER NOT NULL DEFAULT 0
);

-- The one query the request path makes, in the order it wants them.
CREATE INDEX IF NOT EXISTS idx_changelog_published
  ON changelog_entries(published_at DESC, id DESC);
`;

const LIST_SQL = `
  SELECT id, entry_type, published_at, effective_at, title, detail, what_was_wrong, is_example
    FROM changelog_entries
   ORDER BY published_at DESC, id DESC
`;

function readEntry(row: Record<string, unknown>): ChangelogEntry {
  return {
    id: row.id as string,
    type: row.entry_type as ChangelogEntryType,
    publishedAt: row.published_at as string,
    effectiveAt: row.effective_at as string,
    title: row.title as string,
    detail: row.detail as string,
    whatWasWrong: (row.what_was_wrong as string | null) ?? null,
    isExample: row.is_example === 1,
  };
}

/**
 * `cl_` plus 12 base62 characters, the same shape as an account or key id.
 *
 * Opaque rather than sequential because it is the fragment identifier of the
 * entry on the public page: `#cl_7f3a9c21b4d0` is a link a subscriber can keep,
 * and it says nothing about how many entries there are or in what order they
 * were written.
 */
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function newEntryId(): string {
  const bytes = randomBytes(12);
  let out = '';
  for (const byte of bytes) out += BASE62[byte % 62];
  return `cl_${out}`;
}

function makeReader(db: DatabaseType): ChangelogReader {
  const list = db.prepare(LIST_SQL);
  return {
    list() {
      const rows = list.all() as Record<string, unknown>[];
      // Sorted again in TypeScript rather than trusting the `ORDER BY` alone.
      // Not distrust of SQLite: the ordering rule is a *product* rule — newest
      // by publication, never by effective instant — and it is asserted against
      // `sortEntriesNewestFirst` in a pure test. Applying the same function here
      // means the page cannot disagree with the rule if the index is ever
      // changed or the query is rewritten.
      return sortEntriesNewestFirst(rows.map(readEntry));
    },
    close() {
      db.close();
    },
  };
}

/**
 * Open the change log for serving: readonly, and the file must already exist.
 *
 * Both properties copied deliberately from `openApiKeyDirectory`. `fileMustExist`
 * so a path typo cannot create an empty database and serve a change log with
 * nothing in it — an empty page at a URL the Terms name is a worse failure than
 * a process that refuses to start, because nothing about it looks broken.
 *
 * Both refusals name `entries:init`, and deliberately not `entries:seed
 * --examples`: seeding is the one command every other line of documentation says
 * never to run against a store that serves subscribers, and this module has no
 * delete to undo it with. A startup error is the instruction an operator is
 * guaranteed to read, so it must not be the one that publishes two entries
 * giving notice of nothing. See `changelogCli.ts`, `entries:init`.
 */
export function openChangelogReader(env: NodeJS.ProcessEnv = process.env): ChangelogReader {
  const dbPath = resolveApiKeysDbPath(env);
  let db: DatabaseType;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new Error(
      `Cannot open the /v1 change log at ${dbPath}: ${(err as Error).message}. ` +
        'Create it with `npm run changelog -- entries:init` in server/, which opens the same ' +
        'path read-write, applies the schema, and publishes nothing.'
    );
  }

  const hasSchema = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'changelog_entries'")
    .get();
  if (!hasSchema) {
    db.close();
    throw new Error(
      `The file at ${dbPath} has no changelog_entries table. Run ` +
        '`npm run changelog -- entries:init` in server/ to create it, or check API_KEYS_DB_PATH.'
    );
  }

  return makeReader(db);
}

/**
 * Open the change log for publishing: read-write, creating and migrating if
 * needed.
 *
 * Reached only from `changelogCli.ts`, which `publicAppGraph.test.ts` asserts is
 * unreachable from either serving entrypoint.
 */
export function openChangelogAdminStore(
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date()
): ChangelogAdminStore {
  const db = new Database(resolveApiKeysDbPath(env));
  // WAL for the reason the key store uses it: the serving process holds a
  // readonly handle on this same file, and publishing an entry must never block
  // authentication — nor be blocked by it. It is also what makes the publish
  // path fast in the sense that matters: the reader sees the new row on its next
  // query, with no restart and nothing to invalidate.
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);

  const reader = makeReader(db);
  const maxPublished = db.prepare('SELECT MAX(published_at) AS latest FROM changelog_entries');

  /**
   * The publication instant for the next entry: now, or one millisecond after
   * the newest existing entry, whichever is later.
   *
   * This gives publication a **total order**, which is what "newest first" needs
   * to be a well-defined statement rather than a stable-sort accident. Two
   * entries published in the same millisecond — two corrections during one
   * incident, or the two seeded examples — would otherwise be ordered by an id
   * tie-break, i.e. arbitrarily, on a page whose whole job is to say what we
   * said and when.
   *
   * The nudge is at most a few milliseconds and only ever forward, so it cannot
   * shorten a notice period: `assertPublishable` measures against this value, so
   * a planned entry nudged forward needs *more* than thirty days, never less.
   */
  function nextPublishedAt(): string {
    const wall = now().toISOString();
    const latest = (maxPublished.get() as { latest: string | null }).latest;
    if (latest === null || latest < wall) return wall;
    return new Date(Date.parse(latest) + 1).toISOString();
  }

  const insert = db.prepare(
    `INSERT INTO changelog_entries
       (id, entry_type, published_at, effective_at, title, detail, what_was_wrong, is_example)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  return {
    ...reader,

    publish(draft) {
      // One transaction so the "read the newest, insert after it" pair cannot
      // interleave with a second publisher. better-sqlite3 is synchronous, so
      // the only writer that could race is another process — and the CLI is
      // exactly the thing an operator might run twice in one incident.
      const write = db.transaction((): ChangelogEntry => {
        const entry: ChangelogEntry = {
          id: newEntryId(),
          type: draft.type,
          publishedAt: nextPublishedAt(),
          effectiveAt: draft.effectiveAt,
          title: draft.title.trim(),
          detail: draft.detail.trim(),
          whatWasWrong:
            typeof draft.whatWasWrong === 'string' && draft.whatWasWrong.trim() !== ''
              ? draft.whatWasWrong.trim()
              : null,
          isExample: draft.isExample === true,
        };

        // Inside the transaction, so a refused entry leaves nothing behind —
        // including the publication instant it would have claimed.
        assertPublishable(entry);

        insert.run(
          entry.id,
          entry.type,
          entry.publishedAt,
          entry.effectiveAt,
          entry.title,
          entry.detail,
          entry.whatWasWrong,
          entry.isExample ? 1 : 0
        );
        return entry;
      });

      return write();
    },
  };
}
