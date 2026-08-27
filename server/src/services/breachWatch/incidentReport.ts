import type { AuthFailureWindow } from '../../v1/security/authFailureStore.js';
import type { BreachFinding, BreachSignal } from './signals.js';

/**
 * The words that reach the CEO, as pure functions (ABL-578).
 *
 * Rendering is split from detection for the reason `securityReport.ts` gives for
 * the same split: the distinctions the detector exists to preserve only exist if
 * they survive into the output, and that is checkable only when the output is a
 * returned value rather than something posted over HTTP.
 *
 * ## What ABL-578 requires to be in here
 *
 * *"The issue body must carry enough to triage without a database session: which
 * signal tripped, the window, the counts, and the key id or prefix involved —
 * never a full key."*
 *
 * All five are below, and the last one is structural rather than careful:
 * `AuthFailureEvent` has no column that could hold a secret, so no value reaching
 * this module has ever been one. {@link assertNoSecret} checks it regardless,
 * because "the schema makes it impossible" is exactly the kind of claim that
 * stops being true when somebody adds a field.
 *
 * ## Why the detail is a comment and the description is short
 *
 * The Paperclip issue API rejects long descriptions unreliably — a body past a
 * couple of kilobytes fails intermittently rather than cleanly, which is the
 * worst failure mode available for an alarm. So the description carries the
 * triage set named above and nothing else, and the evidence rows go in the first
 * comment. Both are written so the description **alone** is enough to act on: a
 * comment that failed to post must not be the difference between a usable alarm
 * and a mystery.
 */

/** ABL-524 §6: the title is `INCIDENT: …`. The prefix is contractual, not decorative. */
const TITLE_PREFIX = 'INCIDENT';

const SIGNAL_NAME: Record<BreachSignal, string> = {
  S2: 'S2 key used from a new origin while the old one continued',
  S3: 'S3 authentication failures walking the prefix space',
  S4: 'S4 refusal by a caller holding a real secret',
};

/**
 * One line per signal saying what it would change our belief about — ABL-524 §2,
 * compressed to what is useful at three in the morning.
 */
const SIGNAL_MEANING: Record<BreachSignal, string> = {
  S2:
    'A key served requests from an address it had not been used from, while an older address ' +
    'was still active. ABL-524 §2 S2: a key that merely *moves* is usually a redeploy; two ' +
    'places where one did not know about the other is the stolen-credential shape.',
  S3:
    'One address presented many distinct key prefixes. ABL-524 §2 S3 reads that shape as ' +
    'someone guessing at our key space. Note the basis line below: the count that triggered ' +
    'this is not from ABL-524.',
  S4:
    'The presented secret had already matched the stored hash when the request was refused. ' +
    'ABL-524 §2 S4: revoked, expired and disabled are reachable only past that check, so there ' +
    'is no guessing path to them — whoever sent this holds a real credential.',
};

/**
 * Anything shaped like a whole `/v1` credential.
 *
 * `able_<env>_<prefix>_<secret>` — the four-segment form `apiKeyAuth.ts` parses.
 * A prefix on its own is safe and is deliberately included in these reports
 * (ABL-524 §2 S3 calls it "the non-secret handle"); the secret segment is what
 * must never appear, and the only way it could is if a future column carried it.
 */
const FULL_KEY_SHAPE = /able_[a-z]+_[A-Za-z0-9]+_[A-Za-z0-9]/;

/**
 * The last gate before words leave the process.
 *
 * Returns the text unchanged, or a redaction marker. It does **not** throw: an
 * alarm that refuses to fire because its own body failed a lint is an alarm that
 * does not exist, and the failure mode this guards against is a leak into an
 * issue tracker, not into a caller's response.
 */
export function assertNoSecret(text: string): string {
  return FULL_KEY_SHAPE.test(text)
    ? '(redacted: this line matched the shape of a whole API key and was withheld)'
    : text;
}

export interface IncidentContext {
  window: AuthFailureWindow;
  originLookbackSince: string;
  /** `client_ip` is nulled at this age, which bounds every claim in the body. */
  piiDays: number;
  /** The provisional S3 cutoff in force, so the body can state what it was. */
  minPrefixesPerOrigin: number;
  observedAt: string;
}

export interface Incident {
  title: string;
  description: string;
  /** The evidence rows, posted as the first comment. */
  detail: string;
}

function basisLine(finding: BreachFinding, context: IncidentContext): string {
  return finding.basis === 'abl-524'
    ? '**Basis:** the firing condition is stated in ABL-524 §2 and carries no calibrated ' +
        'threshold — it is a fact about a column, not a count crossing a line.'
    : '**Basis: PROVISIONAL — this cutoff is not from ABL-524.** §2 S3 states a shape ' +
        '("many distinct prefixes, one source IP") and no number. This fired at ' +
        `\`>= ${context.minPrefixesPerOrigin}\` distinct prefixes from one address, a value ` +
        'chosen in ABL-578 and proposed back to ABL-524 for calibration. Weigh it accordingly: ' +
        'it is the one alarm here that could be wrong about the threshold rather than the facts.';
}

/**
 * The window sentence, including the horizon caveat.
 *
 * ABL-524 §4 is emphatic that "never seen from here before" is a claim bounded at
 * 90 days, and that an investigation starting on day 89 can lose its own evidence
 * while it runs. That is not a footnote to leave off an alarm, because it decides
 * whether step 2 of the procedure — preserve before you fix — is urgent.
 */
function windowLines(finding: BreachFinding, context: IncidentContext): string[] {
  const lines = [
    `**Window:** \`${context.window.since}\` .. \`${context.window.until}\` (UTC, half-open).`,
  ];
  if (finding.signal === 'S2') {
    lines.push(`**New-origin lookback:** since \`${context.originLookbackSince}\` (UTC).`);
  }
  lines.push(
    `**Address history retained:** ${context.piiDays} days, then \`client_ip\` is NULL ` +
      '(Privacy Notice §5). Nothing older can be compared against, and an investigation ' +
      'that runs past that boundary loses its own evidence — see step 2 of `breach-procedure`.'
  );
  return lines;
}

/**
 * Set when this subject already had an incident and that incident is now closed.
 *
 * Worth saying out loud in the body rather than filing silently: the recipient is
 * about to receive a second `priority: high` issue about something they have
 * already triaged, and whether that is alarming or annoying depends entirely on
 * knowing it is deliberate.
 */
export interface IncidentReopen {
  closedIssueId: string;
}

/**
 * One alarm, ready to post.
 *
 * The description is deliberately self-sufficient; see this file's header for why
 * the evidence lives in a separate comment rather than being appended here.
 */
export function buildIncident(
  finding: BreachFinding,
  context: IncidentContext,
  reopen?: IncidentReopen
): Incident {
  const title = assertNoSecret(
    `${TITLE_PREFIX}: ${finding.signal} — ${finding.headline}`
  );

  const reopenLines = reopen
    ? [
        '',
        `**This subject was reported before, in \`${reopen.closedIssueId}\`, and that incident ` +
          'is closed — but the signal is still firing.** A new issue rather than a comment on a ' +
          'closed thread, because a comment there would be inert and this would go unread. If ' +
          'the earlier one was dismissed, note that the dismissal did not stop the traffic: ' +
          'dismissing again without changing anything will produce this issue again.',
      ]
    : [];

  const description = [
    `**Signal:** ${SIGNAL_NAME[finding.signal]}`,
    `**Subject:** \`${finding.subject}\``,
    `**Observed:** ${finding.magnitude} matching record(s) at \`${context.observedAt}\`.`,
    '',
    ...windowLines(finding, context),
    '',
    SIGNAL_MEANING[finding.signal],
    '',
    basisLine(finding, context),
    ...reopenLines,
    '',
    'Opened automatically by the ABL-578 breach watcher, which reads the tables ABL-530 ' +
      'fills. **This is step 1 of `breach-procedure` (ABL-524)** — the same artefact, so ' +
      'there is no window where an alarm has fired and nothing is written down. Work the ' +
      'procedure from here; close `DISMISSED` if it does not survive triage.',
    '',
    'No full API key appears in this issue by construction: the auth-failure table has no ' +
      'column that could hold one. The prefix is the non-secret handle (ABL-524 §2 S3).',
  ]
    .map(assertNoSecret)
    .join('\n');

  const detail = [
    `### Evidence — ${SIGNAL_NAME[finding.signal]}`,
    '',
    '```',
    ...finding.evidence,
    '```',
    '',
    'Reproduce with the ABL-530 read commands, from `server/`:',
    '',
    '```bash',
    `npm run usage -- security:auth-failures --hours 24`,
    `npm run usage -- security:secret-holders --days 30`,
    `npm run usage -- security:key-origins --days 30`,
    '```',
  ]
    .map(assertNoSecret)
    .join('\n');

  return { title, description, detail };
}

/**
 * What gets posted to an incident that is **already open** for this subject.
 *
 * ABL-578: one open incident per window, *updated, not duplicated*. The update
 * says what changed rather than repeating the finding, so a thread on a sustained
 * attack reads as a rising count instead of as the same paragraph twenty times.
 */
export function buildUpdateComment(
  finding: BreachFinding,
  previousMagnitude: number,
  context: IncidentContext
): string {
  return [
    `**Still firing** at \`${context.observedAt}\`.`,
    '',
    `${finding.signal} for \`${finding.subject}\` has gone from ${previousMagnitude} to ` +
      `${finding.magnitude} matching record(s) since this issue was opened.`,
    '',
    finding.headline,
    '',
    '```',
    ...finding.evidence,
    '```',
    '',
    'Same incident window — no new issue was opened. The watcher updates rather than ' +
      'duplicating so a sustained attack stays one thread.',
  ]
    .map(assertNoSecret)
    .join('\n');
}
