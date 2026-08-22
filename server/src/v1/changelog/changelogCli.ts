import { pathToFileURL } from 'node:url';
import {
  CHANGELOG_ENTRY_TYPES,
  ChangelogEntryError,
  NOTICE_PERIOD_DAYS,
  SAME_TIME_TOLERANCE_MS,
  correctionPublicationLagMs,
  describeNotice,
  formatInterval,
  parseInstant,
  toWireChangelog,
  type ChangelogEntry,
  type ChangelogEntryType,
} from './changelogEntry.js';
import { buildExampleEntries } from './exampleEntries.js';
import { openChangelogAdminStore } from './sqliteChangelogStore.js';
import type { ChangelogAdminStore } from './changelogStore.js';
import { resolveApiKeysDbPath } from '../keys/sqliteApiKeyStore.js';

/**
 * `npm run changelog -- <command>` — publish and inspect change-log entries.
 *
 * **This command is the publish path**, and its latency is the reason the change
 * log is a table rather than a set of committed files. §9.3.2 lets a correction
 * to wrong values be served immediately and requires its entry to go up at the
 * same time; this repository has no CI/CD and is deployed by hand, so an entry
 * that needed a build would go up hours or days after the change it announces.
 * Running this takes seconds and the serving process picks the entry up on its
 * next request — no rebuild, no restart, nothing to invalidate.
 *
 * The trade that comes with it, stated where an operator will see it: **the prose
 * you type here is not reviewed in a diff.** Three things bound that — the
 * publication instant is stamped by the store and cannot be given, the store has
 * no update or delete, and every rule the Terms put on the two instants is
 * enforced at insert rather than left to you to remember.
 *
 * ```
 * cd server
 * npm run changelog -- entries:publish --type planned --effective 2026-10-01T00:00:00Z \
 *     --title "..." --detail "..."
 * npm run changelog -- entries:publish --type correction --effective 2026-08-22T14:00:00Z \
 *     --title "..." --detail "..." --what-was-wrong "..."
 * npm run changelog -- entries:init
 * npm run changelog -- entries:list
 * npm run changelog -- entries:export > changelog-backup.json
 * npm run changelog -- entries:seed --examples
 * ```
 */

interface ParsedArgs {
  command: string;
  flags: Record<string, string | true>;
}

/**
 * `--name value` / `--flag`, and nothing cleverer — the same parser
 * `keysCli.ts`, `usageCli.ts` and `billingCli.ts` each carry.
 *
 * Copied rather than shared, deliberately and for the third time: the alternative
 * is a `cli/args.ts` that every operator tool imports, which is one module away
 * from a shared `cli/` runtime that a serving entrypoint eventually reaches. The
 * duplication is fifteen lines with a colocated test; the coupling would be
 * permanent.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }

  return { command, flags };
}

class UsageError extends Error {}

function requireString(flags: ParsedArgs['flags'], name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError(`--${name} is required and needs a value.`);
  }
  return value.trim();
}

function requireType(flags: ParsedArgs['flags']): ChangelogEntryType {
  const value = requireString(flags, 'type');
  if (!(CHANGELOG_ENTRY_TYPES as readonly string[]).includes(value)) {
    throw new UsageError(
      `--type must be one of: ${CHANGELOG_ENTRY_TYPES.join(', ')}. ` +
        'A change that corrects values which are wrong is a correction; anything else that ' +
        'changes values we already serve is planned, and needs ' +
        `${NOTICE_PERIOD_DAYS} days' notice.`
    );
  }
  return value as ChangelogEntryType;
}

/** One entry as a listing row. Both instants, because one of them is never the whole story. */
export function describeEntry(entry: ChangelogEntry): string {
  const example = entry.isExample ? '  [EXAMPLE]' : '';
  return (
    `${entry.id}  ${entry.type.padEnd(10)}  published=${entry.publishedAt}  ` +
    `effective=${entry.effectiveAt}  (${describeNotice(entry)})${example}\n` +
    `    ${entry.title}`
  );
}

const USAGE = `
Publish and inspect /v1 change-log entries. Reads API_KEYS_DB_PATH — the same SQLite file as
the key store and the usage tables, never the energy database.

  entries:publish  --type <${CHANGELOG_ENTRY_TYPES.join('|')}> --effective <ISO-8601 instant>
                   --title <text> --detail <text>
                   [--what-was-wrong <text>]   required on a correction, refused otherwise
                   [--example]                 marks an entry that describes no real change
  entries:init                                 create the store. Publishes nothing, and is
                                               what a serving process that refuses to start
                                               for want of a change log needs run against it
  entries:list
  entries:export                               every entry as JSON, for archival
  entries:seed --examples                      install the two example entries. They describe
                                               no real change — never against a store that
                                               serves real subscribers

The publication instant is stamped at insert and cannot be supplied: a ${NOTICE_PERIOD_DAYS}-day
notice must not be manufacturable after the fact. --effective needs an explicit time zone
(2026-10-01T00:00:00Z or 2026-10-01T02:00:00+02:00); a time with no zone is refused rather
than read as this machine's local time.

A planned change is refused unless it is effective at least ${NOTICE_PERIOD_DAYS} days after
publication. A correction is refused if it is effective more than ${formatInterval(3_600_000)}
after publication — that is a planned change avoiding the notice period. Publishing a
correction late is warned about, not refused: a late entry beats no entry.

Nothing here can edit or delete a published entry. If one is wrong, publish another.
`.trim();

/**
 * `now` is injected for one command — `entries:seed`, whose example entries are
 * computed from the instant they are seeded at. Everything else takes its
 * timestamps from the store, which stamps them itself.
 */
export function runCommand(
  store: ChangelogAdminStore,
  { command, flags }: ParsedArgs,
  now: () => Date = () => new Date()
): void {
  switch (command) {
    case 'entries:publish': {
      const type = requireType(flags);
      const entry = store.publish({
        type,
        effectiveAt: parseInstant(requireString(flags, 'effective'), '--effective'),
        title: requireString(flags, 'title'),
        detail: requireString(flags, 'detail'),
        whatWasWrong: typeof flags['what-was-wrong'] === 'string' ? flags['what-was-wrong'] : null,
        isExample: flags.example === true,
      });

      console.log(`published ${entry.id}`);
      console.log(describeEntry(entry));
      console.log(`\nIt is on /changelog and /changelog.json now — the serving process reads`);
      console.log('this table per request, so there is nothing to rebuild or restart.');

      const lag = correctionPublicationLagMs(entry);
      if (entry.type === 'correction' && lag > SAME_TIME_TOLERANCE_MS) {
        // A warning rather than a refusal, and the refusal was considered: at
        // this point the change is already being served, so declining the entry
        // would trade a late notice for no notice at all. The gap is recorded in
        // the entry and shown on the page either way.
        console.warn(
          `\nWARNING: this entry went up ${formatInterval(lag)} after the change took effect. ` +
            "A correction's entry is meant to go up at the same time as the change. The page " +
            'shows both instants, so the gap is published rather than hidden.'
        );
      }
      return;
    }

    case 'entries:init': {
      // Applying the schema is `openChangelogAdminStore`'s doing — it runs it on
      // open — so by the time this case is reached the table exists. What this
      // command adds is a **name** for that, and the name is the point.
      //
      // `openChangelogReader` refuses to start when the table is absent, and its
      // refusal has to send the operator somewhere. It used to send them to
      // `entries:seed --examples`, which made the only documented way to create
      // the store the one command every other line of documentation says never to
      // run against a store that serves subscribers — and since there is no
      // delete anywhere in this module, an operator following that instruction at
      // first deployment would permanently publish two entries giving notice of
      // nothing, on the page §9.3 points subscribers at.
      //
      // Naming a command rather than documenting `entries:list`'s side effect:
      // `list` is a read, and giving it the readonly handle later — the
      // discipline this codebase applies everywhere else — would silently break
      // an instruction printed in a startup error. The contract here is that
      // running this makes the serving process able to start, and
      // `changelogCli.test.ts` pins that end to end rather than pinning a string.
      const entries = store.list();
      console.log('Change log ready: changelog_entries exists, and the serving process can');
      console.log('open it readonly.');
      if (entries.length === 0) {
        console.log('\nNothing is published, which is the correct state until something is. An');
        console.log('empty change log serves an empty page; only a missing table refuses.');
      } else {
        console.log(`\n${entries.length} already published, and nothing was changed — this command`);
        console.log('creates the store and never writes an entry. Run it as often as you like.');
      }
      return;
    }

    case 'entries:list': {
      const entries = store.list();
      if (entries.length === 0) {
        console.log('No entries published yet.');
        return;
      }
      for (const entry of entries) console.log(describeEntry(entry));
      return;
    }

    case 'entries:export': {
      // The published record as data, for an archive that outlives this file.
      // Entries are not in git — that is the price of a publish path fast enough
      // for a correction — so the thing that makes them recoverable is a dump
      // somebody can take, not a promise about backups.
      console.log(JSON.stringify(toWireChangelog(store.list()), null, 2));
      return;
    }

    case 'entries:seed': {
      if (flags.examples !== true) {
        throw new UsageError(
          'entries:seed needs --examples. The only thing it seeds is the two example entries, ' +
            'and they describe no real change: seeding them into a store that serves real ' +
            'subscribers would put two entries on the page that give notice of nothing. Naming ' +
            'them explicitly is what stops that happening by muscle memory.'
        );
      }

      const existing = store.list();
      if (existing.some((entry) => entry.isExample)) {
        console.log(
          `Already seeded: ${existing.filter((e) => e.isExample).length} example entries are ` +
            'published. Nothing to do — entries are append-only, so re-seeding would add ' +
            'duplicates rather than replace them.'
        );
        return;
      }

      for (const draft of buildExampleEntries(now())) {
        const entry = store.publish(draft);
        console.log(describeEntry(entry));
      }
      return;
    }

    case '':
    case 'help':
    case '--help':
      console.log(USAGE);
      return;

    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

/**
 * Entry point, run only when this module is the process's main script — the
 * guard that keeps it importable by `changelogCli.test.ts`, which drives
 * {@link runCommand} against a real store on a temp file.
 */
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  let store: ChangelogAdminStore | undefined;
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.command === '' || parsed.command === 'help' || parsed.command === '--help') {
      console.log(USAGE);
      process.exit(0);
    }
    console.log(`change log: ${resolveApiKeysDbPath()}`);
    store = openChangelogAdminStore();
    runCommand(store, parsed);
  } catch (err) {
    // A usage mistake gets the usage text; a refused entry gets its own
    // multi-line explanation and nothing else, because that message already
    // names every rule it broke and reprinting the usage under it buries them.
    console.error(`\n${(err as Error).message}\n`);
    if (err instanceof UsageError) console.error(USAGE);
    else if (!(err instanceof ChangelogEntryError)) console.error(USAGE);
    process.exitCode = 1;
  } finally {
    store?.close();
  }
}
