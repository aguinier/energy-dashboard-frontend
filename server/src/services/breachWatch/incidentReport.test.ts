import { describe, it, expect } from 'vitest';
import { assertNoSecret, buildIncident, buildUpdateComment, type IncidentContext } from './incidentReport.js';
import type { BreachFinding } from './signals.js';

/**
 * What the CEO actually reads.
 *
 * ABL-578 sets the bar for the body: *"enough to triage without a database
 * session: which signal tripped, the window, the counts, and the key id or prefix
 * involved — never a full key."* Each of those five is asserted below, because
 * an incident that is correctly *detected* and unreadably *reported* wakes
 * somebody up to no purpose.
 */

const CONTEXT: IncidentContext = {
  window: { since: '2026-08-26T00:00:00.000Z', until: '2026-08-27T00:00:00.000Z' },
  originLookbackSince: '2026-07-28T00:00:00.000Z',
  piiDays: 90,
  minPrefixesPerOrigin: 10,
  observedAt: '2026-08-27T00:00:00.000Z',
};

const S4_FINDING: BreachFinding = {
  signal: 'S4',
  basis: 'abl-524',
  incidentKey: 's4:key_live_001',
  subject: 'key_live_001',
  headline: 'a real secret for key_live_001 was presented and refused (key_revoked) from 3 address(es) we cannot place',
  magnitude: 15,
  evidence: ['key_revoked x15 from 203.0.113.1, prefix=a1b2c3d4 [origin_never_served]'],
};

const S3_FINDING: BreachFinding = {
  signal: 'S3',
  basis: 'provisional',
  incidentKey: 's3:203.0.113.77',
  subject: '203.0.113.77',
  headline: '203.0.113.77 presented 940 distinct key prefixes in 940 refused requests',
  magnitude: 940,
  evidence: ['940 failures, 940 distinct prefixes, 0 of them after the secret already matched'],
};

describe('the incident body carries the ABL-578 triage set', () => {
  const incident = buildIncident(S4_FINDING, CONTEXT);

  it('is titled INCIDENT: … as ABL-524 §6 requires', () => {
    expect(incident.title.startsWith('INCIDENT: ')).toBe(true);
    expect(incident.title).toContain('S4');
  });

  it('names which signal tripped', () => {
    expect(incident.description).toContain('S4 refusal by a caller holding a real secret');
  });

  it('states the window', () => {
    expect(incident.description).toContain('2026-08-26T00:00:00.000Z');
    expect(incident.description).toContain('2026-08-27T00:00:00.000Z');
  });

  it('states the counts', () => {
    expect(incident.description).toContain('15 matching record(s)');
  });

  it('names the key id involved', () => {
    expect(incident.description).toContain('key_live_001');
  });

  it('states the 90-day horizon that bounds every claim in it', () => {
    expect(incident.description).toContain('90 days');
    expect(incident.description).toContain('Privacy Notice §5');
  });

  it('points at the breach procedure rather than leaving the reader to find it', () => {
    expect(incident.description).toContain('breach-procedure');
  });

  it('puts the evidence and the reproduction commands in the comment', () => {
    expect(incident.detail).toContain('origin_never_served');
    expect(incident.detail).toContain('npm run usage -- security:secret-holders');
  });

  it('keeps the description short enough that the issue API takes it reliably', () => {
    // The control plane rejects long descriptions intermittently rather than
    // cleanly, which is the worst failure mode available to an alarm. The
    // evidence lives in a comment for this reason; the description must stay
    // under the size where that starts happening.
    expect(incident.description.length).toBeLessThan(2_000);
  });
});

describe('the basis of the firing condition travels with the alarm', () => {
  it('says so when the condition is stated in ABL-524', () => {
    const { description } = buildIncident(S4_FINDING, CONTEXT);
    expect(description).toContain('stated in ABL-524 §2');
    expect(description).not.toContain('PROVISIONAL');
  });

  it('says so, loudly, when the cutoff was chosen in ABL-578 instead', () => {
    // Without this the reader at 3am cannot tell the one alarm that could be
    // wrong about its threshold from the three that cannot.
    const { description } = buildIncident(S3_FINDING, CONTEXT);
    expect(description).toContain('PROVISIONAL');
    expect(description).toContain('not from ABL-524');
    expect(description).toContain('>= 10');
  });
});

describe('a re-opened incident says it is a re-open', () => {
  it('names the closed incident and warns that dismissing again repeats this', () => {
    // The recipient is about to get a second priority:high issue about something
    // they already triaged. Whether that reads as alarming or as a broken watcher
    // depends entirely on the body saying it is deliberate.
    const { description } = buildIncident(S4_FINDING, CONTEXT, { closedIssueId: 'issue-1' });
    expect(description).toContain('`issue-1`');
    expect(description).toContain('is closed — but the signal is still firing');
    expect(description).toContain('dismissing again without changing anything');
  });

  it('says nothing of the sort on a first incident', () => {
    expect(buildIncident(S4_FINDING, CONTEXT).description).not.toContain('reported before');
  });
});

describe('never a full key', () => {
  it('passes a bare prefix through — it is the non-secret handle', () => {
    // ABL-524 §2 S3 is explicit that recording the prefix is the point; it is
    // what separates enumeration from a customer with a stale key.
    expect(assertNoSecret('prefix=a1b2c3d4')).toBe('prefix=a1b2c3d4');
  });

  it('withholds anything shaped like a whole credential', () => {
    expect(assertNoSecret('able_live_a1b2c3d4_SsecretSSSS')).toContain('redacted');
  });

  it('redacts rather than throwing, so a bad line cannot suppress the alarm', () => {
    const incident = buildIncident(
      { ...S4_FINDING, evidence: ['leaked able_live_a1b2c3d4_SsecretSSSS here'] },
      CONTEXT
    );
    expect(incident.detail).toContain('redacted');
    expect(incident.detail).not.toContain('SsecretSSSS');
    // Still a usable alarm.
    expect(incident.title).toContain('INCIDENT');
  });

  it('no rendered surface contains a full-key shape for a realistic finding', () => {
    const incident = buildIncident(S4_FINDING, CONTEXT);
    const everything = `${incident.title}\n${incident.description}\n${incident.detail}`;
    expect(/able_[a-z]+_[A-Za-z0-9]+_[A-Za-z0-9]/.test(everything)).toBe(false);
  });
});

describe('the update comment', () => {
  it('says what changed rather than repeating the finding', () => {
    const body = buildUpdateComment({ ...S4_FINDING, magnitude: 900 }, 15, CONTEXT);
    expect(body).toContain('Still firing');
    expect(body).toContain('from 15 to 900');
    expect(body).toContain('no new issue was opened');
  });
});
