import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openApiKeyAdminStore } from '../keys/sqliteApiKeyStore.js';
import { openUsageStore } from './sqliteUsageStore.js';
import { describeRollup, parseArgs, requireYearMonth, runCommand } from './usageCli.js';
import { requestFingerprint, type UsageAdminStore, type UsageEvent } from './usageStore.js';

/**
 * The operator tool, driven against a real store on a temp file.
 *
 * The case this file exists for is `usage:month after every event was deleted`.
 * It is the ABL-297 §9(2) commitment expressed at the only layer a human
 * touches: a billing dispute eight months on is answered by running this
 * command, and if it recomputed from raw events it would answer zero — having
 * worked perfectly for the first twelve months.
 */

const tmpRoots: string[] = [];

function tmpDbPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'able-usage-cli-'));
  tmpRoots.push(root);
  return path.join(root, 'api_keys.db');
}

afterAll(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

let dbPath: string;
let store: UsageAdminStore;
let accountId: string;
let keyId: string;
let sequence = 0;
let out: string[];

const log = (line: string) => out.push(line);
const printed = () => out.join('\n');

beforeEach(() => {
  sequence = 0;
  out = [];
  dbPath = tmpDbPath();

  const keys = openApiKeyAdminStore({ API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv);
  accountId = keys.createAccount({ name: 'Acme Energy', plan: 'developer' }).id;
  keyId = keys.issueKey({ accountId, label: 'prod ETL', contactEmail: 'ops@acme.example', environment: 'live' }).record.id;
  keys.close();

  store = openUsageStore({
    env: { API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv,
    policy: { piiDays: 90, eventMonths: 13, monthCloseGraceDays: 2 },
  });
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // Some cases close it themselves.
  }
});

const ROUTE = '/v1/observations/:series';

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  sequence += 1;
  return {
    requestId: `req_${sequence}`,
    receivedAt: '2026-07-15T12:00:00.000Z',
    accountId,
    keyId,
    method: 'GET',
    routeTemplate: ROUTE,
    queryParams: 'country=BE',
    status: 200,
    rowCount: 10,
    responseBytes: 1_000,
    durationMs: 5,
    billable: true,
    idempotencyKey: null,
    fingerprint: requestFingerprint('GET', ROUTE, 'country=BE'),
    clientIp: '192.0.2.10',
    userAgent: 'able-sdk/1.0',
    ...overrides,
  };
}

function run(argv: string[], now = new Date('2026-08-15T00:00:00Z')): void {
  runCommand(store, parseArgs(argv), now, log);
}

describe('parseArgs and validation', () => {
  it('reads --flag value and bare --flag', () => {
    expect(parseArgs(['usage:month', '--month', '2026-07', '--verbose'])).toEqual({
      command: 'usage:month',
      flags: { month: '2026-07', verbose: true },
    });
  });

  it('refuses a month that is not YYYY-MM, because a typo silently reports nothing', () => {
    expect(() => requireYearMonth({ month: '2026-7' })).toThrow(/YYYY-MM/);
    expect(() => requireYearMonth({ month: '2026-13' })).toThrow(/YYYY-MM/);
    expect(() => requireYearMonth({ month: 'July' })).toThrow(/YYYY-MM/);
    expect(requireYearMonth({ month: '2026-07' })).toBe('2026-07');
  });

  it('refuses an unknown command rather than doing nothing quietly', () => {
    expect(() => run(['usage:delete-everything'])).toThrow(/Unknown command/);
  });

  it('prints usage for help', () => {
    run(['help']);
    expect(printed()).toContain('usage:month');
    expect(printed()).toContain('usage:export');
  });
});

describe('usage:month — the number an invoice is raised on', () => {
  it('reports the billable figure separately from what was served', () => {
    store.writeEvents([event(), event(), event({ status: 404, billable: false })]);
    store.rollUp();

    run(['usage:month', '--month', '2026-07']);

    expect(printed()).toContain('billable=        2');
    expect(printed()).toContain('requests=        3');
    expect(printed()).toContain('2 billable of 3 requests');
  });

  it('warns that an open month can still change', () => {
    store.writeEvents([event()]);
    store.rollUp();

    run(['usage:month', '--month', '2026-07']);

    // Invoicing from an open month is how a customer gets two different answers
    // to the same question a day apart.
    expect(printed()).toMatch(/still open/);
  });

  it('does not warn once the month is closed', () => {
    store.writeEvents([event()]);
    store.rollUp();
    store.closeMonths(new Date('2026-08-15T00:00:00Z'));

    run(['usage:month', '--month', '2026-07']);

    expect(printed()).not.toMatch(/still open/);
    expect(printed()).toContain('closed 2026-08');
  });

  it('STILL REPORTS THE MONTH AFTER EVERY EVENT BEHIND IT WAS DELETED', () => {
    // The whole reason `usage_rollup` exists. A dispute arrives eight months
    // after the invoice; the raw rows are gone under the retention job we
    // published; the figure is still here and still defensible.
    store.writeEvents([event(), event(), event()]);
    store.rollUp();
    store.closeMonths(new Date('2026-08-15T00:00:00Z'));
    store.applyRetention(new Date('2027-11-01T00:00:00Z'));

    const db = new Database(dbPath, { readonly: true });
    expect((db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number }).n).toBe(0);
    db.close();

    run(['usage:month', '--month', '2026-07'], new Date('2027-11-01T00:00:00Z'));

    expect(printed()).toContain('3 billable of 3 requests');
  });

  it('filters to one account', () => {
    store.writeEvents([event(), event({ accountId: 'acct_other', requestId: 'req_other' })]);
    store.rollUp();

    run(['usage:month', '--month', '2026-07', '--account', 'acct_other']);

    expect(printed()).toContain('acct_other');
    expect(printed()).not.toContain(accountId);
  });

  it('says why an empty month might be empty rather than implying a zero invoice', () => {
    run(['usage:month', '--month', '2026-07']);

    expect(printed()).toContain('No usage recorded');
    // "No rows" has two very different causes, and an operator about to raise a
    // zero invoice needs to know which one they are looking at.
    expect(printed()).toMatch(/rollup may simply be behind/);
  });

  it('flags late requests on a closed month rather than hiding them', () => {
    store.writeEvents([event()]);
    store.rollUp();
    store.closeMonths(new Date('2026-08-15T00:00:00Z'));
    store.writeEvents([event({ requestId: 'req_late' })]);
    store.rollUp();

    run(['usage:month', '--month', '2026-07']);

    expect(printed()).toContain('NOT BILLED');
  });
});

describe('describeRollup', () => {
  it('shows billable before requests, because they are different numbers', () => {
    const line = describeRollup({
      accountId: 'acct_1',
      keyId: 'key_1',
      yearMonth: '2026-07',
      requests: 10,
      billableRequests: 8,
      rowsReturned: 100,
      responseBytes: 0,
      firstEventAt: '',
      lastEventAt: '',
      closedAt: null,
      lateRequests: 0,
      lateBillableRequests: 0,
    });

    expect(line.indexOf('billable=')).toBeLessThan(line.indexOf('requests='));
    expect(line).toContain('open');
  });
});

describe('the scheduled jobs, by hand', () => {
  it('rolls up and reports the watermark', () => {
    store.writeEvents([event(), event()]);

    run(['usage:roll-up']);

    expect(printed()).toContain('rolled 2 events');
    expect(printed()).toContain('watermark now 2');
  });

  it('refuses to close a month whose events are not aggregated, and says what to run', () => {
    store.writeEvents([event()]);
    store.rollUp();
    store.writeEvents([event()]);

    run(['usage:close-months']);

    expect(printed()).toContain('deferred 2026-07');
    expect(printed()).toContain('usage:roll-up');
  });

  it('applies retention and names the configured periods', () => {
    store.writeEvents([event({ receivedAt: '2026-01-01T00:00:00.000Z' })]);
    store.rollUp();

    run(['usage:retention'], new Date('2026-08-12T00:00:00Z'));

    expect(printed()).toContain('scrubbed 1 records');
    expect(printed()).toContain('90 days');
    expect(printed()).toContain('13 months');
  });

  it('reports rows kept back because the rollup has not caught up', () => {
    store.writeEvents([event({ receivedAt: '2025-01-01T00:00:00.000Z' })]);
    // No roll-up: the rollup has been broken for longer than the retention
    // window.
    run(['usage:retention'], new Date('2026-08-12T00:00:00Z'));

    expect(printed()).toContain('KEPT 1 records');
    expect(printed()).toMatch(/Fix the rollup/);
  });

  it('does the whole pass in one command', () => {
    store.writeEvents([event(), event()]);

    run(['usage:maintain']);

    expect(printed()).toContain('rolled 2 events');
    expect(printed()).toContain('closed 2026-07');
    expect(printed()).toContain('Done.');
  });
});

describe('usage:stats — the standing compliance check', () => {
  it('says OK when no record past the boundary holds personal data', () => {
    store.writeEvents([event({ receivedAt: '2026-08-01T00:00:00.000Z' })]);

    run(['usage:stats'], new Date('2026-08-12T00:00:00Z'));

    expect(printed()).toContain('Retention check: OK');
  });

  it('says NOT COMPLIANT when a record past 90 days still holds an IP', () => {
    store.writeEvents([event({ receivedAt: '2026-01-01T00:00:00.000Z' })]);

    run(['usage:stats'], new Date('2026-08-12T00:00:00Z'));

    // This is a published statement we would be demonstrably not meeting, so
    // the word is chosen to be the one somebody greps for.
    expect(printed()).toContain('NOT COMPLIANT');
    expect(printed()).toContain('usage:retention');
  });

  it('reports the rollup backlog', () => {
    store.writeEvents([event(), event(), event()]);

    run(['usage:stats'], new Date('2026-08-12T00:00:00Z'));

    expect(printed()).toContain('not yet rolled  3');
    expect(printed()).toMatch(/3 events are not in the rollup/);
  });
});

describe('usage:export — answering a subject access request', () => {
  it('writes every record tied to the account to a file', () => {
    store.writeEvents([event(), event()]);
    store.rollUp();
    const outPath = path.join(path.dirname(dbPath), 'export.json');

    run(['usage:export', '--account', accountId, '--out', outPath]);

    const exported = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown[]>;
    expect(exported.events).toHaveLength(2);
    expect(exported.rollups).toHaveLength(1);
    expect(exported.keys).toHaveLength(1);
    expect(printed()).toContain('wrote 2 request records');
  });

  it('warns that the file it just wrote contains personal data', () => {
    store.writeEvents([event()]);
    const outPath = path.join(path.dirname(dbPath), 'export.json');

    run(['usage:export', '--account', accountId, '--out', outPath]);

    // The file is about to be sent somewhere by whoever ran this, and it holds
    // IP addresses for the last 90 days.
    expect(printed()).toMatch(/personal data.*encrypted channel/s);
  });

  it('never writes a key secret hash into the export', () => {
    store.writeEvents([event()]);
    const outPath = path.join(path.dirname(dbPath), 'export.json');

    run(['usage:export', '--account', accountId, '--out', outPath]);

    expect(fs.readFileSync(outPath, 'utf8')).not.toContain('secret_sha256');
  });

  it('prints to stdout when no file is given', () => {
    store.writeEvents([event()]);

    run(['usage:export', '--account', accountId]);

    expect(JSON.parse(printed())).toMatchObject({ accountId });
  });

  it('requires an account', () => {
    expect(() => run(['usage:export'])).toThrow(/--account is required/);
  });
});
