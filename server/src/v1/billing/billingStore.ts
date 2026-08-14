import type { AccountPlan } from '../keys/apiKeyStore.js';
import type { UsageRollupRow } from '../usage/usageStore.js';
import type { Invoice } from './invoice.js';
import type { EventCorroboration } from './reconciliation.js';
import type {
  SubscriptionChange,
  SubscriptionRecord,
  SubscriptionStatus,
} from './subscription.js';
import type { CustomerTaxProfile } from './vat.js';

/**
 * What the billing store holds, and the one capability over it.
 *
 * Types only — no import here reaches a database driver, so `billingCli.ts` and
 * the pure modules can name these without putting `better-sqlite3` in their
 * graphs. `sqliteBillingStore.ts` is the implementation, exactly as
 * `usageStore.ts` stands to `sqliteUsageStore.ts`.
 *
 * ## Why there is one interface here and not two
 *
 * `apiKeyStore.ts` splits a read-only `ApiKeyDirectory` from an
 * `ApiKeyAdminStore` because the request path needs the first and must not have
 * the second. Billing has no request-path half at all: **nothing under
 * `v1/billing/` is reachable from `publicApp.ts` or `publicIndex.ts`**, and
 * `publicAppGraph.test.ts` asserts it alongside the keys and usage CLIs. A
 * subscription is not consulted to serve a request — ABL-302 gates on
 * `accounts.plan`, which the gate already reads — so there is no capability to
 * withhold and no second interface to define.
 *
 * That is also the property that keeps this store off the request path's
 * critical section: it opens a fourth handle on `API_KEYS_DB_PATH`, and it does
 * so only in a CLI process an operator started.
 */

export interface RecordChangeInput {
  accountId: string;
  plan: AccountPlan;
  status: SubscriptionStatus;
  /** ISO 8601 UTC. Defaults to now in the CLI, never here. */
  effectiveAt: string;
  reason: string | null;
}

export interface SaveInvoiceOutcome {
  /** True when a document for this account-month already existed and was replaced. */
  replaced: boolean;
}

export interface BillingAdminStore {
  /*
   * Subscription state
   */

  /** Append a transition. Nothing updates or deletes one; see `subscription.ts`. */
  recordChange(input: RecordChangeInput): SubscriptionChange;
  /** Every change for an account, oldest first. The input to `segmentsForMonth`. */
  changesFor(accountId: string): SubscriptionChange[];
  /** Current derived state, or `null` for an account with no subscription history. */
  subscription(accountId: string, now: Date): SubscriptionRecord | null;
  listSubscriptions(now: Date): SubscriptionRecord[];
  /**
   * Attach test-mode provider handles.
   *
   * Refuses anything that is not a test-mode reference — see `provider.ts`. The
   * refusal is in the store rather than only in the caller so that a live
   * identifier cannot be written by a future code path that forgot to check.
   */
  linkProvider(input: {
    accountId: string;
    customerRef: string;
    subscriptionRef: string;
  }): SubscriptionRecord;

  /*
   * Tax position
   */

  putTaxProfile(profile: CustomerTaxProfile): CustomerTaxProfile;
  taxProfile(accountId: string): CustomerTaxProfile | null;

  /*
   * Invoices
   */

  /** Store a draft. One document per account-month; a re-run replaces it. */
  saveInvoice(invoice: Invoice): SaveInvoiceOutcome;
  invoicesForMonth(yearMonth: string): Invoice[];
  invoiceFor(accountId: string, yearMonth: string): Invoice | null;

  /*
   * Reads for reconciliation
   *
   * The invoice is built from `usage_rollup` alone — ABL-297 §9(2), because the
   * raw events are deleted at 13 months. The *reconciliation* deliberately reads
   * both, because corroborating one against the other is the whole point of it.
   * That split is the reason these two are separate methods with the difference
   * stated, rather than one convenient accessor.
   */

  rollupForMonth(yearMonth: string): UsageRollupRow[];
  /**
   * Recompute a month from `usage_events`, or say why it cannot be.
   *
   * Returns `corroborable: false` for a month whose raw rows retention has
   * removed. That is the designed lifecycle and not a fault, and reporting it as
   * zero discrepancies would be reporting a check that did not run.
   */
  corroborateMonth(yearMonth: string, now: Date): EventCorroboration;
  /** `accounts.plan` per account — the gate's copy, for the divergence check. */
  servedPlans(): Map<string, AccountPlan>;
  /** Accounts that exist at all, so an invoice run can name one that has no subscription. */
  listAccountIds(): string[];

  close(): void;
}
