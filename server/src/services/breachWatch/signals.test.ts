import { describe, it, expect } from 'vitest';
import {
  detectBreachSignals,
  PROVISIONAL_MIN_PREFIXES_PER_ORIGIN,
  type BreachSignalInputs,
} from './signals.js';
import type {
  KeyOriginRow,
  OriginFailureRow,
  SecretHolderFailureRow,
} from '../../v1/security/authFailureStore.js';

/**
 * Positive and negative controls for the ABL-578 detector.
 *
 * ABL-578 puts it plainly: *"A detector that cannot fire is worse than none,
 * because it reads as coverage. We have shipped one of those before, so this is
 * not hypothetical."* So the first block below synthesises each attack shape and
 * proves the watcher trips, and the second synthesises ordinary traffic — a
 * customer with a stale key, a user mistyping a secret, a redeploy, a shared key
 * — and proves it stays silent.
 *
 * The negative control is the one that decides whether this is usable. An alarm
 * that fires on a support ticket gets muted within a week, and a muted alarm is
 * the state ABL-524 §"Where an alarm rings" was written to avoid.
 */

const WINDOW = { since: '2026-08-26T00:00:00.000Z', until: '2026-08-27T00:00:00.000Z' };
const LOOKBACK = '2026-07-28T00:00:00.000Z';

function inputs(overrides: Partial<BreachSignalInputs> = {}): BreachSignalInputs {
  return {
    window: WINDOW,
    byOrigin: [],
    secretHolderRows: [],
    keyOriginRows: [],
    originLookbackSince: LOOKBACK,
    minPrefixesPerOrigin: PROVISIONAL_MIN_PREFIXES_PER_ORIGIN,
    ...overrides,
  };
}

function secretHolder(overrides: Partial<SecretHolderFailureRow> = {}): SecretHolderFailureRow {
  return {
    keyId: 'key_live_001',
    accountId: 'acct_001',
    presentedPrefix: 'a1b2c3d4',
    errorCode: 'key_revoked',
    clientIp: '203.0.113.9',
    failures: 4,
    firstAt: '2026-08-26T02:00:00.000Z',
    lastAt: '2026-08-26T02:40:00.000Z',
    originServedRequests: 0,
    usageHistoryFrom: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function origin(overrides: Partial<OriginFailureRow> = {}): OriginFailureRow {
  return {
    clientIp: '198.51.100.7',
    failures: 12,
    distinctPrefixes: 1,
    errorCodes: 'key_invalid',
    secretVerifiedFailures: 0,
    firstAt: '2026-08-26T01:00:00.000Z',
    lastAt: '2026-08-26T01:05:00.000Z',
    ...overrides,
  };
}

function keyOrigin(overrides: Partial<KeyOriginRow> = {}): KeyOriginRow {
  return {
    keyId: 'key_live_001',
    accountId: 'acct_001',
    clientIp: '192.0.2.10',
    requests: 500,
    firstAt: '2026-06-01T00:00:00.000Z',
    lastAt: '2026-08-26T23:00:00.000Z',
    ...overrides,
  };
}

describe('positive control — the watcher trips on each Tier 1 attack shape', () => {
  it('S4: a revoked key presented from an origin it was never served from', () => {
    const findings = detectBreachSignals(
      inputs({ secretHolderRows: [secretHolder()] })
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].signal).toBe('S4');
    expect(findings[0].basis).toBe('abl-524');
    expect(findings[0].subject).toBe('key_live_001');
    expect(findings[0].magnitude).toBe(4);
    expect(findings[0].evidence.join('\n')).toContain('origin_never_served');
  });

  it('S4: a real secret for a key we hold no successful addressed history for', () => {
    const findings = detectBreachSignals(
      inputs({
        secretHolderRows: [
          secretHolder({ errorCode: 'key_expired', usageHistoryFrom: null, originServedRequests: 0 }),
        ],
      })
    );

    expect(findings.map((f) => f.signal)).toEqual(['S4']);
    expect(findings[0].evidence.join('\n')).toContain('no_usage_history');
  });

  it('S4: one credential exercised from many addresses is ONE incident, not many', () => {
    // The alarm is about the credential, not about each packet's source. Twenty
    // addresses trying one stolen key must not become twenty priority:high issues.
    const findings = detectBreachSignals(
      inputs({
        secretHolderRows: [
          secretHolder({ clientIp: '203.0.113.1', failures: 3 }),
          secretHolder({ clientIp: '203.0.113.2', failures: 5 }),
          secretHolder({ clientIp: '203.0.113.3', failures: 7 }),
        ],
      })
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].incidentKey).toBe('s4:key_live_001');
    expect(findings[0].magnitude).toBe(15);
    expect(findings[0].evidence).toHaveLength(3);
    expect(findings[0].headline).toContain('3 address(es)');
  });

  it('S2: a new origin appears while the old one keeps running', () => {
    const findings = detectBreachSignals(
      inputs({
        keyOriginRows: [
          // The original, still active through the whole period.
          keyOrigin({ clientIp: '192.0.2.10', lastAt: '2026-08-26T23:00:00.000Z' }),
          // The newcomer, inside the lookback.
          keyOrigin({
            clientIp: '203.0.113.50',
            requests: 120,
            firstAt: '2026-08-20T00:00:00.000Z',
            lastAt: '2026-08-26T22:00:00.000Z',
          }),
        ],
      })
    );

    expect(findings.map((f) => f.signal)).toEqual(['S2']);
    expect(findings[0].basis).toBe('abl-524');
    expect(findings[0].incidentKey).toBe('s2:key_live_001');
    expect(findings[0].magnitude).toBe(120);
    expect(findings[0].evidence.join('\n')).toContain('NEW 203.0.113.50');
  });

  it('S3: one address walking the key space', () => {
    const findings = detectBreachSignals(
      inputs({
        byOrigin: [
          origin({ clientIp: '203.0.113.77', failures: 940, distinctPrefixes: 940 }),
        ],
      })
    );

    expect(findings.map((f) => f.signal)).toEqual(['S3']);
    expect(findings[0].subject).toBe('203.0.113.77');
    expect(findings[0].magnitude).toBe(940);
    // The provenance of the cutoff travels with the finding, so the incident body
    // can say the confidence is not S4's. ABL-524 §2 S3 states a shape, not a number.
    expect(findings[0].basis).toBe('provisional');
  });

  it('S3 fires exactly at the configured cutoff and not one below it', () => {
    const at = detectBreachSignals(
      inputs({ byOrigin: [origin({ distinctPrefixes: 10 })], minPrefixesPerOrigin: 10 })
    );
    const below = detectBreachSignals(
      inputs({ byOrigin: [origin({ distinctPrefixes: 9 })], minPrefixesPerOrigin: 10 })
    );

    expect(at).toHaveLength(1);
    expect(below).toHaveLength(0);
  });

  it('orders findings by specificity: the ones needing no calibration first', () => {
    const findings = detectBreachSignals(
      inputs({
        byOrigin: [origin({ clientIp: '203.0.113.77', distinctPrefixes: 940 })],
        secretHolderRows: [secretHolder()],
        keyOriginRows: [
          keyOrigin({ clientIp: '192.0.2.10' }),
          keyOrigin({
            clientIp: '203.0.113.50',
            firstAt: '2026-08-20T00:00:00.000Z',
            lastAt: '2026-08-26T22:00:00.000Z',
          }),
        ],
      })
    );

    expect(findings.map((f) => f.signal)).toEqual(['S4', 'S2', 'S3']);
  });
});

describe('negative control — ordinary traffic does not trip it', () => {
  it('a user mistyping their secret does not trip anything', () => {
    // A typo is in the *secret* segment, so the prefix on the wire is unchanged
    // and the refusal happens before `secretMatchesHash` succeeds. Volume rises;
    // distinct prefixes do not. That is the whole reason S3 counts prefixes
    // rather than 401s (ABL-524 §2 S3: raw volume is noise).
    const findings = detectBreachSignals(
      inputs({
        byOrigin: [
          origin({ clientIp: '198.51.100.7', failures: 350, distinctPrefixes: 1 }),
        ],
      })
    );

    expect(findings).toEqual([]);
  });

  it('a customer whose key was rotated, retrying forever, does not trip anything', () => {
    // The largest raw count on the page and the least interesting row on it.
    const findings = detectBreachSignals(
      inputs({
        byOrigin: [
          origin({
            clientIp: '198.51.100.7',
            failures: 8_640,
            distinctPrefixes: 1,
            errorCodes: 'key_invalid',
          }),
        ],
      })
    );

    expect(findings).toEqual([]);
  });

  it('a stale key presented from the address it has always been served from stays quiet', () => {
    // S4 with `origin_known`: a real secret, but from the caller's own address.
    // Overwhelmingly a customer with an old credential in their config — a
    // support ticket, and the most likely benign shape on this table.
    const findings = detectBreachSignals(
      inputs({
        secretHolderRows: [
          secretHolder({ originServedRequests: 4_211, usageHistoryFrom: '2026-06-01T00:00:00.000Z' }),
        ],
      })
    );

    expect(findings).toEqual([]);
  });

  it('does not alarm on our own retention job scrubbing the address', () => {
    // `origin_unknown`: the refusal row's IP was nulled at 90 days, so "never
    // served from here" cannot be asked. Firing would make the alarm rate a
    // function of how long an investigation has been running.
    const findings = detectBreachSignals(
      inputs({
        secretHolderRows: [
          secretHolder({ clientIp: null, originServedRequests: null }),
        ],
      })
    );

    expect(findings).toEqual([]);
  });

  it('a customer redeploying — old origin stops, new one starts — does not trip S2', () => {
    const findings = detectBreachSignals(
      inputs({
        keyOriginRows: [
          keyOrigin({ clientIp: '192.0.2.10', lastAt: '2026-08-19T12:00:00.000Z' }),
          keyOrigin({
            clientIp: '203.0.113.50',
            firstAt: '2026-08-20T00:00:00.000Z',
            lastAt: '2026-08-26T23:00:00.000Z',
          }),
        ],
      })
    );

    expect(findings).toEqual([]);
  });

  it('a key shared across a steady fleet does not trip S2 (AUP §3.4, not a breach)', () => {
    const findings = detectBreachSignals(
      inputs({
        keyOriginRows: [
          keyOrigin({ clientIp: '192.0.2.10' }),
          keyOrigin({ clientIp: '192.0.2.11' }),
          keyOrigin({ clientIp: '192.0.2.12' }),
        ],
      })
    );

    expect(findings).toEqual([]);
  });

  it('a newly issued key does not trip S2 on its own first origin', () => {
    // `no_history`: the key's retained history *begins* with that origin, so
    // "new" is unfalsifiable. A recently issued key and a fully scrubbed one look
    // identical here, and neither is a finding.
    const findings = detectBreachSignals(
      inputs({
        keyOriginRows: [
          keyOrigin({
            keyId: 'key_live_new',
            clientIp: '203.0.113.60',
            firstAt: '2026-08-25T00:00:00.000Z',
            lastAt: '2026-08-26T23:00:00.000Z',
          }),
        ],
      })
    );

    expect(findings).toEqual([]);
  });

  it('an unattributable pile of scrubbed failures is not manufactured into enumeration', () => {
    // Every row whose address was nulled groups under one NULL bucket, whose
    // prefix count is the sum of everybody's. Counting it would be a finding we
    // invented rather than detected.
    const findings = detectBreachSignals(
      inputs({
        byOrigin: [origin({ clientIp: null, failures: 5_000, distinctPrefixes: 4_000 })],
      })
    );

    expect(findings).toEqual([]);
  });

  it('an entirely quiet window produces nothing', () => {
    expect(detectBreachSignals(inputs())).toEqual([]);
  });
});

describe('idempotency contract', () => {
  it('the incident key is stable while the attack grows', () => {
    // The key is what stops a sustained attack from opening a fresh priority:high
    // issue every tick, so it must not move when the counts do.
    const first = detectBreachSignals(inputs({ secretHolderRows: [secretHolder({ failures: 4 })] }));
    const later = detectBreachSignals(inputs({ secretHolderRows: [secretHolder({ failures: 900 })] }));

    expect(first[0].incidentKey).toBe(later[0].incidentKey);
    expect(first[0].magnitude).not.toBe(later[0].magnitude);
  });

  it('different subjects get different keys', () => {
    const findings = detectBreachSignals(
      inputs({
        secretHolderRows: [
          secretHolder({ keyId: 'key_live_001' }),
          secretHolder({ keyId: 'key_live_002' }),
        ],
      })
    );

    expect(new Set(findings.map((f) => f.incidentKey)).size).toBe(2);
  });
});
