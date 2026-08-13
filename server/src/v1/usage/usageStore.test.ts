import { describe, it, expect } from 'vitest';
import {
  canonicaliseQuery,
  DEFAULT_RETENTION_POLICY,
  isBillableStatus,
  LOGGED_QUERY_PARAMETERS,
  MAX_LOGGED_PARAMETER_VALUE_LENGTH,
  monthEndExclusive,
  requestFingerprint,
  resolveRetentionPolicy,
  subtractDays,
  subtractMonths,
  yearMonthOf,
} from './usageStore.js';

/**
 * The pure half of metering: what may be recorded, what is charged for, and the
 * calendar the invoice is cut on.
 *
 * Every function here decides something a customer could be shown, so the cases
 * are written as the claim they support rather than as coverage. The store's own
 * behaviour is in `sqliteUsageStore.test.ts`, against a real file.
 */

describe('isBillableStatus — every exclusion is a deliberate under-count', () => {
  it('charges for 2xx and nothing else', () => {
    expect(isBillableStatus(200)).toBe(true);
    expect(isBillableStatus(206)).toBe(true);
    expect(isBillableStatus(299)).toBe(true);
  });

  it('does not charge for a 4xx — the caller made a mistake, and we log it instead', () => {
    // Still counted toward the rate limit, which is ABL-302's to enforce, so a
    // broken client cannot turn errors into free unlimited traffic.
    expect(isBillableStatus(400)).toBe(false);
    expect(isBillableStatus(401)).toBe(false);
    expect(isBillableStatus(429)).toBe(false);
  });

  it('never charges for a 5xx, which is our fault', () => {
    expect(isBillableStatus(500)).toBe(false);
    expect(isBillableStatus(503)).toBe(false);
  });

  it('does not charge for a 3xx, where no data was served', () => {
    // A 304 returns an empty body. If ABL-303 adds conditional requests and we
    // decide a validated cache hit is billable, that is a deliberate edit here
    // with a test attached — not a reinterpretation of what old rows meant.
    expect(isBillableStatus(304)).toBe(false);
  });
});

describe('canonicaliseQuery — an allowlist, which is the whole privacy control', () => {
  it('records the allowlisted market-data parameters', () => {
    expect(canonicaliseQuery({ country: 'BE', horizon: '24' })).toBe('country=BE&horizon=24');
  });

  it('drops anything nobody listed, which is how a future free-text parameter stays out', () => {
    // ABL-297 §9(4): the parameter that has not been thought about is the one
    // that carries a customer identifier. A denylist would depend on somebody
    // remembering at the moment they add the feature; this makes the mistake
    // unrepresentable rather than unlikely.
    expect(canonicaliseQuery({ q: 'find me everything about acme corp' })).toBeNull();
    expect(canonicaliseQuery({ email: 'someone@example.com', country: 'FR' })).toBe('country=FR');
    expect(canonicaliseQuery({ customer_ref: 'INV-2026-0042' })).toBeNull();
  });

  it('sorts by name, so the same logical call always produces the same string', () => {
    // This is what makes the fingerprint able to recognise a retry that sent its
    // parameters in a different order.
    expect(canonicaliseQuery({ horizon: '24', country: 'BE' })).toBe(
      canonicaliseQuery({ country: 'BE', horizon: '24' })
    );
  });

  it('joins a repeated parameter rather than dropping or duplicating it', () => {
    expect(canonicaliseQuery({ countries: ['BE', 'FR', 'DE'] })).toBe('countries=BE,FR,DE');
  });

  it('caps a value, so an allowlisted parameter cannot become a free-text store', () => {
    const long = 'x'.repeat(MAX_LOGGED_PARAMETER_VALUE_LENGTH * 3);
    const recorded = canonicaliseQuery({ model: long });

    expect(recorded).toBe(`model=${'x'.repeat(MAX_LOGGED_PARAMETER_VALUE_LENGTH)}`);
    expect(recorded!.length).toBeLessThan(long.length);
  });

  it('drops a nested or non-scalar value rather than rendering it', () => {
    // `qs` yields these for `?country[a]=b`. A value we cannot render as a short
    // scalar is a value we have not thought about.
    expect(canonicaliseQuery({ country: { nested: 'BE' } })).toBeNull();
    expect(canonicaliseQuery({ country: [{ nested: 'BE' }] })).toBeNull();
  });

  it('returns null rather than an empty string when nothing survives', () => {
    // "No parameters" and "parameters we chose not to record" are the same fact
    // in the column, and they should be the same value.
    expect(canonicaliseQuery({})).toBeNull();
    expect(canonicaliseQuery(undefined)).toBeNull();
    expect(canonicaliseQuery({ unlisted: 'x' })).toBeNull();
  });

  it('keeps the allowlist to market-data parameters only', () => {
    // A guard on the list itself. If somebody adds `q`, `search`, `email`,
    // `name` or `ref` to it, that is a privacy decision and this fails until it
    // is made deliberately.
    const suspicious = ['q', 'search', 'query', 'email', 'name', 'ref', 'user', 'id', 'filter'];
    expect(LOGGED_QUERY_PARAMETERS.filter((p) => suspicious.includes(p))).toEqual([]);
  });
});

describe('requestFingerprint — what makes honouring Idempotency-Key safe', () => {
  it('is stable for the same logical call', () => {
    expect(requestFingerprint('GET', '/v1/observations/load', 'country=BE')).toBe(
      requestFingerprint('get', '/v1/observations/load', 'country=BE')
    );
  });

  it('differs when the route or the parameters differ', () => {
    const load = requestFingerprint('GET', '/v1/observations/load', 'country=BE');
    expect(load).not.toBe(requestFingerprint('GET', '/v1/observations/price', 'country=BE'));
    expect(load).not.toBe(requestFingerprint('GET', '/v1/observations/load', 'country=FR'));
    expect(load).not.toBe(requestFingerprint('HEAD', '/v1/observations/load', 'country=BE'));
  });

  it('does not carry the parameters in the clear', () => {
    // Hashed so the column cannot become a second, un-allowlisted copy of the
    // request.
    expect(requestFingerprint('GET', '/v1/observations/load', 'country=BE')).toMatch(
      /^[0-9a-f]{64}$/
    );
  });
});

describe('resolveRetentionPolicy — published numbers, read from configuration', () => {
  it('defaults to the ABL-297 §5 commitments', () => {
    expect(resolveRetentionPolicy({} as NodeJS.ProcessEnv)).toEqual(DEFAULT_RETENTION_POLICY);
    expect(DEFAULT_RETENTION_POLICY.piiDays).toBe(90);
    expect(DEFAULT_RETENTION_POLICY.eventMonths).toBe(13);
  });

  it('takes the periods from the environment, so counsel changing 90 is a config change', () => {
    // ABL-297 §5 requires this in terms: "a config change and not a migration".
    const policy = resolveRetentionPolicy({
      USAGE_PII_RETENTION_DAYS: '30',
      USAGE_EVENT_RETENTION_MONTHS: '24',
    } as NodeJS.ProcessEnv);

    expect(policy.piiDays).toBe(30);
    expect(policy.eventMonths).toBe(24);
  });

  it('refuses a value it cannot read rather than falling back to a default nobody chose', () => {
    for (const bad of ['0', '-1', 'ninety', '90.5', '']) {
      if (bad === '') continue; // empty means "unset", which is the default path
      expect(() =>
        resolveRetentionPolicy({ USAGE_PII_RETENTION_DAYS: bad } as NodeJS.ProcessEnv)
      ).toThrow(/USAGE_PII_RETENTION_DAYS/);
    }
  });

  it('treats an empty value as unset', () => {
    expect(
      resolveRetentionPolicy({ USAGE_PII_RETENTION_DAYS: '   ' } as NodeJS.ProcessEnv).piiDays
    ).toBe(90);
  });

  it('refuses a configuration where rows would be deleted before they were scrubbed', () => {
    // More private, and still wrong: §5 states two distinct periods to two
    // different audiences, and an implementation that collapses them makes one
    // of those published statements false.
    expect(() =>
      resolveRetentionPolicy({
        USAGE_PII_RETENTION_DAYS: '400',
        USAGE_EVENT_RETENTION_MONTHS: '1',
      } as NodeJS.ProcessEnv)
    ).toThrow(/shorter than/);
  });
});

describe('the billing calendar is UTC, and calendar-aware', () => {
  it('takes the month from received_at in UTC', () => {
    expect(yearMonthOf('2026-07-31T23:59:59.999Z')).toBe('2026-07');
    // The instant one millisecond later is a different invoice, for every
    // customer in every timezone. A month boundary that moved per customer
    // would make two invoices for the same traffic disagree.
    expect(yearMonthOf('2026-08-01T00:00:00.000Z')).toBe('2026-08');
  });

  it('ends a month at the first instant of the next one', () => {
    expect(monthEndExclusive('2026-07').toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(monthEndExclusive('2026-12').toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('subtracts whole calendar months, clamping to the end of the target month', () => {
    // 13 months is what ABL-297 §5 publishes; 13 x 30.44 days is a number
    // nobody agreed to.
    expect(subtractMonths(new Date('2026-03-31T12:00:00Z'), 1).toISOString()).toBe(
      '2026-02-28T12:00:00.000Z'
    );
    expect(subtractMonths(new Date('2024-03-31T12:00:00Z'), 1).toISOString()).toBe(
      '2024-02-29T12:00:00.000Z'
    );
    expect(subtractMonths(new Date('2026-08-12T00:00:00Z'), 13).toISOString()).toBe(
      '2025-07-12T00:00:00.000Z'
    );
  });

  it('subtracts days as exact days', () => {
    expect(subtractDays(new Date('2026-08-12T00:00:00Z'), 90).toISOString()).toBe(
      '2026-05-14T00:00:00.000Z'
    );
  });
});
