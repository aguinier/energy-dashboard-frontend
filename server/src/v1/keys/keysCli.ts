import { pathToFileURL } from 'node:url';
import {
  ACCOUNT_PLANS,
  CONTACT_REQUIRED_MESSAGE,
  MAX_LIVE_KEYS_PER_ACCOUNT,
  resolveKeyState,
  type AccountPlan,
  type ApiKeyAdminStore,
  type ApiKeyRecord,
} from './apiKeyStore.js';
import { collectAccountContacts, type ContactSet } from './accountContacts.js';
import { KEY_ENVIRONMENTS, type KeyEnvironment } from './keyFormat.js';
import { openApiKeyAdminStore, resolveApiKeysDbPath } from './sqliteApiKeyStore.js';

/**
 * `npm run keys -- <command>` — issue, list, rotate and revoke `/v1` API keys.
 *
 * Key issuance is an **operator action, not an endpoint**. There is no
 * `POST /v1/keys`, and that is a decision rather than an omission: a
 * self-service signup flow needs an account model, an identity provider, email
 * verification and a payment relationship, none of which exist and all of which
 * are commercial decisions that are not this agent's to make. Until they do,
 * the honest mechanism is a human running a command. It also keeps the public
 * process free of any write path to the key store — the CLI holds the only
 * read-write handle, and `publicIndex.ts` opens the same file readonly.
 *
 * The raw key is printed **once**, here, and is not recoverable afterwards
 * (`sqliteApiKeyStore.ts` stores `sha256(secret)` and the non-secret prefix).
 * Every listing command prints prefixes and never a key.
 *
 * ```
 * cd server
 * npm run keys -- accounts:create --name "Acme Energy" --plan developer
 * npm run keys -- keys:issue --account acct_… --label "prod ETL"
 * npm run keys -- keys:list --account acct_…
 * npm run keys -- keys:rotate --key key_… --overlap-days 7
 * npm run keys -- keys:revoke --key key_… --reason "leaked in a support ticket"
 * ```
 */

interface ParsedArgs {
  command: string;
  flags: Record<string, string | true>;
}

/**
 * `--name value` / `--flag`, and nothing cleverer.
 *
 * Hand-rolled because the server has five runtime dependencies and an argument
 * parser would be a sixth (`publicAppGraph.test.ts` treats a new package on
 * this surface as a decision, not a side effect). The grammar is small enough
 * that the parser is shorter than the argument for adding one.
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

function optionalNumber(flags: ParsedArgs['flags'], name: string, fallback: number): number {
  const value = flags[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new UsageError(`--${name} must be a non-negative number.`);
  }
  return parsed;
}

function requirePlan(flags: ParsedArgs['flags']): AccountPlan {
  const plan = requireString(flags, 'plan');
  if (!(ACCOUNT_PLANS as readonly string[]).includes(plan)) {
    throw new UsageError(`--plan must be one of: ${ACCOUNT_PLANS.join(', ')}.`);
  }
  return plan as AccountPlan;
}

function optionalEnvironment(flags: ParsedArgs['flags']): KeyEnvironment {
  const value = flags.env;
  if (value === undefined) return 'live';
  if (typeof value !== 'string' || !(KEY_ENVIRONMENTS as readonly string[]).includes(value)) {
    throw new UsageError(`--env must be one of: ${KEY_ENVIRONMENTS.join(', ')}.`);
  }
  return value as KeyEnvironment;
}

/**
 * The account contact, as a flag.
 *
 * Required on `keys:issue` and refused with {@link CONTACT_REQUIRED_MESSAGE}
 * rather than with `requireString`'s generic "--contact is required": an
 * operator who is told a flag is missing adds a flag, and an operator who is
 * told what §9.3 promises knows which address to put in it. That is the
 * `scripts/backfillModelGuard.ts` shape — a refusal that argues for itself.
 */
function requireContactFlag(flags: ParsedArgs['flags']): string {
  const value = flags.contact;
  if (typeof value !== 'string' || value.trim() === '') throw new UsageError(CONTACT_REQUIRED_MESSAGE);
  return value.trim();
}

function optionalContactFlag(flags: ParsedArgs['flags']): string | undefined {
  const value = flags.contact;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * One key as a listing row. Never includes a secret — there is nothing stored
 * that could.
 *
 * The contact is shown, and `none` is printed rather than omitted. A missing
 * field reads as a field that does not apply; the word is what makes an
 * un-notifiable subscriber visible in the listing an operator already runs,
 * instead of only in `keys:contacts`.
 */
export function describeKey(key: ApiKeyRecord, now: Date): string {
  const state = resolveKeyState(key, now);
  const until = key.expiresAt ? ` expires=${key.expiresAt}` : '';
  const reason = key.revokedReason ? ` reason="${key.revokedReason}"` : '';
  return `${key.id}  ${key.environment}  prefix=${key.prefix}  ${state.padEnd(7)}  contact=${
    key.contactEmail ?? 'none'
  }  ${key.label}${until}${reason}`;
}

/**
 * The §9.3 recipient list, rendered.
 *
 * Both halves always print, including "every live key has a contact" when the
 * unreachable list is empty. A report that goes quiet when there is nothing
 * wrong is indistinguishable from one that has stopped checking, and this is the
 * output somebody will read once, in a hurry, on the day a model changes.
 */
export function describeContactSet(set: ContactSet): string[] {
  const lines: string[] = [];

  if (set.liveKeys === 0) {
    lines.push('No live keys, so there is nobody to notify under ToS §9.3.');
    return lines;
  }

  lines.push(
    `${set.recipients.length} contact${set.recipients.length === 1 ? '' : 's'} for ${
      set.liveKeys
    } live key${set.liveKeys === 1 ? '' : 's'}:`
  );
  for (const r of set.recipients) {
    lines.push(`  ${r.email.padEnd(34)}  keys=${r.keyIds.length}  ${r.accountIds.join(' ')}`);
  }

  if (set.unreachable.length === 0) {
    lines.push('');
    lines.push('Every live key has a contact.');
    return lines;
  }

  lines.push('');
  lines.push(
    `${set.unreachable.length} live key${
      set.unreachable.length === 1 ? '' : 's'
    } cannot be reached — no contact was recorded:`
  );
  for (const u of set.unreachable) lines.push(`  ${u.keyId}  ${u.accountId}  "${u.label}"`);
  lines.push('');
  lines.push(
    'These predate the contact field. ToS §9.3 promises them notice of a material model change ' +
      'and we have no address, so they are listed rather than counted as nobody. Give each one ' +
      'an address by rotating it: keys:rotate --key <key_...> --contact <email>.'
  );

  return lines;
}

const USAGE = `
Manage /v1 API keys. Reads API_KEYS_DB_PATH (its own SQLite file, never the energy database).

  accounts:create   --name <name> --plan <${ACCOUNT_PLANS.join('|')}>
  accounts:list
  accounts:disable  --account <acct_...>
  accounts:enable   --account <acct_...>

  keys:issue        --account <acct_...> --label <label> --contact <email> [--env live|test] [--expires-in-days N]
  keys:list         [--account <acct_...>]
  keys:contacts
  keys:rotate       --key <key_...> [--overlap-days N] [--label <label>] [--contact <email>]
  keys:revoke       --key <key_...> [--reason <text>]

A key is printed once, at issue or rotate. Nothing can print it again: the store holds
sha256(secret) and the non-secret prefix, so a lost key is rotated, never recovered.
Accounts hold at most ${MAX_LIVE_KEYS_PER_ACCOUNT} live keys; a rotation with an overlap
window counts both while they overlap.

--contact is the account contact ToS §9.3 promises to notify of a material model change,
and issuing without one is refused. A rotation carries the old key's contact forward, so
--contact is needed there only to change it, or to give one to a key that predates the
field. keys:contacts prints the recipient list and every live key that has no address.
`.trim();

/**
 * The key banner.
 *
 * Loud, and framed, because the one-shot property has to survive somebody
 * skimming a terminal. The failure this guards against is a customer being told
 * "it's in the output somewhere" a week later, when it is not and cannot be.
 */
function printIssuedKey(key: string, record: ApiKeyRecord): void {
  console.log(`
  ┌─────────────────────────────────────────────────────────────────────
  │ Copy this key now. It is shown once and cannot be recovered.
  ├─────────────────────────────────────────────────────────────────────
  │ ${key}
  └─────────────────────────────────────────────────────────────────────

  key id : ${record.id}
  account: ${record.accountId}
  prefix : ${record.prefix}   <- the non-secret handle; use this in tickets and logs
  label  : ${record.label}
  contact: ${record.contactEmail}   <- where a ToS §9.3 model-change notice goes
  expires: ${record.expiresAt ?? 'never'}

  Send it as:  Authorization: Bearer <the key above>
`);
}

export function runCommand(store: ApiKeyAdminStore, { command, flags }: ParsedArgs): void {
  const now = new Date();

  switch (command) {
    case 'accounts:create': {
      const account = store.createAccount({ name: requireString(flags, 'name'), plan: requirePlan(flags) });
      console.log(`created ${account.id}  plan=${account.plan}  name="${account.name}"`);
      return;
    }

    case 'accounts:list': {
      const accounts = store.listAccounts();
      if (accounts.length === 0) {
        console.log('No accounts yet. Create one with accounts:create.');
        return;
      }
      for (const a of accounts) {
        const live = store.listKeys(a.id).filter((k) => resolveKeyState(k, now) === 'active').length;
        const state = a.disabledAt ? `disabled ${a.disabledAt}` : 'active';
        console.log(`${a.id}  ${a.plan.padEnd(12)}  ${state.padEnd(30)}  keys=${live}  "${a.name}"`);
      }
      return;
    }

    case 'accounts:disable':
    case 'accounts:enable': {
      const disable = command === 'accounts:disable';
      const account = store.setAccountDisabled(requireString(flags, 'account'), disable);
      console.log(`${account.id} is now ${account.disabledAt ? 'disabled' : 'active'}`);
      // Worth saying out loud: this is not revocation. The keys stay valid
      // records and start working again the moment the account is re-enabled,
      // which is what makes it the right lever for non-payment.
      if (disable) console.log('Keys are unchanged; every request from them now answers 403 account_disabled.');
      return;
    }

    case 'keys:issue': {
      const days = optionalNumber(flags, 'expires-in-days', 0);
      const { record, key } = store.issueKey({
        accountId: requireString(flags, 'account'),
        label: requireString(flags, 'label'),
        contactEmail: requireContactFlag(flags),
        environment: optionalEnvironment(flags),
        expiresAt: days > 0 ? new Date(now.getTime() + days * 86_400_000).toISOString() : null,
      });
      printIssuedKey(key, record);
      return;
    }

    case 'keys:list': {
      const accountId = typeof flags.account === 'string' ? flags.account : undefined;
      const keys = store.listKeys(accountId);
      if (keys.length === 0) {
        console.log(accountId ? `No keys for ${accountId}.` : 'No keys yet.');
        return;
      }
      for (const key of keys) console.log(describeKey(key, now));
      return;
    }

    case 'keys:contacts': {
      // Reads every key and filters to live ones in `collectAccountContacts`
      // rather than asking the store for a filtered list: the "live" rule is
      // `resolveKeyState`, and a second copy of it in SQL is a second copy to
      // keep true.
      for (const line of describeContactSet(collectAccountContacts(store.listKeys(), now))) {
        console.log(line);
      }
      return;
    }

    case 'keys:rotate': {
      const overlapDays = optionalNumber(flags, 'overlap-days', 7);
      const { issued, retired } = store.rotateKey({
        keyId: requireString(flags, 'key'),
        label: typeof flags.label === 'string' ? flags.label : undefined,
        contactEmail: optionalContactFlag(flags),
        overlapDays,
      });
      console.log(
        overlapDays > 0
          ? `retired ${retired.id} (prefix=${retired.prefix}) — stops working at ${retired.expiresAt}`
          : `revoked ${retired.id} (prefix=${retired.prefix}) — it stopped working now`
      );
      printIssuedKey(issued.key, issued.record);
      return;
    }

    case 'keys:revoke': {
      const key = store.revokeKey(
        requireString(flags, 'key'),
        typeof flags.reason === 'string' ? flags.reason : null
      );
      console.log(`revoked ${key.id} (prefix=${key.prefix}) at ${key.revokedAt}`);
      console.log('The row is kept, not deleted: usage history has to keep pointing at a real key.');
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
 * Entry point, run only when this module is the process's main script.
 *
 * The guard keeps the module importable by `keysCli.test.ts`, which drives
 * {@link runCommand} against a real store on a temp file and would otherwise
 * find the CLI trying to open `API_KEYS_DB_PATH` and calling `process.exit` at
 * import time.
 */
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  let store: ApiKeyAdminStore | undefined;
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.command === '' || parsed.command === 'help' || parsed.command === '--help') {
      console.log(USAGE);
      process.exit(0);
    }
    console.log(`key store: ${resolveApiKeysDbPath()}`);
    store = openApiKeyAdminStore();
    runCommand(store, parsed);
  } catch (err) {
    // A usage mistake gets the usage text; anything else gets its message. No
    // stack either way — this is an operator tool, and a stack trace on
    // "--plan is required" trains people to stop reading the output.
    console.error(`\n${(err as Error).message}\n`);
    if (err instanceof UsageError) console.error(USAGE);
    process.exitCode = 1;
  } finally {
    store?.close();
  }
}
