import { createHash } from 'node:crypto';
import type { SubscriptionStatus } from './subscription.js';

/**
 * The payment-provider seam, and the control that keeps it out of production.
 *
 * ABL-307 is **test mode only: no live keys, no real payments, no customer
 * data**. This module is what makes that a property of the code rather than a
 * sentence in an issue:
 *
 * - {@link assertTestModeSecret} refuses any credential that is not a provider
 *   *test* key, and is called before anything reads one.
 * - {@link assertTestModeRef} refuses to store a customer or subscription
 *   identifier that is not test-mode. `sqliteBillingStore` calls it on write, so
 *   a live identifier cannot arrive through a future code path that forgot.
 * - {@link createLocalTestProvider} makes no network call at all. There is no
 *   HTTP client in this directory and no provider SDK in `package.json`.
 *
 * ## Why the adapter exists at all, given nothing calls a provider
 *
 * Because the shape is the deliverable. Everything a real integration needs from
 * us — a customer, a subscription, a usage figure per closed month, and a way to
 * learn that a payment succeeded — is named in {@link PaymentProvider}, so the
 * work of wiring a provider later is implementing one interface rather than
 * discovering the requirements then. And the last of those four is the one the
 * Board ruled on: it arrives by webhook, a webhook needs public reachability,
 * and this deployment is LAN-only. See `WEBHOOKS-DESIGN.md` beside this file for
 * that path written up as a design with its assumptions stated, which is what
 * the 2026-08-12 ruling asks for and the whole of what this issue does about it.
 */

/** Where a provider credential would be read from. Unset, and it must stay unset. */
export const PROVIDER_SECRET_ENV = 'BILLING_PROVIDER_SECRET';

/**
 * Prefixes that mark a credential as live, across the providers we might use.
 *
 * Matched case-insensitively and as a prefix of the trimmed secret. A denylist
 * rather than an allowlist here — the opposite of the choice `usageStore.ts`
 * makes for query parameters — because the failure directions are opposite: an
 * unrecognised query parameter must not be logged, so absence must mean "no",
 * whereas an unrecognised *credential* must not be used, and the allowlist below
 * ({@link TEST_SECRET_PREFIXES}) is what enforces that. Both lists are checked,
 * so a secret must both fail this one and match that one.
 */
const LIVE_SECRET_PREFIXES = ['sk_live_', 'rk_live_', 'pk_live_', 'live_'] as const;

/** The only shapes a credential may take here. */
const TEST_SECRET_PREFIXES = ['sk_test_', 'rk_test_', 'pk_test_', 'test_'] as const;

export class LiveModeRefusedError extends Error {}

/**
 * Refuse anything that is not a provider test key.
 *
 * Throws {@link LiveModeRefusedError} rather than returning false, because there
 * is no caller that should proceed after this fails, and a boolean invites one.
 * The message names the Board constraint rather than the regex, so an operator
 * who hits it learns why rather than how to satisfy it.
 */
export function assertTestModeSecret(secret: string): void {
  const value = secret.trim();
  const lower = value.toLowerCase();

  if (value === '') {
    throw new LiveModeRefusedError(
      `${PROVIDER_SECRET_ENV} is set to an empty string. Unset it entirely — an empty ` +
        'credential and no credential are different configurations, and only one is deliberate.'
    );
  }

  if (LIVE_SECRET_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    throw new LiveModeRefusedError(
      `${PROVIDER_SECRET_ENV} holds a LIVE provider key. ABL-307 is test mode only: no live ` +
        'keys, no real payments, and no customer data until the Board approves launch and legal ' +
        'review of the subscriber terms is complete (ABL-349 is open). Revoke that key — it has ' +
        'now been in the environment of a process that logs — and use a test key.'
    );
  }

  if (!TEST_SECRET_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    throw new LiveModeRefusedError(
      `${PROVIDER_SECRET_ENV} does not look like a provider test key (expected one of ` +
        `${TEST_SECRET_PREFIXES.join(', ')}). Refused rather than attempted: a credential this ` +
        'module cannot classify is one it cannot promise is not live.'
    );
  }
}

/** Every identifier this module writes carries it, and the store checks for it. */
export const TEST_REF_PREFIX = 'test_';

export function isTestModeRef(ref: string): boolean {
  return ref.startsWith(TEST_REF_PREFIX);
}

export function assertTestModeRef(ref: string, field: string): void {
  if (!isTestModeRef(ref)) {
    throw new LiveModeRefusedError(
      `${field} is "${ref}", which is not a test-mode reference (it must start with ` +
        `"${TEST_REF_PREFIX}"). Storing a live provider identifier would tie an account in this ` +
        'database to a real customer record, which ABL-307 forbids until launch is approved.'
    );
  }
}

/** A provider's view of a subscription, as we would map it back onto ours. */
export interface ProviderSubscription {
  customerRef: string;
  subscriptionRef: string;
  status: SubscriptionStatus;
}

/**
 * Everything a payment provider would have to do for us, and nothing more.
 *
 * Deliberately four methods. The temptation with a provider adapter is to mirror
 * the provider's API; what belongs here is only what *this* product needs, so
 * that swapping providers is an implementation and not a redesign. In
 * particular there is no method for taking a payment: we do not hold card
 * details and never will — the provider's hosted flow does, which is what keeps
 * this system out of PCI scope entirely.
 */
export interface PaymentProvider {
  /** `'local-test'`, or a provider name once one is configured. */
  readonly name: string;
  /** Always `'test'`. There is no implementation that returns anything else. */
  readonly mode: 'test';

  /** Create or find the provider's customer record for one account. */
  ensureCustomer(input: { accountId: string; name: string }): { customerRef: string };

  /** Create or find the subscription that carries the plan and its base fee. */
  ensureSubscription(input: {
    accountId: string;
    customerRef: string;
    plan: string;
  }): ProviderSubscription;

  /**
   * Report a closed month's billable requests as a metered-usage record.
   *
   * Idempotent on `(subscriptionRef, yearMonth)`, because the caller is a CLI an
   * operator may run twice and a doubled usage record is a doubled invoice — the
   * one failure direction the whole metering chain is written to make
   * impossible.
   */
  reportUsage(input: {
    subscriptionRef: string;
    yearMonth: string;
    billableRequests: number;
  }): { usageRecordRef: string; alreadyPresent: boolean };

  /**
   * The provider's current view of a subscription, for the divergence check.
   *
   * A **pull**, deliberately. The push equivalent is the webhook, and a webhook
   * needs a publicly reachable endpoint this deployment does not have and must
   * not acquire (Board ruling 2026-08-12). A reconciliation that polls is
   * strictly weaker — it learns of a failed payment on the next run rather than
   * within seconds — and it is the half that works on a LAN. `WEBHOOKS-DESIGN.md`
   * covers what the push path would need.
   */
  fetchSubscription(subscriptionRef: string): ProviderSubscription | null;
}

/**
 * A provider that exists entirely in this process.
 *
 * References are derived from the account id by hash rather than generated
 * randomly, so a test asserts an exact string and a second run of the CLI
 * produces the same handles instead of a second customer. That determinism is
 * also what makes {@link PaymentProvider.reportUsage}'s idempotency observable
 * without a database.
 */
export function createLocalTestProvider(): PaymentProvider {
  const usageRecords = new Map<string, string>();
  const subscriptions = new Map<string, ProviderSubscription>();

  const ref = (kind: string, seed: string): string =>
    `${TEST_REF_PREFIX}${kind}_${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`;

  return {
    name: 'local-test',
    mode: 'test',

    ensureCustomer({ accountId }) {
      return { customerRef: ref('cus', accountId) };
    },

    ensureSubscription({ accountId, customerRef, plan }) {
      const subscriptionRef = ref('sub', `${accountId}:${plan}`);
      const existing = subscriptions.get(subscriptionRef);
      if (existing) return existing;

      const created: ProviderSubscription = { customerRef, subscriptionRef, status: 'active' };
      subscriptions.set(subscriptionRef, created);
      return created;
    },

    reportUsage({ subscriptionRef, yearMonth, billableRequests }) {
      const key = `${subscriptionRef}:${yearMonth}`;
      const existing = usageRecords.get(key);
      if (existing !== undefined) return { usageRecordRef: existing, alreadyPresent: true };

      const usageRecordRef = ref('mbur', `${key}:${billableRequests}`);
      usageRecords.set(key, usageRecordRef);
      return { usageRecordRef, alreadyPresent: false };
    },

    fetchSubscription(subscriptionRef) {
      return subscriptions.get(subscriptionRef) ?? null;
    },
  };
}

/**
 * Resolve the configured provider.
 *
 * Reads {@link PROVIDER_SECRET_ENV} only to **refuse** it: a configured secret is
 * validated as test-mode and then not used, because there is no network client
 * here to use it with. That is the honest state of this issue — the seam exists,
 * the guard exists, and the only implementation is local. A future issue that
 * adds a real client changes this function and nothing else in the directory.
 */
export function resolveProvider(env: NodeJS.ProcessEnv = process.env): PaymentProvider {
  const secret = env[PROVIDER_SECRET_ENV];
  if (secret !== undefined) assertTestModeSecret(secret);
  return createLocalTestProvider();
}
