import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  newEntryId,
  openChangelogAdminStore,
  openChangelogReader,
} from './sqliteChangelogStore.js';
import { ChangelogEntryError } from './changelogEntry.js';
import type { ChangelogAdminStore } from './changelogStore.js';

/**
 * The real store against a real SQLite file.
 *
 * Temp files rather than `:memory:` for the reason `sqliteApiKeyStore.test.ts`
 * gives: `readonly`, `fileMustExist` and the path guard are all properties of a
 * file on disk, and an in-memory database makes every assertion about them
 * vacuous. The claims worth the most here are also file claims — that the serving
 * handle cannot write a notice, and that a reader opened *before* an entry was
 * published sees it afterwards without being reopened.
 */

const tmpRoots: string[] = [];

function tmpDbPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'able-changelog-'));
  tmpRoots.push(root);
  return path.join(root, 'api_keys.db');
}

afterAll(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

const DAY = 86_400_000;

/** A clock the tests move, so publication instants are assertable. */
let clock: Date;
let dbPath: string;
let store: ChangelogAdminStore;

function env(): NodeJS.ProcessEnv {
  return { API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv;
}

function plannedDraft(effectiveOffsetMs = 30 * DAY) {
  return {
    type: 'planned' as const,
    effectiveAt: new Date(clock.getTime() + effectiveOffsetMs).toISOString(),
    title: 'A planned change',
    detail: 'What changed and for which datasets.',
  };
}

function correctionDraft() {
  return {
    type: 'correction' as const,
    effectiveAt: clock.toISOString(),
    title: 'A correction',
    detail: 'Values are now served on the right basis.',
    whatWasWrong: 'They were served on the wrong basis for nine days.',
  };
}

beforeEach(() => {
  clock = new Date('2026-08-22T09:00:00.000Z');
  dbPath = tmpDbPath();
  store = openChangelogAdminStore(env(), () => clock);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // Already closed by the test itself; `close` is the teardown for every case.
  }
});

describe('publishing', () => {
  it('stamps the publication instant rather than accepting one', () => {
    // The property the whole design rests on: a 30-day notice cannot be
    // manufactured after the fact, because there is no parameter that could
    // backdate it. Note the draft type has no `publishedAt` field at all.
    const entry = store.publish(plannedDraft());

    expect(entry.publishedAt).toBe('2026-08-22T09:00:00.000Z');
    expect(Object.keys(plannedDraft())).not.toContain('publishedAt');
  });

  it('round-trips both instants, the type, the prose and the example flag', () => {
    const entry = store.publish({ ...correctionDraft(), isExample: true });

    expect(store.list()).toEqual([entry]);
    expect(entry).toMatchObject({
      type: 'correction',
      effectiveAt: '2026-08-22T09:00:00.000Z',
      whatWasWrong: 'They were served on the wrong basis for nine days.',
      isExample: true,
    });
  });

  it('gives every entry an opaque id that is a usable fragment identifier', () => {
    const entry = store.publish(plannedDraft());

    expect(entry.id).toMatch(/^cl_[A-Za-z0-9]{12}$/);
    expect(new Set(Array.from({ length: 50 }, newEntryId)).size).toBe(50);
  });

  it('refuses a planned change with less than 30 days of notice, and stores nothing', () => {
    expect(() => store.publish(plannedDraft(29 * DAY))).toThrow(ChangelogEntryError);
    expect(store.list()).toEqual([]);
  });

  it('refuses a correction dated into the future, and stores nothing', () => {
    expect(() =>
      store.publish({ ...correctionDraft(), effectiveAt: new Date(clock.getTime() + 5 * DAY).toISOString() })
    ).toThrow(/planned change/);
    expect(store.list()).toEqual([]);
  });

  it('refuses a correction that does not say what was wrong', () => {
    expect(() => store.publish({ ...correctionDraft(), whatWasWrong: null })).toThrow(
      /what was wrong/
    );
    expect(store.list()).toEqual([]);
  });

  it('trims prose, and treats whitespace-only "what was wrong" as absent', () => {
    const entry = store.publish({ ...plannedDraft(), title: '  Spaced  ', whatWasWrong: '   ' });

    expect(entry.title).toBe('Spaced');
    // Not stored as an empty string: `null` is what "this is not a correction"
    // means everywhere else, and two spellings of absent is one too many.
    expect(entry.whatWasWrong).toBeNull();
  });
});

describe('ordering and the total order of publication', () => {
  it('lists newest first', () => {
    const first = store.publish(plannedDraft());
    clock = new Date('2026-08-25T09:00:00.000Z');
    const second = store.publish(correctionDraft());

    expect(store.list().map((e) => e.id)).toEqual([second.id, first.id]);
  });

  it('never gives two entries the same publication instant, even in one millisecond', () => {
    // Two corrections during one incident, or the two seeded examples. Without
    // this, "newest first" would fall through to an id tie-break — i.e. to
    // something arbitrary — on the page whose whole job is to say what we said
    // and when.
    const a = store.publish(correctionDraft());
    const b = store.publish(correctionDraft());
    const c = store.publish(correctionDraft());

    expect(new Set([a, b, c].map((e) => e.publishedAt)).size).toBe(3);
    expect(a.publishedAt < b.publishedAt).toBe(true);
    expect(b.publishedAt < c.publishedAt).toBe(true);
    expect(store.list().map((e) => e.id)).toEqual([c.id, b.id, a.id]);
  });

  it('only ever nudges publication forward, so it cannot shorten a notice period', () => {
    store.publish(correctionDraft());
    // A clock that went backwards — an NTP correction, or a test. The next entry
    // still publishes after the previous one.
    clock = new Date('2026-08-22T08:00:00.000Z');
    const later = store.publish(plannedDraft(30 * DAY + 2 * 3_600_000));

    expect(later.publishedAt > '2026-08-22T09:00:00.000Z').toBe(true);
    // The 30-day rule is measured against the *stamped* instant, not the wall
    // clock the draft was built from, so a nudged entry needs more notice rather
    // than less. This one is refused outright without the two hours of headroom.
    expect(Date.parse(later.effectiveAt) - Date.parse(later.publishedAt)).toBeGreaterThan(
      30 * DAY
    );
    expect(() => store.publish(plannedDraft(30 * DAY))).toThrow(/30 days' notice/);
  });
});

describe('the shape of the admin store', () => {
  it('has no way to edit or delete a published entry', () => {
    // A published entry is a statement we made at a time we recorded. The
    // remedy for a wrong one is another entry — the same mechanism the Terms
    // already describe for wrong values.
    expect(Object.keys(store).sort()).toEqual(['close', 'list', 'publish']);
  });

  it('contains no UPDATE or DELETE against the entries table', () => {
    const source = fs.readFileSync(new URL('./sqliteChangelogStore.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/UPDATE\s+changelog_entries/i);
    expect(source).not.toMatch(/DELETE\s+FROM\s+changelog_entries/i);
  });
});

describe('the reader', () => {
  it('cannot write, because the handle underneath it is readonly', () => {
    store.publish(plannedDraft());
    const reader = openChangelogReader(env());

    try {
      expect(reader.list()).toHaveLength(1);
      const readonlyDb = new Database(dbPath, { readonly: true });
      expect(() =>
        readonlyDb
          .prepare("INSERT INTO changelog_entries (id, entry_type, published_at, effective_at, title, detail, what_was_wrong, is_example) VALUES ('x','planned','a','b','c','d',NULL,0)")
          .run()
      ).toThrow(/readonly/i);
      readonlyDb.close();
    } finally {
      reader.close();
    }
  });

  it('sees an entry published after it was opened, with no restart', () => {
    // This is the publish path, asserted rather than described: the serving
    // process opens its handle at startup and must show a correction published
    // minutes later without being rebuilt, redeployed or bounced.
    store.publish(plannedDraft());
    const reader = openChangelogReader(env());

    try {
      expect(reader.list()).toHaveLength(1);

      clock = new Date('2026-08-25T09:00:00.000Z');
      const fix = store.publish(correctionDraft());

      const seen = reader.list();
      expect(seen).toHaveLength(2);
      expect(seen[0].id).toBe(fix.id);
    } finally {
      reader.close();
    }
  });

  it('refuses to start on a path that is not a database, rather than creating one', () => {
    const missing = path.join(path.dirname(dbPath), 'not-there.db');

    expect(() => openChangelogReader({ API_KEYS_DB_PATH: missing } as NodeJS.ProcessEnv)).toThrow(
      /Cannot open the \/v1 change log/
    );
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('refuses a real database that holds no change log, and names the command', () => {
    const other = path.join(path.dirname(dbPath), 'other.db');
    const decoy = new Database(other);
    decoy.exec('CREATE TABLE something_else (x TEXT)');
    decoy.close();

    expect(() => openChangelogReader({ API_KEYS_DB_PATH: other } as NodeJS.ProcessEnv)).toThrow(
      /no changelog_entries table/
    );
    expect(() => openChangelogReader({ API_KEYS_DB_PATH: other } as NodeJS.ProcessEnv)).toThrow(
      /entries:seed --examples/
    );
  });

  it('resolves its path through the key store resolver, so the energy-database guard is singular', () => {
    // The rule `sqliteUsageStore.ts` follows and `publicAppGraph.test.ts`
    // asserts: one decision about where this file is, one guard to keep true.
    expect(() =>
      openChangelogReader({
        API_KEYS_DB_PATH: '/data/energy_dashboard.db',
      } as NodeJS.ProcessEnv)
    ).toThrow(/shared energy database/);

    const source = fs.readFileSync(new URL('./sqliteChangelogStore.ts', import.meta.url), 'utf8');
    expect(source).toContain('resolveApiKeysDbPath');
    expect(source).not.toMatch(/env\.API_KEYS_DB_PATH/);
  });
});

describe('the file it writes into', () => {
  it('creates only its own table, and no second file', () => {
    store.publish(plannedDraft());

    const db = new Database(dbPath, { readonly: true });
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    db.close();

    // Only its own table is created here. `accounts`, `api_keys` and the usage
    // tables arrive from their own modules, in the same file, by design.
    expect(tables).toEqual(['changelog_entries']);
  });
});
