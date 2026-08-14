import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ACCOUNT_PLANS, type AccountPlan } from '../keys/apiKeyStore.js';
import { resolveApiKeysDbPath } from '../keys/sqliteApiKeyStore.js';
import { monthEndExclusive } from '../usage/usageStore.js';
import type { BillingAdminStore } from './billingStore.js';
import { buildInvoice, type Invoice } from './invoice.js';
import { BILLING_CURRENCY, formatMinor } from './money.js';
import {
  PRICE_BOOK_ENV,
  PRICING_DECISION,
  parsePriceBook,
  resolvePriceBook,
  type PriceBook,
} from './priceBook.js';
import { createLocalTestProvider, resolveProvider, type PaymentProvider } from './provider.js';
import { reconcile, type ReconciliationReport } from './reconciliation.js';
import { openBillingStore } from './sqliteBillingStore.js';
import {
  SUBSCRIPTION_STATUSES,
  mergeAdjacent,
  segmentsForMonth,
  stateAt,
  type SubscriptionStatus,
} from './subscription.js';
import {
  UNVERIFIED_VAT_ID,
  formatRate,
  resolveSupplier,
  vatIdLooksWellFormed,
  type CustomerTaxProfile,
  type SupplierTaxProfile,
} from './vat.js';

/**
 * `npm run billing -- <command>` — subscription state, the draft invoice, and
 * the reconciliation.
 *
 * Three audiences, one tool, mirroring `usageCli.ts`:
 *
 * - **Commercial.** `billing:subscribe`, `billing:status` and `billing:tax`
 *   record what an account is on and where it belongs. Every one of them appends
 *   to a history rather than overwriting a column, so an invoice raised months
 *   later can be defended against what was true then.
 * - **Billing.** `billing:invoice` maps a closed month of metered usage onto the
 *   invoice we would raise. Every document it produces is stamped test-mode and
 *   draft, and there is no flag that removes the stamp.
 * - **Assurance.** `billing:reconcile` is the acceptance bar for ABL-307: what
 *   we metered against what we would bill, with every difference attributed to a
 *   named cause. Run it before believing an invoice figure and after any month
 *   in which the rollup was behind.
 *
 * ```
 * cd server
 * npm run billing -- billing:price-book
 * npm run billing -- billing:subscribe --account acct_… --plan developer
 * npm run billing -- billing:tax --account acct_… --country DE --kind business --vat-id DE123456789
 * npm run billing -- billing:invoice --month 2026-07 --save
 * npm run billing -- billing:reconcile --month 2026-07
 * ```
 *
 * Reads the same `API_KEYS_DB_PATH` as the keys and usage CLIs, because all
 * three sets of tables live in that one file. Hand-rolled argument parsing, for
 * the reason `usageCli.ts` gives: a public surface should not be how a sixth
 * runtime dependency arrives.
 */

interface ParsedArgs {
  command: string;
  flags: Record<string, string | true>;
}

/** `--name value` / `--flag`. A copy of `usageCli.ts`'s parser; see its note on why. */
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

class BillingCliError extends Error {}

function requireString(flags: ParsedArgs['flags'], name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BillingCliError(`--${name} is required and needs a value.`);
  }
  return value.trim();
}

function optionalString(flags: ParsedArgs['flags'], name: string): string | null {
  const value = flags[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function requireYearMonth(flags: ParsedArgs['flags'], name = 'month'): string {
  const value = requireString(flags, name);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new BillingCliError(`--${name} must be a UTC calendar month as YYYY-MM, and is "${value}".`);
  }
  return value;
}

function requirePlan(flags: ParsedArgs['flags']): AccountPlan {
  const value = requireString(flags, 'plan');
  if (!(ACCOUNT_PLANS as readonly string[]).includes(value)) {
    throw new BillingCliError(`--plan must be one of: ${ACCOUNT_PLANS.join(', ')}. Got "${value}".`);
  }
  return value as AccountPlan;
}

function optionalStatus(flags: ParsedArgs['flags'], fallback: SubscriptionStatus): SubscriptionStatus {
  const value = optionalString(flags, 'status');
  if (value === null) return fallback;
  if (!(SUBSCRIPTION_STATUSES as readonly string[]).includes(value)) {
    throw new BillingCliError(
      `--status must be one of: ${SUBSCRIPTION_STATUSES.join(', ')}. Got "${value}".`
    );
  }
  return value as SubscriptionStatus;
}

const USAGE = `
Billing for /v1, in TEST MODE ONLY. Reads API_KEYS_DB_PATH — the same SQLite file as the
key store and the usage tables.

  billing:price-book   [--file <path>]
                       What each plan costs, or which Board decision is still open. With
                       --file, validate a candidate price book without configuring it.

  billing:subscribe    --account <acct_...> --plan <plan> [--status <status>]
                       [--effective <ISO instant>] [--reason "..."]
                       Append a subscription change. Never overwrites: an invoice for a past
                       month is derived by replaying these.

  billing:status       --account <acct_...> --status <status> [--effective] [--reason]
                       Same, for a status change that keeps the plan.

  billing:tax          --account <acct_...> --country <XX> --kind business|consumer
                       [--vat-id <VATID>]
                       Where the customer belongs. A VAT number is recorded UNVERIFIED —
                       VIES is an outbound call and this deployment is LAN-only — so the
                       reverse charge will not be applied to it. See vat.ts.

  billing:link         --account <acct_...>
                       Attach test-mode provider handles. Refuses any live identifier.

  billing:show         --account <acct_...> [--month <YYYY-MM>]
                       Current state, its history, and the tax position.

  billing:invoice      --month <YYYY-MM> [--account <acct_...>] [--save] [--out <file.json>]
                       Build the draft invoices for a closed month. --save stores them.

  billing:reconcile    --month <YYYY-MM> [--out <file.json>]
                       What we metered against what we would bill, with every difference
                       attributed. This is the check to run before trusting a figure.

Nothing here issues, sends or charges anything. Every document is stamped test-mode and
draft, and no code path removes the stamp (ABL-349 is open).
`.trim();

export interface RunCommandOptions {
  store: BillingAdminStore;
  provider: PaymentProvider;
  parsed: ParsedArgs;
  env: NodeJS.ProcessEnv;
  now: Date;
  log: (line: string) => void;
}

export function runCommand({ store, provider, parsed, env, now, log }: RunCommandOptions): void {
  const { command, flags } = parsed;

  switch (command) {
    case 'billing:price-book':
      return showPriceBook(flags, env, log);

    case 'billing:subscribe': {
      const accountId = requireString(flags, 'account');
      const plan = requirePlan(flags);
      const status = optionalStatus(flags, 'active');
      const effectiveAt = optionalString(flags, 'effective') ?? now.toISOString();

      const change = store.recordChange({
        accountId,
        plan,
        status,
        effectiveAt,
        reason: optionalString(flags, 'reason'),
      });

      log(
        `recorded ${change.plan}/${change.status} for ${accountId}, effective ${change.effectiveAt}`
      );
      if (Date.parse(change.effectiveAt) > now.getTime()) {
        log('That is in the future, so it does not affect any month before it.');
      }
      return;
    }

    case 'billing:status': {
      const accountId = requireString(flags, 'account');
      const current = store.subscription(accountId, now);
      if (current === null) {
        throw new BillingCliError(
          `${accountId} has no subscription, so there is no status to change. Use ` +
            'billing:subscribe first.'
        );
      }
      const status = optionalStatus(flags, current.status);
      const change = store.recordChange({
        accountId,
        plan: current.plan,
        status,
        effectiveAt: optionalString(flags, 'effective') ?? now.toISOString(),
        reason: optionalString(flags, 'reason'),
      });
      log(`${accountId}: ${current.status} → ${change.status}, effective ${change.effectiveAt}`);
      return;
    }

    case 'billing:tax': {
      const accountId = requireString(flags, 'account');
      const country = requireString(flags, 'country').toUpperCase();
      const kind = requireString(flags, 'kind');
      if (kind !== 'business' && kind !== 'consumer') {
        throw new BillingCliError('--kind must be business or consumer.');
      }
      const vatId = optionalString(flags, 'vat-id');

      const profile: CustomerTaxProfile = {
        accountId,
        country,
        customerKind: kind,
        vatId,
        // Always unverified. There is no flag to assert otherwise, because a
        // reverse charge rests on this field and an operator's assurance is not
        // a VIES consultation number. See vat.ts.
        validation: UNVERIFIED_VAT_ID,
      };
      store.putTaxProfile(profile);

      log(`${accountId}: ${kind} in ${country}${vatId ? `, VAT ${vatId}` : ''}`);
      if (vatId !== null) {
        log(
          vatIdLooksWellFormed(country, vatId)
            ? `${vatId} is shaped like a ${country} VAT number, but is recorded UNVERIFIED — no ` +
                'VIES check has run, so the reverse charge will NOT be applied and VAT will be ' +
                'charged instead.'
            : `${vatId} is NOT shaped like a ${country} VAT number. Recorded as given; it will ` +
                'not support a reverse charge.'
        );
      }
      return;
    }

    case 'billing:link': {
      const accountId = requireString(flags, 'account');
      const subscription = store.subscription(accountId, now);
      if (subscription === null) {
        throw new BillingCliError(`${accountId} has no subscription to link.`);
      }

      const { customerRef } = provider.ensureCustomer({ accountId, name: accountId });
      const { subscriptionRef } = provider.ensureSubscription({
        accountId,
        customerRef,
        plan: subscription.plan,
      });
      store.linkProvider({ accountId, customerRef, subscriptionRef });

      log(`${accountId} → ${provider.name} (${provider.mode}): ${customerRef} / ${subscriptionRef}`);
      log('Local handles only. No network call was made and no provider account exists.');
      return;
    }

    case 'billing:show':
      return showAccount(store, flags, now, log);

    case 'billing:invoice':
      return runInvoice(store, flags, env, now, log);

    case 'billing:reconcile':
      return runReconcile(store, flags, env, now, log);

    case '':
    case 'help':
    case '--help':
      log(USAGE);
      return;

    default:
      throw new BillingCliError(`Unknown command: ${command}`);
  }
}

/*
 * ---------------------------------------------------------------------------
 * Commands with enough output to be worth their own function
 * ---------------------------------------------------------------------------
 */

function showPriceBook(
  flags: ParsedArgs['flags'],
  env: NodeJS.ProcessEnv,
  log: (line: string) => void
): void {
  const file = optionalString(flags, 'file');
  const book = file === null ? resolvePriceBook(env) : parsePriceBook(fs.readFileSync(file, 'utf8'), file);

  if (book.status === 'undecided') {
    log(book.reason);
    log('');
    log(`Open decision: ${PRICING_DECISION}.`);
    log(
      `When it is ruled, write the figures to a JSON file and point ${PRICE_BOOK_ENV} at it. ` +
        'The file is validated against quota/planLimits.ts on load — the gate and the invoice ' +
        'must be derived from the same prices — so a mismatch fails there rather than on a bill.'
    );
    log('');
    log('Shape:');
    log(
      JSON.stringify(
        {
          currency: BILLING_CURRENCY,
          effectiveFrom: 'YYYY-MM-DD',
          plans: Object.fromEntries(
            ACCOUNT_PLANS.map((plan) => [
              plan,
              { base: '0.00', includedRequests: 0, overagePerThousand: null },
            ])
          ),
        },
        null,
        2
      )
    );
    return;
  }

  log(`price book       ${book.source}`);
  log(`effective from   ${book.effectiveFrom}`);
  log(`fingerprint      ${book.fingerprint}`);
  log('');
  for (const plan of ACCOUNT_PLANS) {
    const pricing = book.plans[plan];
    // A plan with no tabulated allowance is negotiated per contract, and its
    // base is not a price this table can quote — printing "0.00 EUR/month" for
    // Enterprise would read as a free tier rather than as "see the contract".
    const included = pricing.includedRequests;
    log(
      `${plan.padEnd(13)} ` +
        (included === null
          ? `${'per contract'.padStart(10)}           included=negotiated`
          : `${formatMinor(pricing.baseMinor).padStart(10)} ${BILLING_CURRENCY}/month  ` +
            `included=${included.toLocaleString('en-GB')}`) +
        (pricing.overagePerThousandMinor === null
          ? '  overage=hard stop'
          : `  overage=${formatMinor(pricing.overagePerThousandMinor)}/1,000`)
    );
  }
  log('');
  log('Checked against quota/planLimits.ts on load: allowances and the overage ceiling agree.');
}

function showAccount(
  store: BillingAdminStore,
  flags: ParsedArgs['flags'],
  now: Date,
  log: (line: string) => void
): void {
  const accountId = requireString(flags, 'account');
  const subscription = store.subscription(accountId, now);
  const changes = store.changesFor(accountId);
  const tax = store.taxProfile(accountId);

  if (subscription === null && changes.length === 0) {
    log(`${accountId} has no subscription history.`);
    return;
  }

  log(
    subscription === null
      ? `${accountId}: no subscription in effect (every recorded change is in the future).`
      : `${accountId}: ${subscription.plan} / ${subscription.status} since ${subscription.since}`
  );
  if (subscription?.providerSubscriptionRef) {
    log(`  provider   ${subscription.providerCustomerRef} / ${subscription.providerSubscriptionRef} (test)`);
  }
  log(
    tax === null
      ? '  tax        NOT RECORDED — an invoice cannot resolve a VAT treatment without it.'
      : `  tax        ${tax.customerKind} in ${tax.country}` +
          (tax.vatId ? `, VAT ${tax.vatId} (${tax.validation.status})` : '')
  );

  log('\nhistory:');
  for (const change of changes) {
    log(
      `  ${change.effectiveAt}  ${change.plan}/${change.status}` +
        (change.reason ? `  — ${change.reason}` : '')
    );
  }

  const month = optionalString(flags, 'month');
  if (month !== null) {
    log(`\nsegments in ${month}:`);
    for (const segment of mergeAdjacent(segmentsForMonth(changes, month))) {
      log(
        `  ${segment.fromIso} → ${segment.toIso}  ` +
          `${segment.plan ?? 'no subscription'}${segment.status ? `/${segment.status}` : ''}  ` +
          `${(segment.durationMs / 86_400_000).toFixed(2)}d`
      );
    }
  }
}

/**
 * Resolve everything an invoice needs, or explain what is missing.
 *
 * The two configuration gaps — no price book, no supplier country — are reported
 * as sentences rather than thrown as errors, because both are states the company
 * is legitimately in while ABL-349 and Board Decision 1 are open. Neither is a
 * bug to be fixed by the person running the command.
 */
function resolveInvoicingContext(
  env: NodeJS.ProcessEnv,
  log: (line: string) => void
): { priceBook: PriceBook; supplier: SupplierTaxProfile } | null {
  const priceBook = resolvePriceBook(env);
  const supplier = resolveSupplier(env);

  if (priceBook.status === 'undecided' || supplier.status === 'unconfigured') {
    log('Cannot build an invoice yet:');
    if (priceBook.status === 'undecided') log(`  - ${priceBook.reason}`);
    if (supplier.status === 'unconfigured') log(`  - ${supplier.reason}`);
    log('');
    log(
      'Both are configuration, not code. Metering, subscription state and the rollup all work ' +
        'without them; run billing:reconcile to check the chain up to the point where a price ' +
        'is needed.'
    );
    return null;
  }

  return { priceBook, supplier: supplier.supplier as SupplierTaxProfile };
}

function buildInvoicesForMonth(
  store: BillingAdminStore,
  yearMonth: string,
  context: { priceBook: PriceBook; supplier: SupplierTaxProfile },
  now: Date,
  onlyAccount: string | null,
  log: (line: string) => void
): Invoice[] {
  const rollupRows = store.rollupForMonth(yearMonth);
  const accountIds = [
    ...new Set([
      ...rollupRows.map((row) => row.accountId),
      ...store.listSubscriptions(now).map((record) => record.accountId),
    ]),
  ]
    .filter((accountId) => onlyAccount === null || accountId === onlyAccount)
    .sort();

  const invoices: Invoice[] = [];

  for (const accountId of accountIds) {
    const changes = store.changesFor(accountId);
    const customer = store.taxProfile(accountId);

    if (customer === null) {
      log(
        `SKIPPED ${accountId}: no tax profile recorded, so the VAT treatment cannot be resolved. ` +
          'Record one with billing:tax.'
      );
      continue;
    }

    invoices.push(
      buildInvoice({
        accountId,
        yearMonth,
        rollupRows,
        segments: segmentsForMonth(changes, yearMonth),
        priceBook: context.priceBook,
        supplier: context.supplier,
        customer,
        now,
      })
    );
  }

  return invoices;
}

function runInvoice(
  store: BillingAdminStore,
  flags: ParsedArgs['flags'],
  env: NodeJS.ProcessEnv,
  now: Date,
  log: (line: string) => void
): void {
  const yearMonth = requireYearMonth(flags);
  const context = resolveInvoicingContext(env, log);
  if (context === null) return;

  const invoices = buildInvoicesForMonth(
    store,
    yearMonth,
    context,
    now,
    optionalString(flags, 'account'),
    log
  );

  if (invoices.length === 0) {
    log(`No account has both usage and a subscription in ${yearMonth}.`);
    return;
  }

  for (const invoice of invoices) {
    log('');
    describeInvoice(invoice, log);
    if (flags.save === true) {
      const { replaced } = store.saveInvoice(invoice);
      log(`  ${replaced ? 'replaced' : 'stored'} draft for ${invoice.accountId} ${yearMonth}`);
    }
  }

  const blocked = invoices.filter((invoice) => invoice.blockers.length > 0).length;
  log('');
  log(
    `${invoices.length} draft invoice(s) for ${yearMonth}, ` +
      `net ${formatMinor(invoices.reduce((s, i) => s + i.netMinor, 0))} ${BILLING_CURRENCY}, ` +
      `${blocked} with blockers.`
  );
  log('None of these may be issued: TEST MODE, and ABL-349 is open.');

  if (typeof flags.out === 'string') {
    fs.writeFileSync(flags.out, JSON.stringify(invoices, null, 2), 'utf8');
    log(`wrote ${invoices.length} document(s) to ${flags.out}`);
  }
}

function describeInvoice(invoice: Invoice, log: (line: string) => void): void {
  log(`${invoice.accountId}  ${invoice.yearMonth}  [${invoice.mode}]`);
  for (const line of invoice.lines) {
    log(
      `  ${line.description}\n` +
        `      ${String(line.quantity).padStart(9)} × ${formatMinor(line.unitPriceMinor)} / ` +
        `${line.unit}  =  ${formatMinor(line.netMinor).padStart(10)} ${invoice.currency}`
    );
  }

  log(
    `  net ${formatMinor(invoice.netMinor)}  VAT ${formatMinor(invoice.vatMinor)} ` +
      `(${invoice.vat.kind}${invoice.vat.rateCountry ? ` ${invoice.vat.rateCountry}` : ''} ` +
      `${formatRate(invoice.vat.rateBasisPoints)})  gross ${formatMinor(invoice.grossMinor)} ` +
      invoice.currency
  );
  log(
    `  metered ${invoice.usage.billableRequests.toLocaleString('en-GB')} billable of ` +
      `${invoice.usage.requests.toLocaleString('en-GB')} requests, included ` +
      `${invoice.usage.includedRequests?.toLocaleString('en-GB') ?? 'negotiated'}, overage ` +
      `${invoice.usage.overageRequests.toLocaleString('en-GB')}`
  );

  if (invoice.vat.legend) log(`  legend: ${invoice.vat.legend}`);
  for (const note of invoice.vat.notes) log(`  vat: ${note}`);
  for (const warning of invoice.warnings) log(`  WARNING: ${warning}`);
  for (const blocker of invoice.blockers) log(`  BLOCKER: ${blocker}`);
}

function runReconcile(
  store: BillingAdminStore,
  flags: ParsedArgs['flags'],
  env: NodeJS.ProcessEnv,
  now: Date,
  log: (line: string) => void
): void {
  const yearMonth = requireYearMonth(flags);
  const rollupRows = store.rollupForMonth(yearMonth);
  const events = store.corroborateMonth(yearMonth, now);

  // Invoices are rebuilt rather than read back, so the reconciliation checks the
  // mapping as it stands today rather than a document that may have been stored
  // under a different price book. Stored drafts are used only when there is no
  // price book to rebuild with — see below.
  const context = resolveInvoicingContext(env, () => {});
  const invoices =
    context === null
      ? store.invoicesForMonth(yearMonth)
      : buildInvoicesForMonth(store, yearMonth, context, now, null, () => {});

  const billedPlans = new Map<string, AccountPlan>();
  const monthEndIso = new Date(monthEndExclusive(yearMonth).getTime() - 1).toISOString();
  for (const accountId of store.listAccountIds()) {
    const state = stateAt(store.changesFor(accountId), monthEndIso);
    if (state !== null) billedPlans.set(accountId, state.plan);
  }

  const report = reconcile({
    yearMonth,
    rollupRows,
    events,
    invoices,
    servedPlans: store.servedPlans(),
    billedPlans,
    now,
  });

  describeReconciliation(report, context === null, log);

  if (typeof flags.out === 'string') {
    fs.writeFileSync(flags.out, JSON.stringify(report, null, 2), 'utf8');
    log(`\nwrote the full report to ${flags.out}`);
  }
}

function describeReconciliation(
  report: ReconciliationReport,
  pricesMissing: boolean,
  log: (line: string) => void
): void {
  log(`Reconciliation for ${report.yearMonth}`);
  log('');

  log('metered → aggregated → invoiced');
  log(
    `  usage_events        ${
      report.events.corroborable
        ? `${report.events.billableRequests.toLocaleString('en-GB')} billable of ` +
          `${report.events.requests.toLocaleString('en-GB')} requests` +
          (report.events.unrolledBillableRequests > 0
            ? `  (${report.events.unrolledBillableRequests.toLocaleString('en-GB')} not yet aggregated)`
            : '')
        : 'not corroborable — see below'
    }`
  );
  log(
    `  usage_rollup        ${report.rollup.billableRequests.toLocaleString('en-GB')} billable of ` +
      `${report.rollup.requests.toLocaleString('en-GB')} requests across ` +
      `${report.rollup.keyMonths} key-month(s)` +
      (report.rollup.openKeyMonths > 0 ? `, ${report.rollup.openKeyMonths} still open` : '')
  );
  log(
    `  late (never billed) ${report.rollup.lateBillableRequests.toLocaleString('en-GB')} billable of ` +
      `${report.rollup.lateRequests.toLocaleString('en-GB')}`
  );
  log(
    `  invoiced            ${report.invoiced.billableRequests.toLocaleString('en-GB')} billable across ` +
      `${report.invoiced.accounts} account(s), net ${formatMinor(report.invoiced.netMinor)} ` +
      `+ VAT ${formatMinor(report.invoiced.vatMinor)} = ${formatMinor(report.invoiced.grossMinor)} ` +
      BILLING_CURRENCY
  );

  if (pricesMissing) {
    log('');
    log(
      `  NOTE: no price book is configured (${PRICING_DECISION} is open), so the amounts above ` +
        'come from stored drafts if any exist and are zero otherwise. The request figures — ' +
        'which are what this check is about — are unaffected.'
    );
  }

  log('');
  if (report.accounts.length > 0) {
    log('per account (rollup / invoiced / events):');
    for (const account of report.accounts) {
      log(
        `  ${account.ok ? ' ok ' : 'CHECK'}  ${account.accountId}  ` +
          `${account.rollupBillableRequests.toLocaleString('en-GB').padStart(10)} / ` +
          `${(account.invoicedBillableRequests ?? 0).toLocaleString('en-GB').padStart(10)} / ` +
          `${account.eventBillableRequests?.toLocaleString('en-GB').padStart(10) ?? '         -'}` +
          (account.netMinor === null ? '' : `   net ${formatMinor(account.netMinor)}`) +
          (account.blockers > 0 ? `   ${account.blockers} blocker(s)` : '')
      );
    }
    log('');
  }

  if (report.discrepancies.length === 0) {
    log('No discrepancies. Every metered request is accounted for in the aggregate and on an invoice.');
  } else {
    log('differences, each attributed:');
    for (const discrepancy of report.discrepancies) {
      log(
        `  [${discrepancy.blocking ? 'BLOCKING' : 'expected'}] ${discrepancy.kind}` +
          (discrepancy.accountId ? ` (${discrepancy.accountId})` : '') +
          `\n      ${discrepancy.detail}`
      );
    }
  }

  log('');
  log('meter loss window (not measurable from the store):');
  log(`  ${report.meterLossWindow.note}`);

  log('');
  log(
    report.ok
      ? `VERDICT: ${report.yearMonth} reconciles. Every difference has a designed cause.`
      : `VERDICT: ${report.yearMonth} DOES NOT reconcile — see the BLOCKING lines above.`
  );
}

/*
 * ---------------------------------------------------------------------------
 * Entry point — guarded, so the module stays importable by its test
 * ---------------------------------------------------------------------------
 */

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  let store: BillingAdminStore | undefined;
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.command === '' || parsed.command === 'help' || parsed.command === '--help') {
      console.log(USAGE);
      process.exit(0);
    }
    console.log(`billing store: ${resolveApiKeysDbPath()}`);
    store = openBillingStore();
    runCommand({
      store,
      // `resolveProvider` refuses a live credential before returning; the
      // implementation it returns makes no network call either way.
      provider: resolveProvider(),
      parsed,
      env: process.env,
      now: new Date(),
      log: (line) => console.log(line),
    });
  } catch (err) {
    console.error(`\n${(err as Error).message}\n`);
    if (err instanceof BillingCliError) console.error(USAGE);
    process.exitCode = 1;
  } finally {
    store?.close();
  }
}

/** Exported for the test, which drives {@link runCommand} against a real store on a temp file. */
export { createLocalTestProvider, USAGE };
