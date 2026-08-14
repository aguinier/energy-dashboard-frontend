import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACCOUNT_PLANS } from '../keys/apiKeyStore.js';
import { openApiKeyAdminStore } from '../keys/sqliteApiKeyStore.js';
import { MONTHLY_PRICE_EUR, PLAN_LIMITS } from '../quota/planLimits.js';
import { openUsageStore } from '../usage/sqliteUsageStore.js';
import { requestFingerprint, type UsageEvent } from '../usage/usageStore.js';
import { parseArgs, runCommand } from './billingCli.js';
import type { BillingAdminStore } from './billingStore.js';
import { createLocalTestProvider } from './provider.js';
import { openBillingStore } from './sqliteBillingStore.js';
import { SUPPLIER_ENV } from './vat.js';
import { PRICE_BOOK_ENV } from './priceBook.js';

/**
 * **The ABL-307 acceptance bar, end to end on a real SQLite file:** metered
 * requests go in, a draft invoice comes out, and the reconciliation says the two
 * agree and names every reason they might not.
 *
 * Nothing here is mocked below the CLI. Requests are written through ABL-301's
 * real meter store, aggregated by its real rollup, closed by its real
 * month-close, and read back by billing exactly as an operator would — so what
 * this file demonstrates is the chain, not a set of agreeing fixtures.
 *
 * The three cases worth reading first:
 *
 * - *reconciles a clean month* — the happy path, and the one an invoice run is
 *   allowed to proceed on.
 * - *reports the rollup being behind rather than invoicing short* — the failure
 *   an operator will actually hit, because the rollup runs on a timer.
 * - *works with no price book at all* — because Board Decision 1 is open, and
 *   the request-count half of the reconciliation must not depend on a price
 *   nobody has approved.
 */

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'able-billing-cli-'));
  tmpRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

const YEAR_MONTH = '2026-07';
/** Past the two-day close grace period for July. */
const NOW = new Date('2026-08-05T09:00:00.000Z');
const ROUTE = '/v1/observations/:series';

let root: string;
let dbPath: string;
let priceBookPath: string;
let store: BillingAdminStore;
let accountId: string;
let keyId: string;
let env: NodeJS.ProcessEnv;
let out: string[];
let sequence = 0;

const log = (line: string) => out.push(line);
const printed = () => out.join('\n');
const provider = createLocalTestProvider();

/** A price book derived from what the gate enforces — see `priceBook.test.ts`. */
function writePriceBook(): string {
  const file = path.join(root, 'prices.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      currency: 'EUR',
      effectiveFrom: '2026-07-01',
      plans: Object.fromEntries(
        ACCOUNT_PLANS.map((plan) => {
          const limits = PLAN_LIMITS[plan];
          return [
            plan,
            {
              base: MONTHLY_PRICE_EUR[plan] ?? 0,
              includedRequests: limits.monthlyRequests,
              overagePerThousand:
                limits.overage.kind === 'soft' ? limits.overage.eurPer1000Requests : null,
            },
          ];
        })
      ),
    }),
    'utf8'
  );
  return file;
}

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  sequence += 1;
  const routeTemplate = overrides.routeTemplate ?? ROUTE;
  const status = overrides.status ?? 200;
  return {
    requestId: `req_${String(sequence).padStart(8, '0')}`,
    receivedAt: `${YEAR_MONTH}-14T10:00:00.000Z`,
    accountId,
    keyId,
    method: 'GET',
    routeTemplate,
    queryParams: 'country=DE',
    status,
    rowCount: 24,
    responseBytes: 2048,
    durationMs: 12,
    billable: status >= 200 && status < 300,
    idempotencyKey: null,
    fingerprint: requestFingerprint('GET', routeTemplate, 'country=DE'),
    clientIp: '192.168.86.10',
    userAgent: 'able-test/1.0',
    ...overrides,
  };
}

/** Meter `count` billable requests, then aggregate and close the month. */
function meter(count: number, options: { close?: boolean; rollUp?: boolean } = {}): void {
  const usage = openUsageStore({
    env,
    policy: { piiDays: 90, eventMonths: 13, monthCloseGraceDays: 2 },
  });
  try {
    usage.writeEvents(Array.from({ length: count }, () => event()));
    if (options.rollUp !== false) usage.rollUp();
    if (options.close !== false) usage.closeMonths(NOW);
  } finally {
    usage.close();
  }
}

function run(argv: string[]): void {
  runCommand({ store, provider, parsed: parseArgs(argv), env, now: NOW, log });
}

beforeEach(() => {
  sequence = 0;
  out = [];
  root = tmpRoot();
  dbPath = path.join(root, 'api_keys.db');

  const keys = openApiKeyAdminStore({ API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv);
  accountId = keys.createAccount({ name: 'Acme Energy', plan: 'developer' }).id;
  keyId = keys.issueKey({ accountId, label: 'prod ETL', environment: 'test' }).record.id;
  keys.close();

  // Opening the usage store applies ABL-301's schema, which billing requires
  // and deliberately does not create itself.
  openUsageStore({ env: { API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv }).close();

  priceBookPath = writePriceBook();
  env = {
    API_KEYS_DB_PATH: dbPath,
    [PRICE_BOOK_ENV]: priceBookPath,
    [SUPPLIER_ENV.country]: 'DE',
    [SUPPLIER_ENV.vatId]: 'DE999999999',
    [SUPPLIER_ENV.ossRegistered]: 'true',
  } as NodeJS.ProcessEnv;

  store = openBillingStore({ env });
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // Some cases close it themselves.
  }
});

/** Subscribe from 1 July and record a German business customer. */
function subscribeAndTax(): void {
  run([
    'billing:subscribe',
    '--account',
    accountId,
    '--plan',
    'developer',
    '--effective',
    `${YEAR_MONTH}-01T00:00:00.000Z`,
  ]);
  run(['billing:tax', '--account', accountId, '--country', 'DE', '--kind', 'consumer']);
  out = [];
}

describe('billing:price-book', () => {
  it('names the open Board decision when no book is configured', () => {
    delete env[PRICE_BOOK_ENV];
    run(['billing:price-book']);
    expect(printed()).toMatch(/Board Decision 1/);
    expect(printed()).toMatch(/not committed to this repository/);
    // And prints the shape, so the answer to "what do we send the Board" is in
    // the tool rather than in someone's head.
    expect(printed()).toMatch(/"effectiveFrom": "YYYY-MM-DD"/);
  });

  it('prints a configured book and confirms it agrees with what /v1 enforces', () => {
    run(['billing:price-book']);
    expect(printed()).toMatch(/developer/);
    expect(printed()).toMatch(/Checked against quota\/planLimits.ts/);
  });
});

describe('subscription state', () => {
  it('records a change without overwriting, and shows the history', () => {
    subscribeAndTax();
    run([
      'billing:status',
      '--account',
      accountId,
      '--status',
      'past_due',
      '--effective',
      '2026-07-20T00:00:00.000Z',
      '--reason',
      'card expired',
    ]);
    run(['billing:show', '--account', accountId, '--month', YEAR_MONTH]);

    expect(printed()).toMatch(/active → past_due/);
    expect(printed()).toMatch(/card expired/);
    // Two segments in July, and they are what the invoice prorates over.
    expect(printed()).toMatch(/2026-07-01T00:00:00.000Z → 2026-07-20T00:00:00.000Z/);
  });

  it('records a VAT number as unverified and says the reverse charge will not apply', () => {
    run(['billing:subscribe', '--account', accountId, '--plan', 'developer']);
    run([
      'billing:tax',
      '--account',
      accountId,
      '--country',
      'FR',
      '--kind',
      'business',
      '--vat-id',
      'FR12345678901',
    ]);

    expect(printed()).toMatch(/recorded UNVERIFIED/);
    expect(printed()).toMatch(/reverse charge will NOT be applied/);
  });

  it('links only test-mode provider handles', () => {
    subscribeAndTax();
    run(['billing:link', '--account', accountId]);

    expect(printed()).toMatch(/test_cus_/);
    expect(printed()).toMatch(/No network call was made/);
    expect(store.subscription(accountId, NOW)?.providerSubscriptionRef).toMatch(/^test_sub_/);
  });
});

describe('billing:invoice', () => {
  it('prices a closed month from the rollup and stamps it not-for-issue', () => {
    meter(1_500);
    subscribeAndTax();
    run(['billing:invoice', '--month', YEAR_MONTH, '--save']);

    expect(printed()).toMatch(/\[test\]/);
    expect(printed()).toMatch(/Developer plan — 2026-07/);
    // €49.00 net, 19% German VAT, €58.31 gross.
    expect(printed()).toMatch(/net 49\.00 {2}VAT 9\.31 .*gross 58\.31 EUR/);
    expect(printed()).toMatch(/metered 1,500 billable of 1,500 requests, included 50,000/);
    expect(printed()).toMatch(/None of these may be issued/);

    const stored = store.invoiceFor(accountId, YEAR_MONTH);
    expect(stored?.mode).toBe('test');
    expect(stored?.usage.billableRequests).toBe(1_500);
    expect(stored?.blockers).toEqual([]);
  });

  it('charges nothing for a 4xx, because a caller mistake is not billable', () => {
    // The meter records it and marks it non-billable; this asserts the invoice
    // reads the billable column and not the request count.
    const usage = openUsageStore({ env });
    usage.writeEvents([
      ...Array.from({ length: 10 }, () => event()),
      ...Array.from({ length: 5 }, () => event({ status: 400 })),
    ]);
    usage.rollUp();
    usage.closeMonths(NOW);
    usage.close();

    subscribeAndTax();
    run(['billing:invoice', '--month', YEAR_MONTH]);

    expect(printed()).toMatch(/metered 10 billable of 15 requests/);
  });

  it('skips an account with no tax profile rather than guessing a country', () => {
    meter(10);
    run(['billing:subscribe', '--account', accountId, '--plan', 'developer']);
    out = [];
    run(['billing:invoice', '--month', YEAR_MONTH]);

    expect(printed()).toMatch(/SKIPPED .*no tax profile recorded/);
  });

  it('blocks on an open month rather than pricing figures that can still change', () => {
    meter(100, { close: false });
    subscribeAndTax();
    run(['billing:invoice', '--month', YEAR_MONTH]);

    expect(printed()).toMatch(/BLOCKER: 2026-07 is not closed/);
    expect(printed()).toMatch(/1 with blockers/);
  });

  it('explains what is missing instead of failing when no price book is configured', () => {
    meter(10);
    subscribeAndTax();
    delete env[PRICE_BOOK_ENV];
    run(['billing:invoice', '--month', YEAR_MONTH]);

    expect(printed()).toMatch(/Cannot build an invoice yet/);
    expect(printed()).toMatch(/Board Decision 1/);
    expect(printed()).toMatch(/Metering, subscription state and the rollup all work without them/);
  });

  it('refuses to guess a supplier country', () => {
    meter(10);
    subscribeAndTax();
    delete env[SUPPLIER_ENV.country];
    run(['billing:invoice', '--month', YEAR_MONTH]);

    expect(printed()).toMatch(/no safe default/);
  });
});

describe('billing:reconcile — the acceptance bar', () => {
  it('reconciles a clean month and says every difference has a designed cause', () => {
    meter(1_500);
    subscribeAndTax();
    run(['billing:reconcile', '--month', YEAR_MONTH]);

    expect(printed()).toMatch(/usage_events {8}1,500 billable of 1,500 requests/);
    expect(printed()).toMatch(/usage_rollup {8}1,500 billable of 1,500 requests/);
    expect(printed()).toMatch(/invoiced {12}1,500 billable across 1 account\(s\), net 49\.00/);
    expect(printed()).toMatch(/No discrepancies/);
    expect(printed()).toMatch(/VERDICT: 2026-07 reconciles/);
  });

  it('always states the meter loss window, so "no discrepancies" is not over-read', () => {
    meter(10);
    subscribeAndTax();
    run(['billing:reconcile', '--month', YEAR_MONTH]);

    expect(printed()).toMatch(/meter loss window \(not measurable from the store\)/);
    expect(printed()).toMatch(/flushes every 1000ms/);
    expect(printed()).toMatch(/must not be read as "we billed for every request we served"/);
  });

  it('reports the rollup being behind rather than reconciling a short invoice', () => {
    // The failure an operator actually hits: the rollup runs on a timer, and a
    // month reconciled mid-flush is short by whatever has not been aggregated.
    meter(1_000);
    meter(250, { rollUp: false, close: false });
    subscribeAndTax();
    run(['billing:reconcile', '--month', YEAR_MONTH]);

    expect(printed()).toMatch(/\[BLOCKING\] unrolled/);
    expect(printed()).toMatch(/250 billable requests for 2026-07 are metered but not aggregated/);
    expect(printed()).toMatch(/VERDICT: 2026-07 DOES NOT reconcile/);
  });

  it('reports late traffic as an expected under-count, and still reconciles', () => {
    // Metered after the month closed: counted, never billed, and the direction
    // ABL-301 chose deliberately.
    meter(1_000);
    const usage = openUsageStore({ env });
    usage.writeEvents(Array.from({ length: 7 }, () => event({ requestId: `req_late_${sequence++}` })));
    usage.rollUp();
    usage.close();

    subscribeAndTax();
    run(['billing:reconcile', '--month', YEAR_MONTH]);

    expect(printed()).toMatch(/\[expected\] late/);
    expect(printed()).toMatch(/never invoiced, and this is the designed direction/);
    expect(printed()).toMatch(/VERDICT: 2026-07 reconciles/);
  });

  it('flags an account whose gated plan and billed plan have come apart', () => {
    // accounts.plan is `developer` (set at creation); bill it as professional.
    meter(10);
    run([
      'billing:subscribe',
      '--account',
      accountId,
      '--plan',
      'professional',
      '--effective',
      `${YEAR_MONTH}-01T00:00:00.000Z`,
    ]);
    run(['billing:tax', '--account', accountId, '--country', 'DE', '--kind', 'consumer']);
    out = [];
    run(['billing:reconcile', '--month', YEAR_MONTH]);

    expect(printed()).toMatch(/gated as developer .* and billed as professional/s);
    expect(printed()).toMatch(/VERDICT: 2026-07 DOES NOT reconcile/);
  });

  it('flags metered traffic on an account with no invoice', () => {
    meter(500);
    run(['billing:reconcile', '--month', YEAR_MONTH]);

    expect(printed()).toMatch(/has no invoice/);
    expect(printed()).toMatch(/VERDICT: 2026-07 DOES NOT reconcile/);
  });

  it('checks request counts with no price book at all', () => {
    // Board Decision 1 is open. The half of this check that matters — did every
    // metered request reach the aggregate — must not wait on a price.
    meter(1_500);
    subscribeAndTax();
    delete env[PRICE_BOOK_ENV];
    run(['billing:reconcile', '--month', YEAR_MONTH]);

    expect(printed()).toMatch(/usage_rollup {8}1,500 billable/);
    expect(printed()).toMatch(/no price book is configured/);
    expect(printed()).toMatch(/request figures — which are what this check is about — are unaffected/);
  });

  it('writes the full report as JSON for an evidence trail', () => {
    meter(1_500);
    subscribeAndTax();
    const outFile = path.join(root, 'reconciliation.json');
    run(['billing:reconcile', '--month', YEAR_MONTH, '--out', outFile]);

    const report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(report.ok).toBe(true);
    expect(report.rollup.billableRequests).toBe(1_500);
    expect(report.meterLossWindow.measured).toBe(false);
    expect(report.accounts[0].accountId).toBe(accountId);
  });
});

describe('the store refuses what it cannot bill from', () => {
  it('says which command to run when the key store has no usage tables', () => {
    const bare = path.join(tmpRoot(), 'bare.db');
    const keys = openApiKeyAdminStore({ API_KEYS_DB_PATH: bare } as NodeJS.ProcessEnv);
    keys.createAccount({ name: 'Bare', plan: 'explorer' });
    keys.close();

    expect(() => openBillingStore({ env: { API_KEYS_DB_PATH: bare } as NodeJS.ProcessEnv })).toThrow(
      /no usage tables, so there is nothing to bill from/
    );
  });
});
