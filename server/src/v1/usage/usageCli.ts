import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolveApiKeysDbPath } from '../keys/sqliteApiKeyStore.js';
import { openUsageStore } from './sqliteUsageStore.js';
import { reportFullPass, runUsageMaintenance } from './usageMaintenance.js';
import { resolveRetentionPolicy, type UsageAdminStore, type UsageRollupRow } from './usageStore.js';
import {
  classifyFingerprintBreadth,
  classifyKeyOrigins,
  classifySecretHolderFailures,
  renderEnumerationReport,
  renderFingerprintBreadthReport,
  renderKeyOriginReport,
  renderSecretHolderReport,
  DEFAULT_ROW_LIMIT,
} from '../security/securityReport.js';
import type { AuthFailureWindow } from '../security/authFailureStore.js';

/**
 * `npm run usage -- <command>` — the invoice figure, the scheduled jobs, and
 * the subject access request.
 *
 * Three audiences, one tool:
 *
 * - **Billing.** `usage:month` prints the figure an invoice is raised from. It
 *   reads `usage_rollup` and never `usage_events`, which is the whole point of
 *   the rollup existing: ABL-297 §9(2) requires the monthly aggregate to be a
 *   durable record with a lifecycle independent of the raw log, because the raw
 *   rows are deleted at 13 months and an invoice must be defensible for seven
 *   years. A command that recomputed from events would work perfectly for a
 *   year and then start returning zero for exactly the months somebody is
 *   disputing.
 * - **Operations.** `usage:maintain` is the same pass the serving process runs
 *   on a timer, available to run by hand — after a long outage, before closing
 *   a month, or when `usage:stats` says the rollup is behind.
 * - **Privacy.** `usage:export` answers a subject access request, and
 *   `usage:stats` is the standing check that ABL-297 §5 is actually being met.
 *   The procedure both belong to is written out in `PRIVACY-AND-RETENTION.md`
 *   beside this file.
 *
 * ```
 * cd server
 * npm run usage -- usage:stats
 * npm run usage -- usage:month --month 2026-07
 * npm run usage -- usage:maintain
 * npm run usage -- usage:export --account acct_… --out acct-export.json
 * ```
 *
 * Reads the same `API_KEYS_DB_PATH` as the keys CLI, because the usage tables
 * live in the key store file. Hand-rolled argument parsing, reusing
 * `keysCli.ts`'s parser, for the reason stated there: a public surface should
 * not be how a sixth runtime dependency arrives.
 */

interface ParsedArgs {
  command: string;
  flags: Record<string, string | true>;
}

/**
 * `--name value` / `--flag`.
 *
 * A copy of `keysCli.ts`'s parser rather than an import of it, and the reason is
 * the module graph: `keysCli.ts` opens the key store **read-write** at import
 * time under its `isMain` guard, and `publicAppGraph.test.ts` asserts the
 * serving entrypoint cannot reach it. Importing eight lines of string handling
 * from it would put an operator-only module one edge away from every consumer of
 * this one. Eight duplicated lines is the cheaper of the two.
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

/** `1 key-month` / `2 key-months`. Operator output is read by people. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function requireString(flags: ParsedArgs['flags'], name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError(`--${name} is required and needs a value.`);
  }
  return value.trim();
}

/**
 * A `--days` / `--hours` lookback, validated.
 *
 * Rejected rather than defaulted when it is present and unreadable: an
 * investigator who typed `--days 7d` and got a silent 24-hour window would draw
 * a conclusion from a period they did not choose, which on this particular set
 * of commands is how "no enumeration in the window" gets believed.
 */
export function requirePositiveNumber(
  flags: ParsedArgs['flags'],
  name: string,
  fallback: number
): number {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  const value = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError(`--${name} must be a positive number of ${name}, and is "${String(raw)}".`);
  }
  return value;
}

/**
 * How many rows of a security report to print.
 *
 * Capped by default, because the very shape these reports exist to surface — one
 * address presenting hundreds of distinct prefixes — produces one row per prefix
 * and pushes the finding off the top of a terminal. The renderers state the count
 * they dropped rather than truncating silently, which is the part that makes a cap
 * acceptable on a security report at all.
 */
export function rowLimit(flags: ParsedArgs['flags']): number {
  return requirePositiveNumber(flags, 'limit', DEFAULT_ROW_LIMIT);
}

/** A half-open `[now - hours, now)` window, in the ISO form `received_at` holds. */
export function lookbackWindow(now: Date, hours: number): AuthFailureWindow {
  return {
    since: new Date(now.getTime() - hours * 3_600_000).toISOString(),
    until: now.toISOString(),
  };
}

/** `YYYY-MM`, validated, because a typo here silently reports an empty month. */
export function requireYearMonth(flags: ParsedArgs['flags'], name = 'month'): string {
  const value = requireString(flags, name);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new UsageError(`--${name} must be a UTC calendar month as YYYY-MM, and is "${value}".`);
  }
  return value;
}

/**
 * One rollup row as a line.
 *
 * `billable` is printed before `requests` and separately from it, because they
 * are different numbers and the invoice is raised on the first. Printing only a
 * total would hide the 4xx and the aborted responses we deliberately do not
 * charge for, which are the rows a customer questioning an invoice is most
 * likely to be asking about.
 */
export function describeRollup(row: UsageRollupRow): string {
  const state = row.closedAt ? `closed ${row.closedAt.slice(0, 10)}` : 'open';
  const late =
    row.lateRequests > 0 ? `  late=${row.lateRequests}/${row.lateBillableRequests} NOT BILLED` : '';
  return (
    `${row.accountId}  ${row.keyId}  billable=${String(row.billableRequests).padStart(9)}  ` +
    `requests=${String(row.requests).padStart(9)}  rows=${String(row.rowsReturned).padStart(11)}  ` +
    `${state}${late}`
  );
}

const USAGE = `
Per-key usage metering for /v1. Reads API_KEYS_DB_PATH — the same SQLite file as the key
store, never the energy database.

  usage:month       --month <YYYY-MM> [--account <acct_...>]
                    The billable figure, read from usage_rollup and never recomputed from
                    raw events. This is the number an invoice is raised on.

  usage:roll-up     Aggregate new events into usage_rollup. Idempotent.
  usage:close-months  Finalise every month past its grace period. Irreversible.
  usage:retention   Apply the ABL-297 §5 boundaries: clear IP and user agent past
                    USAGE_PII_RETENTION_DAYS, delete de-identified rows past
                    USAGE_EVENT_RETENTION_MONTHS.
  usage:maintain    All three, in the only order that is safe: roll up, close, retain.

  usage:export      --account <acct_...> [--out <file.json>]
                    Every record held about one account, for a subject access request.
                    Never includes a key secret hash. See PRIVACY-AND-RETENTION.md.

  usage:stats       Counts, the rollup watermark, and the retention compliance check.

The serving process runs usage:maintain on a timer already; these commands exist so an
operator can run the same thing by hand, and so a month can be closed deliberately.

Breach-detection reads (ABL-530, signals from ABL-524 'breach-signals' §2). These answer
four questions an investigator would otherwise write SQL for at three in the morning.
Each reports the window it actually covered: address history is scrubbed at
USAGE_PII_RETENTION_DAYS, so every one of them has a memory and then has none.

  security:auth-failures    [--hours 24]
                    S3. Refusals grouped by source address and by presented prefix.
                    Many prefixes from one address is enumeration; one prefix from many
                    addresses is a leaked key. The presented *secret* is never recorded
                    and is not in this table.

  security:secret-holders   [--days 30]
                    S4, and the highest specificity on the list. Refusals that happened
                    *after* the secret matched — revoked, expired, disabled, environment
                    mismatch. Anyone here holds a real key; there is no guessing path to
                    it. Cross-referenced against the addresses that key was served from.

  security:key-origins      [--days 30] [--key key_...]
                    S2. Successful use per key per origin. Flags a new origin appearing
                    while an older one keeps running — the stolen-credential shape, as
                    opposed to a redeploy. Says "no history" rather than "never before"
                    when the retained window cannot support the claim.

  security:key-breadth      [--days 7] [--baseline-days 30]
                    S5. Distinct request fingerprints per key, recent against that key's
                    own baseline, never a global one. Reported and deliberately NOT
                    graded: there is no live traffic on this surface to calibrate a
                    cutoff against.

All four take [--limit N] and print 25 rows per table by default, then say how many they
did not show. The cap exists because the shape these reports surface — one address
presenting hundreds of prefixes — produces one row per prefix and would otherwise push
the finding off the top of the terminal.

None of these alerts anybody. Recording and reading is the whole of ABL-530; where an
alert should go is an open Board decision (ABL-524 §6).
`.trim();

export function runCommand(
  store: UsageAdminStore,
  { command, flags }: ParsedArgs,
  now: Date = new Date(),
  log: (line: string) => void = (line) => console.log(line)
): void {
  switch (command) {
    case 'usage:month': {
      const yearMonth = requireYearMonth(flags);
      const account = typeof flags.account === 'string' ? flags.account : undefined;
      const rows = store
        .monthlyUsage(yearMonth)
        .filter((row) => account === undefined || row.accountId === account);

      if (rows.length === 0) {
        log(`No usage recorded for ${yearMonth}${account ? ` on ${account}` : ''}.`);
        // Said explicitly, because "no rows" has two very different causes and
        // an operator about to raise a zero invoice needs to know which.
        log('If that is unexpected, run usage:stats — the rollup may simply be behind.');
        return;
      }

      for (const row of rows) log(describeRollup(row));

      const billable = rows.reduce((sum, row) => sum + row.billableRequests, 0);
      const requests = rows.reduce((sum, row) => sum + row.requests, 0);
      const open = rows.filter((row) => row.closedAt === null).length;
      log(
        `\n${yearMonth}: ${billable} billable of ${requests} requests, ` +
          `${plural(rows.length, 'key-month')}.`
      );
      if (open > 0) {
        log(
          `${plural(open, 'key-month')} ${open === 1 ? 'is' : 'are'} still open, so these figures ` +
            'can still change. Invoice from a closed month, or close it first with ' +
            'usage:close-months.'
        );
      }
      return;
    }

    case 'usage:roll-up': {
      const outcome = store.rollUp();
      log(
        `rolled ${outcome.events} events into ${outcome.rows} rollup rows, ` +
          `watermark now ${outcome.rolledThroughEventId}` +
          (outcome.moreRemaining ? ' — more remaining, run again' : '')
      );
      return;
    }

    case 'usage:close-months': {
      const { closed, deferred } = store.closeMonths(now);
      if (closed.length === 0 && deferred.length === 0) {
        log('Nothing due to close.');
        return;
      }
      if (closed.length > 0) log(`closed ${closed.join(', ')} — final, and never recomputed.`);
      if (deferred.length > 0) {
        log(
          `deferred ${deferred.join(', ')} — events for those months are not aggregated yet. ` +
            'Run usage:roll-up first.'
        );
      }
      return;
    }

    case 'usage:retention': {
      const outcome = store.applyRetention(now);
      const policy = describePolicy();
      log(
        `scrubbed ${outcome.scrubbed} records (IP and user agent cleared past ${policy.piiDays} ` +
          `days), deleted ${outcome.deleted} de-identified records past ${policy.eventMonths} months`
      );
      if (outcome.keptPendingRollup > 0) {
        log(
          `KEPT ${outcome.keptPendingRollup} records past the deletion boundary: they are not in ` +
            'the rollup, so deleting them would remove them from an invoice permanently. Fix the ' +
            'rollup, then run this again.'
        );
      }
      return;
    }

    case 'usage:maintain': {
      const outcome = runUsageMaintenance(store, now);
      log(
        `rolled ${outcome.rollUp.events} events in ${outcome.rollUp.passes} pass(es), ` +
          `watermark now ${outcome.rollUp.rolledThroughEventId}`
      );
      if (!outcome.rollUp.drained) log('The rollup did not drain — run usage:maintain again.');
      reportFullPass(outcome, log);
      log('Done.');
      return;
    }

    case 'usage:export': {
      const accountId = requireString(flags, 'account');
      const exported = store.exportAccount(accountId);
      const json = JSON.stringify(exported, null, 2);

      if (typeof flags.out === 'string') {
        fs.writeFileSync(flags.out, json, 'utf8');
        log(
          `wrote ${exported.events.length} request records, ` +
            `${exported.authFailures.length} refused-request records, ` +
            `${exported.rollups.length} monthly ` +
            `aggregates and ${exported.keys.length} keys for ${accountId} to ${flags.out}`
        );
        // The one warning worth printing every time. The file is the subject's
        // data, it contains IP addresses for the last 90 days, and it is about
        // to be sent somewhere by whoever ran this.
        log('That file contains personal data (IP addresses). Send it over an encrypted channel.');
        return;
      }

      log(json);
      return;
    }

    case 'usage:stats': {
      const stats = store.stats(now);
      const policy = describePolicy();
      log(`events            ${stats.events}`);
      log(`  not yet rolled  ${stats.unrolledEvents}`);
      log(`  oldest          ${stats.oldestEventAt ?? '-'}`);
      log(`  newest          ${stats.newestEventAt ?? '-'}`);
      log(`rollup rows       ${stats.rollupRows}  (${stats.closedMonths} closed months)`);
      log(`watermark         ${stats.rolledThroughEventId}`);
      log(
        `retention         IP/user-agent cleared at ${policy.piiDays} days, records deleted at ` +
          `${policy.eventMonths} months`
      );

      // The auth-failure record (ABL-530). Printed beside the request counts
      // rather than under its own command, because it is inside the same
      // retention promise and an operator checking that promise should see both
      // tables in one place — the split is what would let one of them be
      // forgotten.
      log(`auth failures     ${stats.authFailures.records}`);
      log(`  secret proven   ${stats.authFailures.secretVerifiedRecords}  (S4 — run security:secret-holders)`);
      log(`  oldest          ${stats.authFailures.oldestAt ?? '-'}`);
      log(`  newest          ${stats.authFailures.newestAt ?? '-'}`);

      if (stats.unscrubbedPastPii > 0) {
        log(
          `\nNOT COMPLIANT: ${stats.unscrubbedPastPii} records past ${policy.piiDays} days ` +
            'still hold an IP address or user agent ' +
            `(${stats.unscrubbedPastPiiByTable.usageEvents} request, ` +
            `${stats.unscrubbedPastPiiByTable.authFailures} auth-failure). The privacy notice ` +
            'says we delete these. Run usage:retention.'
        );
      } else {
        log(
          `\nRetention check: OK — no record past ${policy.piiDays} days holds personal data, ` +
            'in either table.'
        );
      }

      if (stats.unrolledEvents > 0) {
        log(
          `${stats.unrolledEvents} events are not in the rollup, so a month's figures are ` +
            'incomplete until usage:roll-up runs.'
        );
      }
      return;
    }

    /*
     * The four breach-detection reads (ABL-530). Each one hands the store's rows
     * to a pure classifier and a pure renderer in `security/securityReport.ts`,
     * so the judgement and the words are asserted by a test rather than captured
     * from a console — which matters more here than for the billing commands,
     * because the distinctions this report keeps ("we no longer remember" against
     * "never seen from here") only exist if they survive into the output.
     */
    case 'security:auth-failures': {
      const window = lookbackWindow(now, requirePositiveNumber(flags, 'hours', 24));
      for (const line of renderEnumerationReport(
        window,
        store.failuresByOrigin(window),
        store.failuresByPrefix(window),
        rowLimit(flags)
      )) {
        log(line);
      }
      return;
    }

    case 'security:secret-holders': {
      const window = lookbackWindow(now, requirePositiveNumber(flags, 'days', 30) * 24);
      for (const line of renderSecretHolderReport(
        window,
        classifySecretHolderFailures(store.secretHolderFailures(window)),
        rowLimit(flags)
      )) {
        log(line);
      }
      return;
    }

    case 'security:key-origins': {
      const days = requirePositiveNumber(flags, 'days', 30);
      const since = new Date(now.getTime() - days * 86_400_000).toISOString();
      const keyId = typeof flags.key === 'string' ? flags.key : undefined;
      // The query is deliberately unwindowed and `since` is applied by the
      // classifier — see `keyOrigins`. A windowed query cannot answer "has this
      // key ever been used from here before", because every origin looks new if
      // you only fetch the last week.
      for (const line of renderKeyOriginReport(
        since,
        classifyKeyOrigins(store.keyOrigins(keyId), since),
        describePolicy().piiDays,
        rowLimit(flags)
      )) {
        log(line);
      }
      return;
    }

    case 'security:key-breadth': {
      const recentDays = requirePositiveNumber(flags, 'days', 7);
      const baselineDays = requirePositiveNumber(flags, 'baseline-days', 30);
      if (baselineDays <= recentDays) {
        throw new UsageError(
          `--baseline-days (${baselineDays}) must be greater than --days (${recentDays}): the ` +
            'baseline is the period *before* the recent window, and overlapping them would ' +
            'dilute a genuine widening with the very traffic being asked about.'
        );
      }
      const recent = lookbackWindow(now, recentDays * 24);
      const baselineSince = new Date(now.getTime() - baselineDays * 86_400_000).toISOString();
      for (const line of renderFingerprintBreadthReport(
        recent,
        baselineSince,
        classifyFingerprintBreadth(store.keyFingerprintBreadth(recent, baselineSince)),
        rowLimit(flags)
      )) {
        log(line);
      }
      return;
    }

    case '':
    case 'help':
    case '--help':
    case 'security:help':
      log(USAGE);
      return;

    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

/**
 * The configured periods, for printing.
 *
 * Read from the environment rather than from the store, so the numbers in the
 * output are the ones an operator can change in `.env.public` — which is the
 * form ABL-297 §5 requires them to take ("a config change and not a migration").
 */
function describePolicy(): { piiDays: number; eventMonths: number } {
  return resolveRetentionPolicy();
}

/**
 * Entry point, run only when this module is the process's main script.
 *
 * The guard keeps the module importable by `usageCli.test.ts`, which drives
 * {@link runCommand} against a real store on a temp file and would otherwise
 * find the CLI opening `API_KEYS_DB_PATH` at import time. Same shape as
 * `keysCli.ts`, deliberately.
 */
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  let store: UsageAdminStore | undefined;
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (['', 'help', '--help', 'security:help'].includes(parsed.command)) {
      console.log(USAGE);
      process.exit(0);
    }
    console.log(`usage store: ${resolveApiKeysDbPath()}`);
    store = openUsageStore();
    runCommand(store, parsed);
  } catch (err) {
    console.error(`\n${(err as Error).message}\n`);
    if (err instanceof UsageError) console.error(USAGE);
    process.exitCode = 1;
  } finally {
    store?.close();
  }
}
