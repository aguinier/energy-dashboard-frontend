import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { ACCOUNT_PLANS, type AccountPlan } from '../keys/apiKeyStore.js';
import { resolveApiKeysDbPath } from '../keys/sqliteApiKeyStore.js';
import {
  monthEndExclusive,
  resolveRetentionPolicy,
  subtractMonths,
  type RetentionPolicy,
  type UsageRollupRow,
} from '../usage/usageStore.js';
import type { BillingAdminStore, RecordChangeInput, SaveInvoiceOutcome } from './billingStore.js';
import type { Invoice } from './invoice.js';
import type { EventCorroboration } from './reconciliation.js';
import { assertTestModeRef } from './provider.js';
import {
  monthStartIso,
  stateAt,
  SUBSCRIPTION_STATUSES,
  type SubscriptionChange,
  type SubscriptionRecord,
  type SubscriptionStatus,
} from './subscription.js';
import { UNVERIFIED_VAT_ID, type CustomerTaxProfile, type VatIdValidation } from './vat.js';

/**
 * Billing records on disk: four tables, in the **same SQLite file as the key
 * store and the usage tables**, and never in the energy database.
 *
 * The placement argument is `sqliteApiKeyStore.ts`'s and is settled; this module
 * reuses `resolveApiKeysDbPath` rather than reading `API_KEYS_DB_PATH` itself,
 * for the same reason `sqliteUsageStore.ts` does — one decision about what the
 * path is, one guard to keep true. Accounts, keys, usage and now subscriptions
 * are one customer's record and belong in one file, with one backup and one
 * migration schedule.
 *
 * ## This is the fourth module in the repository that opens a database, and the
 *    first that the serving process cannot reach
 *
 * `publicAppGraph.test.ts` pins the set of modules that open a database
 * *reachable from `publicIndex.ts`* at three, and this is not one of them: it is
 * reached from `billingCli.ts` alone, which that same test asserts the public
 * entrypoint cannot reach — alongside `keysCli.ts` and `usageCli.ts`, for the
 * same reason. A subscription is never consulted to serve a request. ABL-302
 * gates on `accounts.plan`, which the gate reads through the key store it
 * already holds, so nothing here needs to be on a request path and nothing here
 * is.
 *
 * ## `CHECK (mode = 'test')`, which is the one structural control
 *
 * Both tables that could tie a row here to a real payment carry it. It is a
 * database constraint rather than a validation because ABL-307's binding
 * instruction — no live keys, no real payments, no customer data — has to
 * survive a future code path that forgot, and a column that cannot hold the
 * value `'live'` cannot be made to. `provider.ts` checks the same thing one
 * layer up, on the identifier's shape.
 */

/** Applied on open, like the usage tables and unlike the key tables. See {@link openBillingStore}. */
const SCHEMA = `
-- Append-only. Nothing updates or deletes a row here: a subscription's state at
-- any past instant is derived by replaying these, which is what lets an invoice
-- for July be defended after an August upgrade overwrote accounts.plan.
CREATE TABLE IF NOT EXISTS billing_subscription_change (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  -- When the change applies. May be in the past (a correction) or the future (a
  -- downgrade agreed now for next month), which is why it is separate from
  -- recorded_at rather than defaulted from it.
  effective_at TEXT NOT NULL,
  plan         TEXT NOT NULL,
  status       TEXT NOT NULL,
  reason       TEXT,
  recorded_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_billing_change_account
  ON billing_subscription_change(account_id, effective_at);

-- The provider handles. CHECK (mode = 'test') is load-bearing: see the header.
CREATE TABLE IF NOT EXISTS billing_provider_link (
  account_id       TEXT PRIMARY KEY,
  provider         TEXT NOT NULL,
  customer_ref     TEXT NOT NULL,
  subscription_ref TEXT NOT NULL,
  mode             TEXT NOT NULL CHECK (mode = 'test'),
  linked_at        TEXT NOT NULL
);

-- Where the customer belongs, and the evidence for it. vat_id_status is never
-- 'validated' in this deployment: VIES is an outbound network call and this is
-- LAN-only. See vat.ts.
CREATE TABLE IF NOT EXISTS billing_tax_profile (
  account_id        TEXT PRIMARY KEY,
  country           TEXT NOT NULL,
  customer_kind     TEXT NOT NULL,
  vat_id            TEXT,
  vat_id_status     TEXT NOT NULL,
  vat_id_checked_at TEXT,
  vat_id_source     TEXT,
  vat_id_reference  TEXT,
  updated_at        TEXT NOT NULL
);

-- One draft per account-month. The scalar columns are what a query needs; the
-- document is the whole invoice as built, including the lines, the VAT
-- reasoning and the blockers.
--
-- Both are stored rather than one recomputed, because an invoice must be
-- defensible years later and the modules that built it will have changed. The
-- document is the record of what we *said*; the columns are for finding it.
CREATE TABLE IF NOT EXISTS billing_invoice (
  account_id             TEXT NOT NULL,
  year_month             TEXT NOT NULL,
  mode                   TEXT NOT NULL CHECK (mode = 'test'),
  currency               TEXT NOT NULL,
  net_minor              INTEGER NOT NULL,
  vat_minor              INTEGER NOT NULL,
  gross_minor            INTEGER NOT NULL,
  billable_requests      INTEGER NOT NULL,
  vat_treatment          TEXT NOT NULL,
  price_book_fingerprint TEXT NOT NULL,
  blocker_count          INTEGER NOT NULL,
  document               TEXT NOT NULL,
  built_at               TEXT NOT NULL,
  PRIMARY KEY (account_id, year_month)
);
`;

export interface OpenBillingStoreOptions {
  env?: NodeJS.ProcessEnv;
  policy?: RetentionPolicy;
}

/**
 * Open the billing store read-write, applying its schema.
 *
 * `fileMustExist`, and the `api_keys` check, for the reasons `sqliteUsageStore`
 * gives: the file is the key store's, and a path typo must fail loudly rather
 * than start writing subscriptions into an empty database nobody will look in.
 */
export function openBillingStore({
  env = process.env,
  policy,
}: OpenBillingStoreOptions = {}): BillingAdminStore {
  const dbPath = resolveApiKeysDbPath(env);
  const retention = policy ?? resolveRetentionPolicy(env);

  let db: DatabaseType;
  try {
    db = new Database(dbPath, { fileMustExist: true });
  } catch (err) {
    throw new Error(
      `Cannot open the /v1 billing store at ${dbPath}: ${(err as Error).message}. ` +
        'Billing records live in the same file as the key store; create it with ' +
        '`npm run keys -- accounts:create --name "..." --plan explorer` in server/.'
    );
  }

  const isKeyStore = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'")
    .get();
  if (!isKeyStore) {
    db.close();
    throw new Error(
      `The file at ${dbPath} has no api_keys table, so it is not a /v1 key store and billing ` +
        'tables do not belong in it. Check API_KEYS_DB_PATH.'
    );
  }

  // The usage tables are ABL-301's to create — `openUsageStore` applies that
  // schema, and duplicating the DDL here would give the repository two
  // definitions of the table an invoice is raised from. So this checks for them
  // and says what to run, rather than either creating them or letting
  // `rollupForMonth` fail later with `no such table`. Reachable on a key store
  // that has never served a request.
  const hasUsageTables = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_rollup'")
    .get();
  if (!hasUsageTables) {
    db.close();
    throw new Error(
      `The key store at ${dbPath} has no usage tables, so there is nothing to bill from. They ` +
        'are created by the metering layer (ABL-301) the first time the public API starts, or ' +
        'by `npm run usage -- usage:stats` in server/. Billing does not create them: the table ' +
        'an invoice is raised from should have exactly one definition.'
    );
  }

  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);

  function readChanges(accountId: string): SubscriptionChange[] {
    return (
      db
        .prepare(
          `SELECT * FROM billing_subscription_change
            WHERE account_id = ? ORDER BY effective_at, recorded_at, id`
        )
        .all(accountId) as Array<Record<string, unknown>>
    ).map((row) => ({
      id: row.id as string,
      accountId: row.account_id as string,
      effectiveAt: row.effective_at as string,
      plan: row.plan as AccountPlan,
      status: row.status as SubscriptionStatus,
      reason: (row.reason as string | null) ?? null,
      recordedAt: row.recorded_at as string,
    }));
  }

  function readProviderLink(
    accountId: string
  ): { customerRef: string; subscriptionRef: string } | null {
    const row = db
      .prepare('SELECT customer_ref, subscription_ref FROM billing_provider_link WHERE account_id = ?')
      .get(accountId) as { customer_ref: string; subscription_ref: string } | undefined;
    return row === undefined
      ? null
      : { customerRef: row.customer_ref, subscriptionRef: row.subscription_ref };
  }

  function deriveSubscription(accountId: string, now: Date): SubscriptionRecord | null {
    const changes = readChanges(accountId);
    if (changes.length === 0) return null;

    const state = stateAt(changes, now.toISOString());
    if (state === null) {
      // Every change is in the future: the subscription is agreed and has not
      // started. Reported as null rather than as the first future state, so an
      // invoice for a month before it starts charges nothing rather than
      // charging the plan the customer has not begun.
      return null;
    }

    const link = readProviderLink(accountId);
    return {
      accountId,
      plan: state.plan,
      status: state.status,
      since: state.since,
      providerCustomerRef: link?.customerRef ?? null,
      providerSubscriptionRef: link?.subscriptionRef ?? null,
      createdAt: changes[0].recordedAt,
      updatedAt: changes[changes.length - 1].recordedAt,
    };
  }

  return {
    recordChange({ accountId, plan, status, effectiveAt, reason }: RecordChangeInput) {
      if (!ACCOUNT_PLANS.includes(plan)) {
        throw new Error(`Unknown plan "${plan}". One of: ${ACCOUNT_PLANS.join(', ')}.`);
      }
      if (!SUBSCRIPTION_STATUSES.includes(status)) {
        throw new Error(
          `Unknown subscription status "${status}". One of: ${SUBSCRIPTION_STATUSES.join(', ')}.`
        );
      }
      if (Number.isNaN(Date.parse(effectiveAt))) {
        throw new Error(`effectiveAt "${effectiveAt}" is not a parseable instant.`);
      }

      const change: SubscriptionChange = {
        id: `sub_chg_${randomUUID()}`,
        accountId,
        // Normalised through `Date` so every stored instant is the same
        // fixed-width form the meter writes. `segmentsForMonth` compares these
        // as strings against `usage_rollup`'s timestamps, and a mixed-format
        // column would make those comparisons quietly wrong.
        effectiveAt: new Date(effectiveAt).toISOString(),
        plan,
        status,
        reason: reason ?? null,
        recordedAt: new Date().toISOString(),
      };

      db.prepare(
        `INSERT INTO billing_subscription_change
           (id, account_id, effective_at, plan, status, reason, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        change.id,
        change.accountId,
        change.effectiveAt,
        change.plan,
        change.status,
        change.reason,
        change.recordedAt
      );

      return change;
    },

    changesFor: readChanges,

    subscription: deriveSubscription,

    listSubscriptions(now) {
      return (
        db
          .prepare('SELECT DISTINCT account_id FROM billing_subscription_change ORDER BY account_id')
          .all() as Array<{ account_id: string }>
      )
        .map((row) => deriveSubscription(row.account_id, now))
        .filter((record): record is SubscriptionRecord => record !== null);
    },

    linkProvider({ accountId, customerRef, subscriptionRef }) {
      // Checked here as well as in `provider.ts`, because this is the boundary a
      // live identifier would have to cross to become durable. The CHECK
      // constraint below covers `mode`; these cover the references themselves.
      assertTestModeRef(customerRef, 'customerRef');
      assertTestModeRef(subscriptionRef, 'subscriptionRef');

      db.prepare(
        `INSERT INTO billing_provider_link
           (account_id, provider, customer_ref, subscription_ref, mode, linked_at)
         VALUES (?, 'local-test', ?, ?, 'test', ?)
         ON CONFLICT(account_id) DO UPDATE SET
           customer_ref = excluded.customer_ref,
           subscription_ref = excluded.subscription_ref,
           linked_at = excluded.linked_at`
      ).run(accountId, customerRef, subscriptionRef, new Date().toISOString());

      const record = deriveSubscription(accountId, new Date());
      if (record === null) {
        throw new Error(
          `${accountId} has no subscription history, so there is nothing to link a provider ` +
            'customer to. Record a subscription first with `billing:subscribe`.'
        );
      }
      return record;
    },

    putTaxProfile(profile) {
      db.prepare(
        `INSERT INTO billing_tax_profile
           (account_id, country, customer_kind, vat_id, vat_id_status, vat_id_checked_at,
            vat_id_source, vat_id_reference, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           country = excluded.country,
           customer_kind = excluded.customer_kind,
           vat_id = excluded.vat_id,
           vat_id_status = excluded.vat_id_status,
           vat_id_checked_at = excluded.vat_id_checked_at,
           vat_id_source = excluded.vat_id_source,
           vat_id_reference = excluded.vat_id_reference,
           updated_at = excluded.updated_at`
      ).run(
        profile.accountId,
        profile.country.toUpperCase(),
        profile.customerKind,
        profile.vatId,
        profile.validation.status,
        profile.validation.checkedAt,
        profile.validation.source,
        profile.validation.reference,
        new Date().toISOString()
      );
      return profile;
    },

    taxProfile(accountId) {
      const row = db
        .prepare('SELECT * FROM billing_tax_profile WHERE account_id = ?')
        .get(accountId) as Record<string, unknown> | undefined;
      if (row === undefined) return null;

      const validation: VatIdValidation = {
        status: row.vat_id_status as VatIdValidation['status'],
        checkedAt: (row.vat_id_checked_at as string | null) ?? null,
        source: (row.vat_id_source as string | null) ?? null,
        reference: (row.vat_id_reference as string | null) ?? null,
      };

      return {
        accountId,
        country: row.country as string,
        customerKind: row.customer_kind as CustomerTaxProfile['customerKind'],
        vatId: (row.vat_id as string | null) ?? null,
        validation,
      };
    },

    saveInvoice(invoice: Invoice): SaveInvoiceOutcome {
      const existing = db
        .prepare('SELECT 1 FROM billing_invoice WHERE account_id = ? AND year_month = ?')
        .get(invoice.accountId, invoice.yearMonth);

      db.prepare(
        `INSERT INTO billing_invoice
           (account_id, year_month, mode, currency, net_minor, vat_minor, gross_minor,
            billable_requests, vat_treatment, price_book_fingerprint, blocker_count, document,
            built_at)
         VALUES (?, ?, 'test', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, year_month) DO UPDATE SET
           currency = excluded.currency,
           net_minor = excluded.net_minor,
           vat_minor = excluded.vat_minor,
           gross_minor = excluded.gross_minor,
           billable_requests = excluded.billable_requests,
           vat_treatment = excluded.vat_treatment,
           price_book_fingerprint = excluded.price_book_fingerprint,
           blocker_count = excluded.blocker_count,
           document = excluded.document,
           built_at = excluded.built_at`
      ).run(
        invoice.accountId,
        invoice.yearMonth,
        invoice.currency,
        invoice.netMinor,
        invoice.vatMinor,
        invoice.grossMinor,
        invoice.usage.billableRequests,
        invoice.vat.kind,
        invoice.priceBookFingerprint,
        invoice.blockers.length,
        JSON.stringify(invoice),
        invoice.builtAt
      );

      return { replaced: existing !== undefined };
    },

    invoicesForMonth(yearMonth) {
      return (
        db
          .prepare('SELECT document FROM billing_invoice WHERE year_month = ? ORDER BY account_id')
          .all(yearMonth) as Array<{ document: string }>
      ).map((row) => JSON.parse(row.document) as Invoice);
    },

    invoiceFor(accountId, yearMonth) {
      const row = db
        .prepare('SELECT document FROM billing_invoice WHERE account_id = ? AND year_month = ?')
        .get(accountId, yearMonth) as { document: string } | undefined;
      return row === undefined ? null : (JSON.parse(row.document) as Invoice);
    },

    rollupForMonth(yearMonth) {
      return (
        db
          .prepare('SELECT * FROM usage_rollup WHERE year_month = ? ORDER BY account_id, key_id')
          .all(yearMonth) as Array<Record<string, unknown>>
      ).map((row) => ({
        accountId: row.account_id as string,
        keyId: row.key_id as string,
        yearMonth: row.year_month as string,
        requests: row.requests as number,
        billableRequests: row.billable_requests as number,
        rowsReturned: row.rows_returned as number,
        responseBytes: row.response_bytes as number,
        firstEventAt: row.first_event_at as string,
        lastEventAt: row.last_event_at as string,
        closedAt: (row.closed_at as string | null) ?? null,
        lateRequests: row.late_requests as number,
        lateBillableRequests: row.late_billable_requests as number,
      })) satisfies UsageRollupRow[];
    },

    corroborateMonth(yearMonth, now): EventCorroboration {
      const empty = new Map<string, { requests: number; billableRequests: number }>();

      // Past the events retention horizon, the raw rows may have been deleted —
      // and a partial corroboration against a half-deleted month is worse than
      // none, because it reports a discrepancy that retention caused and calls
      // it unexplained. The rollup rows are the seven-year record and stand on
      // their own; this check simply does not apply.
      const horizon = subtractMonths(now, retention.eventMonths);
      if (monthEndExclusive(yearMonth).getTime() <= horizon.getTime()) {
        return {
          corroborable: false,
          reason:
            `${yearMonth} ended before the ${retention.eventMonths}-month request-record ` +
            'retention horizon (ABL-297 §5), so usage_events no longer holds it and the rollup ' +
            'cannot be checked against raw rows. The rollup is retained for seven years and is ' +
            'the invoice record.',
          requests: 0,
          billableRequests: 0,
          unrolledRequests: 0,
          unrolledBillableRequests: 0,
          byAccount: empty,
        };
      }

      const startIso = monthStartIso(yearMonth);
      const endIso = monthEndExclusive(yearMonth).toISOString();
      const watermark = (
        db
          .prepare(
            'SELECT COALESCE(MAX(rolled_through_event_id), 0) AS id FROM usage_rollup_state WHERE id = 1'
          )
          .get() as { id: number }
      ).id;

      // The same half-open `received_at` range `COUNT_SERVED_IN_MONTH` uses, and
      // for the same reason: `substr(received_at, 1, 7) = ?` is not sargable and
      // degrades to a full scan of a table that grows by one row per request.
      const totals = db
        .prepare(
          `SELECT COUNT(*)                                        AS requests,
                  COALESCE(SUM(billable), 0)                      AS billable,
                  COALESCE(SUM(CASE WHEN id > ? THEN 1 ELSE 0 END), 0)        AS unrolled,
                  COALESCE(SUM(CASE WHEN id > ? THEN billable ELSE 0 END), 0) AS unrolled_billable
             FROM usage_events
            WHERE received_at >= ? AND received_at < ?`
        )
        .get(watermark, watermark, startIso, endIso) as {
        requests: number;
        billable: number;
        unrolled: number;
        unrolled_billable: number;
      };

      const byAccount = new Map<string, { requests: number; billableRequests: number }>();
      for (const row of db
        .prepare(
          `SELECT account_id, COUNT(*) AS requests, COALESCE(SUM(billable), 0) AS billable
             FROM usage_events
            WHERE received_at >= ? AND received_at < ?
            GROUP BY account_id`
        )
        .all(startIso, endIso) as Array<{
        account_id: string;
        requests: number;
        billable: number;
      }>) {
        byAccount.set(row.account_id, {
          requests: row.requests,
          billableRequests: row.billable,
        });
      }

      return {
        corroborable: true,
        reason: null,
        requests: totals.requests,
        billableRequests: totals.billable,
        unrolledRequests: totals.unrolled,
        unrolledBillableRequests: totals.unrolled_billable,
        byAccount,
      };
    },

    servedPlans() {
      const plans = new Map<string, AccountPlan>();
      for (const row of db.prepare('SELECT id, plan FROM accounts').all() as Array<{
        id: string;
        plan: AccountPlan;
      }>) {
        plans.set(row.id, row.plan);
      }
      return plans;
    },

    listAccountIds() {
      return (
        db.prepare('SELECT id FROM accounts ORDER BY id').all() as Array<{ id: string }>
      ).map((row) => row.id);
    },

    close() {
      db.close();
    },
  };
}

/** Re-exported so a caller building a profile does not need a second import. */
export { UNVERIFIED_VAT_ID };
