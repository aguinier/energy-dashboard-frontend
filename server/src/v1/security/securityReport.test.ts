import { describe, it, expect } from 'vitest';
import {
  classifyFingerprintBreadth,
  classifyKeyOrigins,
  classifySecretHolderFailures,
  renderEnumerationReport,
  renderFingerprintBreadthReport,
  renderKeyOriginReport,
  renderSecretHolderReport,
  SCRUBBED,
} from './securityReport.js';
import type {
  KeyFingerprintRow,
  KeyOriginRow,
  SecretHolderFailureRow,
} from './authFailureStore.js';

/**
 * The judgement, without a database in front of it.
 *
 * Most of what is asserted here is a *refusal to conclude*. Three of the four
 * signals turn on a distinction that a naive implementation collapses — "we no
 * longer remember" read as "never seen from here", "no baseline" read as a
 * breadth of zero — and each collapse produces the most alarming reading
 * available. Those are the cases that would name an innocent customer as a
 * credential thief at three in the morning, so they get the most tests.
 */

const DAY = 86_400_000;
const at = (offsetDays: number): string =>
  new Date(Date.parse('2026-08-22T00:00:00.000Z') + offsetDays * DAY).toISOString();

function origin(over: Partial<KeyOriginRow> = {}): KeyOriginRow {
  return {
    keyId: 'key_a',
    accountId: 'acct_1',
    clientIp: '192.0.2.10',
    requests: 100,
    firstAt: at(-60),
    lastAt: at(-1),
    ...over,
  };
}

describe('S2 — a key used from an origin it has never been used from', () => {
  const since = at(-7);

  it('flags a new origin while the old one keeps running', () => {
    // The stolen-credential shape: two places, one of which did not know about
    // the other.
    const [finding] = classifyKeyOrigins(
      [
        origin({ clientIp: '192.0.2.10', firstAt: at(-60), lastAt: at(-1) }),
        origin({ clientIp: '198.51.100.7', firstAt: at(-3), lastAt: at(-1) }),
      ],
      since
    );

    expect(finding.verdict).toBe('new_origin_while_old_continues');
    expect(finding.newOrigins.map((row) => row.clientIp)).toEqual(['198.51.100.7']);
  });

  it('calls it moved when the old origin had already stopped', () => {
    // A customer redeploying. Same raw shape as above, opposite reading, and the
    // only thing separating them is whether the old origin was still live when
    // the new one arrived.
    const [finding] = classifyKeyOrigins(
      [
        origin({ clientIp: '192.0.2.10', firstAt: at(-60), lastAt: at(-5) }),
        origin({ clientIp: '198.51.100.7', firstAt: at(-3), lastAt: at(-1) }),
      ],
      since
    );

    expect(finding.verdict).toBe('moved');
  });

  it('refuses to call an origin new when there is no history to be new against', () => {
    // **The 90-day constraint, and the reason this verdict exists.** A key whose
    // whole retained history starts with this origin — because it was issued
    // last week, or because everything older was scrubbed — cannot support the
    // claim "never used from here before". Reporting it as new would make a
    // long-dormant key's first reuse read as theft.
    const [finding] = classifyKeyOrigins(
      [origin({ clientIp: '198.51.100.7', firstAt: at(-3), lastAt: at(-1) })],
      since
    );

    expect(finding.verdict).toBe('no_history');
    expect(finding.priorHistoryMs).toBe(0);
  });

  it('separates steady key sharing from theft, because they are different documents', () => {
    // Several origins, none of them new. AUP §3.4 — a commercial conversation,
    // not a breach candidate.
    const [finding] = classifyKeyOrigins(
      [
        origin({ clientIp: '192.0.2.10', firstAt: at(-60), lastAt: at(-1) }),
        origin({ clientIp: '192.0.2.11', firstAt: at(-55), lastAt: at(-1) }),
      ],
      since
    );

    expect(finding.verdict).toBe('multiple_origins_steady');
  });

  it('reports a single unchanged origin as exactly that', () => {
    expect(classifyKeyOrigins([origin()], since)[0].verdict).toBe('single_origin');
  });

  it('groups per key and puts the finding first', () => {
    const findings = classifyKeyOrigins(
      [
        origin({ keyId: 'key_quiet' }),
        origin({ keyId: 'key_hot', clientIp: '192.0.2.10', firstAt: at(-60), lastAt: at(-1) }),
        origin({ keyId: 'key_hot', clientIp: '198.51.100.7', firstAt: at(-2), lastAt: at(-1) }),
      ],
      since
    );

    expect(findings.map((f) => f.keyId)).toEqual(['key_hot', 'key_quiet']);
    expect(findings[0].verdict).toBe('new_origin_while_old_continues');
  });

  it('reports how much prior history a "moved" verdict actually rests on', () => {
    // Four minutes of history and eighty days of it produce the same verdict,
    // and they are not the same evidence.
    const [thin] = classifyKeyOrigins(
      [
        origin({ clientIp: '192.0.2.10', firstAt: at(-8), lastAt: at(-8) }),
        origin({ clientIp: '198.51.100.7', firstAt: at(-3), lastAt: at(-1) }),
      ],
      since
    );

    expect(thin.verdict).toBe('moved');
    expect(thin.priorHistoryMs).toBe(5 * DAY);
    expect(renderKeyOriginReport(since, [thin], 90).join('\n')).toContain('120h of prior history');
  });

  it('says what it can and cannot see, in the words a reader gets', () => {
    const lines = renderKeyOriginReport(since, classifyKeyOrigins([], since), 90).join('\n');

    expect(lines).toContain('Address history retained: 90 days');
    expect(lines).not.toMatch(/never/i);
  });
});

function holder(over: Partial<SecretHolderFailureRow> = {}): SecretHolderFailureRow {
  return {
    keyId: 'key_a',
    accountId: 'acct_1',
    presentedPrefix: '7f3a9c21',
    errorCode: 'key_revoked',
    clientIp: '198.51.100.7',
    failures: 3,
    firstAt: at(-2),
    lastAt: at(-1),
    originServedRequests: 0,
    usageHistoryFrom: at(-60),
    ...over,
  };
}

describe('S4 — a refusal by somebody who held a real secret', () => {
  it('names an origin the key was never served from', () => {
    // Close to proof the credential is in someone else's hands — and if the key
    // was revoked *because* it leaked, confirmation the leak is being exercised.
    const [finding] = classifySecretHolderFailures([holder()]);

    expect(finding.verdict).toBe('origin_never_served');
    expect(renderSecretHolderReport({ since: at(-30), until: at(0) }, [finding]).join('\n')).toContain(
      'has never been served from that address'
    );
  });

  it('does not flag the address the key has actually been used from', () => {
    expect(classifySecretHolderFailures([holder({ originServedRequests: 412 })])[0].verdict).toBe(
      'origin_known'
    );
  });

  it('a scrubbed address is "cannot ask", never "never seen from here"', () => {
    // **The trap this whole column exists for.** `COUNT(*)` joined on a NULL
    // address returns 0, which is byte-identical to "never served from here" —
    // the most alarming verdict on the page, manufactured by three-valued logic.
    const [finding] = classifySecretHolderFailures([
      holder({ clientIp: null, originServedRequests: null }),
    ]);

    expect(finding.verdict).toBe('origin_unknown');

    const rendered = renderSecretHolderReport({ since: at(-30), until: at(0) }, [finding]).join('\n');
    expect(rendered).toContain('scrubbed at 90 days');
    expect(rendered).toContain(SCRUBBED);
    expect(rendered).not.toContain('has never been served');
  });

  it('a key with no addressed history at all is its own state', () => {
    // A key that has *only* ever failed has no successful traffic to compare
    // against. Worth a look, and not the same claim as "used from a new place".
    const [finding] = classifySecretHolderFailures([holder({ usageHistoryFrom: null })]);

    expect(finding.verdict).toBe('no_usage_history');
    expect(
      renderSecretHolderReport({ since: at(-30), until: at(0) }, [finding]).join('\n')
    ).toContain('Not a negative finding.');
  });

  it('puts the findings above the benign rows', () => {
    const findings = classifySecretHolderFailures([
      holder({ keyId: 'key_ok', originServedRequests: 9 }),
      holder({ keyId: 'key_unknown', clientIp: null, originServedRequests: null }),
      holder({ keyId: 'key_bad' }),
    ]);

    expect(findings.map((f) => f.verdict)).toEqual([
      'origin_never_served',
      'origin_unknown',
      'origin_known',
    ]);
  });

  it('says plainly that nothing was found, rather than printing an empty table', () => {
    const lines = renderSecretHolderReport({ since: at(-30), until: at(0) }, []).join('\n');

    expect(lines).toContain('None.');
    expect(lines).toContain('after the secret had matched');
  });
});

function breadth(over: Partial<KeyFingerprintRow> = {}): KeyFingerprintRow {
  return {
    keyId: 'key_a',
    accountId: 'acct_1',
    recentFingerprints: 40,
    recentRequests: 400,
    baselineFingerprints: 10,
    baselineRequests: 5_000,
    ...over,
  };
}

describe('S5 — use turning into extraction', () => {
  it('reports the ratio against the key’s own baseline', () => {
    const [finding] = classifyFingerprintBreadth([breadth()]);

    expect(finding.verdict).toBe('comparable');
    expect(finding.breadthRatio).toBe(4);
  });

  it('a key with no baseline is onboarding, not extraction', () => {
    // ABL-524 §2 names this exactly: a new subscriber's first week looks like
    // extraction against a *global* baseline and like onboarding against their
    // own.
    const [finding] = classifyFingerprintBreadth([
      breadth({ baselineFingerprints: 0, baselineRequests: 0 }),
    ]);

    expect(finding.verdict).toBe('onboarding');
    // Not `Infinity`, and not a large number that would sort it to the top of a
    // page an investigator reads as a ranking of suspicion.
    expect(finding.breadthRatio).toBeNull();
    expect(
      renderFingerprintBreadthReport({ since: at(-7), until: at(0) }, at(-30), [finding]).join('\n')
    ).toContain('no baseline (onboarding)');
  });

  it('grades nothing — there is no cutoff anywhere in the output', () => {
    // The rule this module is written to. `METRIC_THRESHOLDS` graded forecast
    // error against uncalibrated cutoffs and stamped 24 countries "Needs
    // Improvement" from 9.9% to 76.8%. There is no live traffic on this surface
    // at all, so any multiple picked here would be invented — and then read at
    // 3am as though it meant something.
    const findings = classifyFingerprintBreadth([
      breadth({ keyId: 'key_wide', recentFingerprints: 4_000 }),
      breadth({ keyId: 'key_narrow', recentFingerprints: 2 }),
    ]);
    const lines = renderFingerprintBreadthReport(
      { since: at(-7), until: at(0) },
      at(-30),
      findings
    ).join('\n');

    expect(lines).not.toMatch(/\b(suspicious|anomal|alert|breach|exceed)/i);
    expect(lines).toContain('deliberately not graded');
    // It says the windows are different lengths, because the ratio is not
    // normalised and a reader dividing 7 days by 30 should know that.
    expect(lines).toContain('not normalised');
  });

  it('orders by ratio, with the un-gradeable rows last rather than first', () => {
    const findings = classifyFingerprintBreadth([
      breadth({ keyId: 'key_new', baselineFingerprints: 0, baselineRequests: 0 }),
      breadth({ keyId: 'key_low', recentFingerprints: 5 }),
      breadth({ keyId: 'key_high', recentFingerprints: 100 }),
    ]);

    expect(findings.map((f) => f.keyId)).toEqual(['key_high', 'key_low', 'key_new']);
  });
});

describe('S3 — the enumeration report', () => {
  const window = { since: at(-1), until: at(0) };

  it('prints both groupings and the reading guide, and no verdict', () => {
    // Deliberately unjudged: what separates signal from noise here is rate and
    // persistence, which is exactly what nobody can calibrate on a surface with
    // no traffic. The orderings are the contribution.
    const lines = renderEnumerationReport(
      window,
      [
        {
          clientIp: '198.51.100.7',
          failures: 900,
          distinctPrefixes: 900,
          errorCodes: 'key_invalid',
          secretVerifiedFailures: 0,
          firstAt: at(-1),
          lastAt: at(0),
        },
      ],
      [
        {
          presentedPrefix: '7f3a9c21',
          failures: 40,
          distinctOrigins: 12,
          errorCodes: 'key_invalid,key_revoked',
          firstAt: at(-1),
          lastAt: at(0),
        },
      ]
    ).join('\n');

    expect(lines).toContain('By origin');
    expect(lines).toContain('By presented prefix');
    expect(lines).toContain('someone is guessing at our key space');
    expect(lines).toContain('a leaked key tried by several parties');
    expect(lines).toContain('these are shapes, not thresholds');
  });

  it('writes a scrubbed origin as scrubbed and a missing prefix as none', () => {
    // Two absences that mean different things: an address we deleted at 90 days,
    // and a caller who sent no key at all. A blank cell for either would be a
    // third, false, claim.
    const lines = renderEnumerationReport(
      window,
      [
        {
          clientIp: null,
          failures: 4,
          distinctPrefixes: 0,
          errorCodes: 'key_missing',
          secretVerifiedFailures: 0,
          firstAt: at(-1),
          lastAt: at(0),
        },
      ],
      [
        {
          presentedPrefix: null,
          failures: 4,
          distinctOrigins: 1,
          errorCodes: 'key_missing',
          firstAt: at(-1),
          lastAt: at(0),
        },
      ]
    ).join('\n');

    expect(lines).toContain(SCRUBBED);
    expect(lines).toContain('(none)');
  });

  it('says nothing happened rather than printing empty headings', () => {
    expect(renderEnumerationReport(window, [], []).join('\n')).toContain(
      'No authentication failures in this window.'
    );
  });

  it('caps each table and says how many rows it did not show', () => {
    // Found by running the command rather than by reasoning about it: the very
    // shape this report exists to surface produces one row *per guessed prefix*,
    // so a 900-prefix enumeration pushed the finding nine hundred lines off the
    // top of a terminal. The flood is the signal, and printing all of it hides it.
    //
    // A silent truncation on a security report would be the worse defect, so the
    // count and the total are on their own line.
    const prefixes = Array.from({ length: 60 }, (_, i) => ({
      presentedPrefix: `gs${String(i).padStart(6, '0')}`,
      failures: 1,
      distinctOrigins: 1,
      errorCodes: 'key_invalid',
      firstAt: at(-1),
      lastAt: at(0),
    }));

    const lines = renderEnumerationReport(window, [], prefixes, 10);
    // `byOrigin` empty short-circuits, so drive the cap through a populated one.
    const full = renderEnumerationReport(
      window,
      [
        {
          clientIp: '203.0.113.5',
          failures: 60,
          distinctPrefixes: 60,
          errorCodes: 'key_invalid',
          secretVerifiedFailures: 0,
          firstAt: at(-1),
          lastAt: at(0),
        },
      ],
      prefixes,
      10
    );

    expect(lines.join('\n')).toContain('No authentication failures in this window.');
    expect(full.filter((line) => line.includes('gs0000'))).toHaveLength(10);
    expect(full.join('\n')).toContain('… and 50 more prefixes not shown (60 in total)');
    expect(full.join('\n')).toContain('--limit');
  });

  it('adds no truncation line when nothing was dropped', () => {
    // An ordinary report should carry no furniture about a cap it never hit.
    const lines = renderEnumerationReport(
      window,
      [
        {
          clientIp: '203.0.113.5',
          failures: 1,
          distinctPrefixes: 1,
          errorCodes: 'key_invalid',
          secretVerifiedFailures: 0,
          firstAt: at(-1),
          lastAt: at(0),
        },
      ],
      [],
      10
    ).join('\n');

    expect(lines).not.toContain('not shown');
  });

  it('points at the S4 command when a refusal proved a secret', () => {
    const lines = renderEnumerationReport(
      window,
      [
        {
          clientIp: '198.51.100.7',
          failures: 2,
          distinctPrefixes: 1,
          errorCodes: 'key_revoked',
          secretVerifiedFailures: 2,
          firstAt: at(-1),
          lastAt: at(0),
        },
      ],
      []
    ).join('\n');

    expect(lines).toContain('security:secret-holders');
  });
});
