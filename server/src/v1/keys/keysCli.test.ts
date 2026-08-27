import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, runCommand, describeKey } from './keysCli.js';
import { openApiKeyAdminStore } from './sqliteApiKeyStore.js';
import { parseApiKey } from './keyFormat.js';
import type { ApiKeyAdminStore } from './apiKeyStore.js';

/**
 * The operator tool.
 *
 * Two things are worth testing here and the rest is plumbing: that the raw key
 * is printed exactly once and by no other command, and that every *listing*
 * command is incapable of printing one. The second is the property that decays
 * — somebody adds a debug field to a listing, and a year later keys are in a
 * terminal scrollback and a CI log.
 *
 * `runCommand` is exported and driven directly against a real store on a temp
 * file; the module's `isMain` guard is what keeps importing it here from trying
 * to open `API_KEYS_DB_PATH` and calling `process.exit`.
 */

const tmpRoots: string[] = [];

/** The ToS §9.3 account contact every issued key needs (ABL-528). */
const TEST_CONTACT = 'ops@acme.example';

let store: ApiKeyAdminStore;
let dbPath: string;
let accountId: string;
let out: string[];

/**
 * Blank a key's contact, the way a row written before the column existed
 * arrives (ABL-528).
 *
 * A second connection to the same file rather than a store method, deliberately:
 * there is no supported way to produce this state, because every write path
 * refuses to leave the column empty. That is the property under test, so the
 * fixture has to reach around it.
 */
function clearContact(keyId: string): void {
  const db = new Database(dbPath);
  db.prepare('UPDATE api_keys SET contact_email = NULL WHERE id = ?').run(keyId);
  db.close();
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'able-keyscli-'));
  tmpRoots.push(root);
  dbPath = path.join(root, 'api_keys.db');
  store = openApiKeyAdminStore({ API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv);
  accountId = store.createAccount({ name: 'Acme Energy', plan: 'developer' }).id;

  out = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => void out.push(args.join(' ')));
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    store.close();
  } catch {
    // Already closed.
  }
});

afterAll(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

const run = (argv: string[]) => runCommand(store, parseArgs(argv));
const printed = () => out.join('\n');

describe('parseArgs', () => {
  it('reads a command and its flags', () => {
    expect(parseArgs(['keys:issue', '--account', 'acct_1', '--label', 'prod ETL'])).toEqual({
      command: 'keys:issue',
      flags: { account: 'acct_1', label: 'prod ETL' },
    });
  });

  it('treats a flag with no value as a boolean', () => {
    expect(parseArgs(['keys:list', '--verbose']).flags).toEqual({ verbose: true });
  });

  it('does not swallow the next flag as a value', () => {
    expect(parseArgs(['x', '--a', '--b', 'v']).flags).toEqual({ a: true, b: 'v' });
  });

  it('survives no arguments at all', () => {
    expect(parseArgs([])).toEqual({ command: '', flags: {} });
  });
});

describe('keys:issue', () => {
  it('prints the key once, with the warning that it cannot be recovered', () => {
    run(['keys:issue', '--account', accountId, '--contact', TEST_CONTACT, '--label', 'prod ETL']);

    const key = store.listKeys(accountId)[0];
    const text = printed();

    expect(text).toContain('shown once and cannot be recovered');
    expect(text).toContain(key.prefix);
    expect(text).toContain(key.id);

    // Exactly one full key in the output. A banner that printed it twice would
    // be harmless; one that printed it in a place a script pipes elsewhere
    // would not, and counting is how that stays true.
    const found = text.match(/able_live_[0-9A-Za-z]{8}_[0-9A-Za-z]{43}/g) ?? [];
    expect(found).toHaveLength(1);
    expect(parseApiKey(found[0]!)?.prefix).toBe(key.prefix);
  });

  it('defaults to the live environment and no expiry', () => {
    run(['keys:issue', '--account', accountId, '--contact', TEST_CONTACT, '--label', 'k']);
    const key = store.listKeys(accountId)[0];

    expect(key.environment).toBe('live');
    expect(key.expiresAt).toBeNull();
    expect(printed()).toContain('expires: never');
  });

  it('accepts --env test', () => {
    run(['keys:issue', '--account', accountId, '--contact', TEST_CONTACT, '--label', 'k', '--env', 'test']);
    expect(store.listKeys(accountId)[0].environment).toBe('test');
    expect(printed()).toContain('able_test_');
  });

  it('sets a deadline from --expires-in-days', () => {
    run(['keys:issue', '--account', accountId, '--contact', TEST_CONTACT, '--label', 'k', '--expires-in-days', '30']);
    const expiresAt = store.listKeys(accountId)[0].expiresAt as string;

    const days = (Date.parse(expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it.each([
    { why: 'no account', argv: ['keys:issue', '--label', 'k'], match: /--account is required/ },
    { why: 'no label', argv: ['keys:issue', '--account', 'acct_1'], match: /--label is required/ },
    {
      why: 'an unknown environment',
      argv: ['keys:issue', '--account', 'acct_1', '--contact', TEST_CONTACT, '--label', 'k', '--env', 'staging'],
      match: /--env must be one of/,
    },
    {
      why: 'a negative expiry',
      argv: ['keys:issue', '--account', 'acct_1', '--contact', TEST_CONTACT, '--label', 'k', '--expires-in-days', '-3'],
      match: /non-negative/,
    },
  ])('refuses $why', ({ argv, match }) => {
    expect(() => run(argv)).toThrow(match);
  });

  it('surfaces the cap as a sentence rather than a constraint violation', () => {
    for (let i = 0; i < 5; i += 1) run(['keys:issue', '--account', accountId, '--contact', TEST_CONTACT, '--label', `k${i}`]);
    expect(() => run(['keys:issue', '--account', accountId, '--contact', TEST_CONTACT, '--label', 'sixth'])).toThrow(
      /maximum is 5.*Revoke one/s
    );
  });
});

describe('listing never prints a key', () => {
  it('keys:list shows prefixes, ids and state only', () => {
    run(['keys:issue', '--account', accountId, '--contact', TEST_CONTACT, '--label', 'prod ETL']);
    const issuedOutput = printed();
    const key = store.listKeys(accountId)[0];

    out = [];
    run(['keys:list', '--account', accountId]);
    const listing = printed();

    expect(listing).toContain(key.prefix);
    expect(listing).toContain(key.id);
    expect(listing).toContain('active');
    // The key was in the issue output; it must not be in the listing.
    const issued = (issuedOutput.match(/able_live_[0-9A-Za-z]{8}_[0-9A-Za-z]{43}/) ?? [])[0];
    expect(listing).not.toContain(issued);
    expect(listing).not.toMatch(/able_(live|test)_[0-9A-Za-z]{8}_[0-9A-Za-z]{43}/);
  });

  it('shows revoked and expired state, and the revocation reason', () => {
    const { record } = store.issueKey({ accountId, label: 'k', contactEmail: TEST_CONTACT, environment: 'live' });
    store.revokeKey(record.id, 'leaked');

    run(['keys:list']);
    expect(printed()).toContain('revoked');
    expect(printed()).toContain('reason="leaked"');
  });

  it('accounts:list counts live keys without naming one', () => {
    store.issueKey({ accountId, label: 'a', contactEmail: TEST_CONTACT, environment: 'live' });
    const { record } = store.issueKey({ accountId, label: 'b', contactEmail: TEST_CONTACT, environment: 'live' });
    store.revokeKey(record.id, null);

    run(['accounts:list']);
    const text = printed();

    expect(text).toContain(accountId);
    expect(text).toContain('keys=1');
    expect(text).toContain('developer');
    expect(text).not.toMatch(/able_(live|test)_/);
  });

  it('says so plainly when there is nothing to list', () => {
    run(['keys:list']);
    expect(printed()).toContain('No keys yet.');
    out = [];
    run(['accounts:list']);
    expect(printed()).toContain(accountId);
  });
});

describe('describeKey', () => {
  it('renders a row with no secret in it', () => {
    const { key, record } = store.issueKey({ accountId, label: 'prod', contactEmail: TEST_CONTACT, environment: 'live' });
    const row = describeKey(record, new Date());

    expect(row).toContain(record.prefix);
    expect(row).toContain('active');
    expect(row).not.toContain(key);
    expect(row).not.toContain(parseApiKey(key)?.secret as string);
    expect(row).not.toContain(record.secretSha256);
  });

  it('reports the state the clock implies', () => {
    const { record } = store.issueKey({
      accountId,
      label: 'k',
      contactEmail: TEST_CONTACT,
      environment: 'live',
      expiresAt: '2026-03-01T00:00:00.000Z',
    });

    expect(describeKey(record, new Date('2026-02-01T00:00:00.000Z'))).toContain('active');
    expect(describeKey(record, new Date('2026-04-01T00:00:00.000Z'))).toContain('expired');
  });
});

describe('keys:rotate', () => {
  it('prints the new key and reports when the old one stops', () => {
    const { record } = store.issueKey({ accountId, label: 'grafana', contactEmail: TEST_CONTACT, environment: 'live' });

    run(['keys:rotate', '--key', record.id, '--overlap-days', '7']);
    const text = printed();

    expect(text).toContain(`retired ${record.id}`);
    expect(text).toContain('stops working at');
    expect(text).toContain('shown once and cannot be recovered');
    expect(store.getKey(record.id)?.expiresAt).not.toBeNull();
  });

  it('defaults to a seven-day overlap, so a rotation is not an outage', () => {
    const { record } = store.issueKey({ accountId, label: 'k', contactEmail: TEST_CONTACT, environment: 'live' });
    run(['keys:rotate', '--key', record.id]);

    const days = (Date.parse(store.getKey(record.id)?.expiresAt as string) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it('revokes immediately at --overlap-days 0', () => {
    const { record } = store.issueKey({ accountId, label: 'k', contactEmail: TEST_CONTACT, environment: 'live' });
    run(['keys:rotate', '--key', record.id, '--overlap-days', '0']);

    expect(printed()).toContain('it stopped working now');
    expect(store.getKey(record.id)?.revokedAt).not.toBeNull();
  });
});

describe('keys:revoke', () => {
  it('records the reason and says the row is kept', () => {
    const { record } = store.issueKey({ accountId, label: 'k', contactEmail: TEST_CONTACT, environment: 'live' });
    run(['keys:revoke', '--key', record.id, '--reason', 'leaked in a support ticket']);

    expect(store.getKey(record.id)?.revokedReason).toBe('leaked in a support ticket');
    expect(printed()).toContain('The row is kept, not deleted');
  });

  it('works with no reason given', () => {
    const { record } = store.issueKey({ accountId, label: 'k', contactEmail: TEST_CONTACT, environment: 'live' });
    run(['keys:revoke', '--key', record.id]);
    expect(store.getKey(record.id)?.revokedAt).not.toBeNull();
  });
});

describe('accounts', () => {
  it('creates one and validates the plan against the ABL-291 tier table', () => {
    run(['accounts:create', '--name', 'Beta Energy', '--plan', 'professional']);
    expect(printed()).toContain('plan=professional');

    expect(() => run(['accounts:create', '--name', 'X', '--plan', 'platinum'])).toThrow(
      /--plan must be one of/
    );
  });

  it('disables and re-enables, and explains that keys are untouched', () => {
    run(['accounts:disable', '--account', accountId]);
    expect(printed()).toContain('403 account_disabled');
    expect(store.getAccount(accountId)?.disabledAt).not.toBeNull();

    out = [];
    run(['accounts:enable', '--account', accountId]);
    expect(printed()).toContain('is now active');
    expect(store.getAccount(accountId)?.disabledAt).toBeNull();
  });
});

describe('help', () => {
  it.each(['', 'help', '--help'])('prints usage for %s', (command) => {
    run([command].filter((c) => c !== ''));
    expect(printed()).toContain('accounts:create');
    expect(printed()).toContain('keys:rotate');
    // The usage text is where an operator learns the one-shot property.
    expect(printed()).toContain('printed once');
  });

  it('refuses an unknown command', () => {
    expect(() => run(['keys:delete'])).toThrow(/Unknown command/);
  });
});

/**
 * The ToS §9.3 account contact (ABL-528).
 *
 * §9.3 commits us to publishing a material model change through the changelog
 * **and to the account contact**. The operator tool is where that address is
 * created, so it is where the promise is either kept or quietly broken.
 */
describe('the account contact', () => {
  it('refuses to issue without one, and says what §9.3 promises', () => {
    // Not `--contact is required`. An operator told a flag is missing adds a
    // flag; an operator told what the refusal is protecting knows which address
    // belongs in it. Same shape as scripts/backfillModelGuard.ts.
    expect(() => run(['keys:issue', '--account', accountId, '--label', 'prod ETL'])).toThrow(
      /§9\.3/
    );
    expect(() => run(['keys:issue', '--account', accountId, '--label', 'prod ETL'])).toThrow(
      /promised to notify and cannot reach/
    );
    expect(store.listKeys()).toEqual([]);
  });

  it('refuses a value that is not an address', () => {
    expect(() =>
      run(['keys:issue', '--account', accountId, '--contact', accountId, '--label', 'k'])
    ).toThrow(/does not look like an email address/);
  });

  it('prints the contact in the issue banner, next to what it is for', () => {
    run(['keys:issue', '--account', accountId, '--contact', TEST_CONTACT, '--label', 'prod ETL']);
    expect(printed()).toContain(`contact: ${TEST_CONTACT}`);
    expect(printed()).toContain('§9.3');
  });

  it('shows the contact in keys:list, and says "none" rather than leaving a gap', () => {
    // A missing field reads as one that does not apply. The word is what makes
    // an un-notifiable subscriber visible in the listing an operator already
    // runs, rather than only in keys:contacts.
    run(['keys:issue', '--account', accountId, '--contact', TEST_CONTACT, '--label', 'prod ETL']);
    out = [];
    run(['keys:list']);
    expect(printed()).toContain(`contact=${TEST_CONTACT}`);

    expect(describeKey({ ...store.listKeys()[0], contactEmail: null }, new Date())).toContain(
      'contact=none'
    );
  });

  it('carries the contact through a rotation without being told again', () => {
    run(['keys:issue', '--account', accountId, '--contact', TEST_CONTACT, '--label', 'grafana']);
    const original = store.listKeys()[0];

    out = [];
    run(['keys:rotate', '--key', original.id, '--overlap-days', '7']);
    expect(printed()).toContain(`contact: ${TEST_CONTACT}`);
  });

  it('changes the contact when --contact is given to a rotation', () => {
    run(['keys:issue', '--account', accountId, '--contact', TEST_CONTACT, '--label', 'grafana']);
    const original = store.listKeys()[0];

    out = [];
    run(['keys:rotate', '--key', original.id, '--contact', 'newops@acme.example']);
    expect(printed()).toContain('contact: newops@acme.example');
  });
});

describe('keys:contacts', () => {
  it('lists each address once, with the keys behind it', () => {
    run(['keys:issue', '--account', accountId, '--contact', TEST_CONTACT, '--label', 'a']);
    run(['keys:issue', '--account', accountId, '--contact', TEST_CONTACT, '--label', 'b']);
    const other = store.createAccount({ name: 'Beta', plan: 'explorer' }).id;
    run(['keys:issue', '--account', other, '--contact', 'data@beta.example', '--label', 'c']);

    out = [];
    run(['keys:contacts']);
    const text = printed();

    expect(text).toContain('2 contacts for 3 live keys');
    expect(text).toContain(TEST_CONTACT);
    expect(text).toContain('data@beta.example');
    expect(text).toContain('keys=2');
    // And it stays a listing command: no key may appear here either.
    expect(text).not.toMatch(/able_(live|test)_[0-9A-Za-z]{8}_[0-9A-Za-z]{43}/);
  });

  it('states that every live key has a contact rather than going quiet', () => {
    // A report that says nothing when nothing is wrong is indistinguishable
    // from one that has stopped checking, and this is the output somebody reads
    // once, in a hurry, on the day a model changes.
    run(['keys:issue', '--account', accountId, '--contact', TEST_CONTACT, '--label', 'a']);
    out = [];
    run(['keys:contacts']);

    expect(printed()).toContain('Every live key has a contact.');
  });

  it('names a key it cannot reach, and how to give it an address', () => {
    // The pre-ABL-528 row, reached the only way the current write path allows:
    // straight into the column the store deliberately leaves nullable.
    run(['keys:issue', '--account', accountId, '--contact', TEST_CONTACT, '--label', 'reachable']);
    const orphan = store.issueKey({
      accountId,
      label: 'predates the field',
      contactEmail: TEST_CONTACT,
      environment: 'live',
    }).record;
    clearContact(orphan.id);

    out = [];
    run(['keys:contacts']);
    const text = printed();

    expect(text).toContain('1 live key cannot be reached');
    expect(text).toContain(orphan.id);
    expect(text).toContain('predates the field');
    expect(text).toContain('§9.3');
    expect(text).toContain('keys:rotate --key <key_...> --contact <email>');
    // Never counted as nobody: the reachable one is still reported beside it.
    expect(text).toContain('1 contact for 2 live keys');
  });

  it('says there is nobody to notify when there are no live keys', () => {
    run(['keys:contacts']);
    expect(printed()).toContain('nobody to notify');
  });
});
