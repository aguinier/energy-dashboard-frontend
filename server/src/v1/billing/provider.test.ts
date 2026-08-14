import { describe, it, expect } from 'vitest';
import {
  assertTestModeRef,
  assertTestModeSecret,
  createLocalTestProvider,
  isTestModeRef,
  LiveModeRefusedError,
  PROVIDER_SECRET_ENV,
  resolveProvider,
  TEST_REF_PREFIX,
} from './provider.js';

/**
 * "No live keys, no real payments, no customer data" as a property of the code.
 *
 * The guard that matters is the third assertion below: an *unrecognised* secret
 * is refused, not accepted. A denylist of live prefixes alone would pass any
 * credential from a provider nobody thought of, which is the shape this control
 * would fail in — quietly, once, at the worst moment.
 */

describe('assertTestModeSecret', () => {
  it('refuses a live key by name, and says what to do about it', () => {
    for (const secret of ['sk_live_abc123', 'SK_LIVE_ABC', 'rk_live_x', 'pk_live_x', 'live_x']) {
      expect(() => assertTestModeSecret(secret)).toThrow(LiveModeRefusedError);
      expect(() => assertTestModeSecret(secret)).toThrow(/LIVE provider key/);
    }
    // The key has been in the environment of a process that logs; rotating it
    // is part of the remedy and the message says so.
    expect(() => assertTestModeSecret('sk_live_abc')).toThrow(/Revoke that key/);
  });

  it('refuses a credential it cannot classify rather than attempting it', () => {
    // The load-bearing branch. A secret this module cannot classify is one it
    // cannot promise is not live.
    for (const secret of ['abc123', 'whsec_x', 'Bearer nope']) {
      expect(() => assertTestModeSecret(secret)).toThrow(/does not look like a provider test key/);
    }
  });

  it('distinguishes an empty string from an unset variable', () => {
    expect(() => assertTestModeSecret('   ')).toThrow(/empty string/);
  });

  it('accepts a test key', () => {
    for (const secret of ['sk_test_abc', 'rk_test_abc', 'pk_test_abc', 'test_abc']) {
      expect(() => assertTestModeSecret(secret)).not.toThrow();
    }
  });
});

describe('assertTestModeRef', () => {
  it('refuses to let a live identifier become durable', () => {
    expect(() => assertTestModeRef('cus_Nabc123', 'customerRef')).toThrow(LiveModeRefusedError);
    expect(() => assertTestModeRef('cus_Nabc123', 'customerRef')).toThrow(/customerRef/);
    expect(isTestModeRef('cus_Nabc123')).toBe(false);
  });

  it('accepts a test-mode reference', () => {
    expect(() => assertTestModeRef(`${TEST_REF_PREFIX}cus_abc`, 'customerRef')).not.toThrow();
  });
});

describe('createLocalTestProvider', () => {
  const provider = createLocalTestProvider();

  it('is test mode, and there is no implementation that is not', () => {
    expect(provider.mode).toBe('test');
    expect(provider.name).toBe('local-test');
  });

  it('derives references deterministically, so a second run finds one customer not two', () => {
    const first = provider.ensureCustomer({ accountId: 'acct_a', name: 'A' });
    const second = provider.ensureCustomer({ accountId: 'acct_a', name: 'A' });

    expect(first.customerRef).toBe(second.customerRef);
    expect(isTestModeRef(first.customerRef)).toBe(true);
    expect(provider.ensureCustomer({ accountId: 'acct_b', name: 'B' }).customerRef).not.toBe(
      first.customerRef
    );
  });

  it('is idempotent on a usage report, because a doubled usage record is a doubled invoice', () => {
    const { customerRef } = provider.ensureCustomer({ accountId: 'acct_c', name: 'C' });
    const { subscriptionRef } = provider.ensureSubscription({
      accountId: 'acct_c',
      customerRef,
      plan: 'developer',
    });

    const first = provider.reportUsage({ subscriptionRef, yearMonth: '2026-07', billableRequests: 10 });
    const again = provider.reportUsage({ subscriptionRef, yearMonth: '2026-07', billableRequests: 10 });

    expect(first.alreadyPresent).toBe(false);
    expect(again.alreadyPresent).toBe(true);
    expect(again.usageRecordRef).toBe(first.usageRecordRef);
  });

  it('can be read back, which is the pull half of the webhook design', () => {
    const { customerRef } = provider.ensureCustomer({ accountId: 'acct_d', name: 'D' });
    const created = provider.ensureSubscription({
      accountId: 'acct_d',
      customerRef,
      plan: 'professional',
    });
    expect(provider.fetchSubscription(created.subscriptionRef)).toEqual(created);
    expect(provider.fetchSubscription('test_sub_missing')).toBeNull();
  });
});

describe('resolveProvider', () => {
  it('returns the local provider when nothing is configured', () => {
    expect(resolveProvider({} as NodeJS.ProcessEnv).mode).toBe('test');
  });

  it('validates a configured secret before returning, and refuses a live one', () => {
    expect(() =>
      resolveProvider({ [PROVIDER_SECRET_ENV]: 'sk_live_abc' } as NodeJS.ProcessEnv)
    ).toThrow(LiveModeRefusedError);

    // A test secret is accepted and then not used: there is no network client
    // here to use it with, which is the honest state of this issue.
    expect(resolveProvider({ [PROVIDER_SECRET_ENV]: 'sk_test_abc' } as NodeJS.ProcessEnv).name).toBe(
      'local-test'
    );
  });
});
