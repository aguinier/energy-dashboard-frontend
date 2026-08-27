import {
  classifyKeyOrigins,
  classifySecretHolderFailures,
  type KeyOriginFinding,
  type SecretHolderFinding,
} from '../../v1/security/securityReport.js';
import type {
  AuthFailureWindow,
  KeyOriginRow,
  OriginFailureRow,
  PrefixFailureRow,
  SecretHolderFailureRow,
} from '../../v1/security/authFailureStore.js';

/**
 * Which of the ABL-524 §2 signals **ring a bell**, as a pure function over the
 * rows `sqliteAuthFailureStore.ts` returns (ABL-578).
 *
 * ABL-530 built the recording half and the *reading* half — the store, the
 * classifiers in `securityReport.ts`, and four `npm run usage -- security:*`
 * commands. What it did not build is anything that runs on its own. This module
 * is the missing predicate: given the same rows an investigator would read, which
 * ones are worth waking somebody for.
 *
 * ## The line this file is written to
 *
 * `securityReport.ts` states its rule as "every verdict is a fact about
 * timestamps or counts, none of them is a threshold", and declines to grade the
 * one signal that would need calibrating. That discipline is why this module can
 * exist at all: three of the four alarm conditions below are **re-used verdicts**
 * from that file, not new judgements, and they carry no number I chose.
 *
 * | Signal | Fires on | Where the condition comes from |
 * |---|---|---|
 * | S4 | `origin_never_served`, `no_usage_history` | ABL-524 §2 S4, verbatim |
 * | S2 | `new_origin_while_old_continues`          | ABL-524 §2 S2, named as *"the one to alert on"* |
 * | S3 | `distinctPrefixes >= minPrefixesPerOrigin` | **provisional — ABL-524 states a shape, not a cutoff** |
 *
 * The third row is the honest exception and it is marked as one everywhere it
 * travels: {@link BreachFinding.basis} carries it into the incident body, so the
 * person reading an alarm at three in the morning can see that its confidence is
 * not the same as S4's. ABL-578 asked for exactly this — say so and propose the
 * change rather than substitute a number quietly.
 *
 * ## What deliberately does not fire, and why
 *
 * A detector's false-positive posture is a design decision, so it is written down
 * rather than left in the shape of the code:
 *
 * - **S4 `origin_unknown`.** The refusal row's own address was scrubbed at 90
 *   days, so "was this key served from there before" cannot be asked. Firing
 *   here would alarm on *our own retention job*, and it would do so more and more
 *   often the longer an investigation ran. `securityReport.ts` created this
 *   verdict precisely to keep it away from `origin_never_served`; folding them
 *   back together here would undo that.
 * - **S4 `origin_known`.** A real secret presented from an address this key has
 *   actually been served from. Overwhelmingly a customer whose key was rotated
 *   or revoked and whose config still holds the old one — a support ticket, and
 *   the single most likely benign shape on the whole table.
 * - **S2 `moved`, `multiple_origins_steady`, `single_origin`, `no_history`.**
 *   ABL-524 §2 S2 splits these out itself: a key that simply moves is a customer
 *   redeploying, and several steady origins is AUP §3.4 key sharing, "a
 *   commercial conversation, not a breach".
 * - **S3 "one prefix, many origins".** ABL-524 reads this shape as a leaked key
 *   being tried by several parties — but a *failure* row means the key did not
 *   work, so the leaked credential is already dead. The live version of that
 *   worry is S4, which is precise and needs no cutoff. Wiring this one would have
 *   cost a second invented number to detect the weaker half of a case already
 *   covered, against the noise of one customer's fleet holding a stale key on a
 *   dozen machines.
 * - **S5 entirely.** `classifyFingerprintBreadth` reports a ratio and refuses to
 *   grade it, because there is no traffic on this surface to calibrate against.
 *   ABL-524 also calls S5 "an AUP signal more than a breach signal". Opening a
 *   `priority: high` incident off an ungraded ratio is how an alarm becomes noise.
 * - **S1, S6, S7.** Out of scope by ABL-578's own boundary (S1 is Tier 2, before
 *   the Board), or not application code (S6 at exposure, S7 an inbox).
 */

/** The ABL-524 §2 signal an alarm is raised under. */
export type BreachSignal = 'S2' | 'S3' | 'S4';

/**
 * Whether the firing condition is stated in ABL-524 or was chosen here.
 *
 * Carried all the way into the incident body on purpose. An alarm whose
 * threshold nobody has calibrated is still worth raising, but it is not worth
 * raising *as though* it were the one signal on the list with no guessing path to
 * it, and a reader at 3am cannot tell them apart from the title.
 */
export type BreachBasis = 'abl-524' | 'provisional';

export interface BreachFinding {
  signal: BreachSignal;
  basis: BreachBasis;
  /**
   * Stable across ticks for the same subject, and **free of any count**.
   *
   * This is the whole of the idempotency contract: a sustained attack must map
   * to one incident that gets updated, not to a fresh `priority: high` issue
   * every tick. Putting a failure count in here — which reads as more precise —
   * would give every tick a new key and turn the alarm into the noise ABL-578
   * names as a failure mode in its own right.
   */
  incidentKey: string;
  /** One line, for the issue title. Never a full key; see {@link subject}. */
  headline: string;
  /**
   * Who or what the finding is about, as **the key id or the non-secret prefix**
   * — ABL-578's wording, and the most identifying thing that may appear.
   *
   * There is no path by which a secret could reach this field: `AuthFailureEvent`
   * has no column that holds one (`authFailureStore.ts` §"Two constraints"), so
   * this is a property of the schema rather than of care taken here. The test
   * asserts it anyway.
   */
  subject: string;
  /**
   * The count that grows while an attack continues. Compared against the last
   * notified value to decide *update or stay quiet*, never to decide *fire*.
   */
  magnitude: number;
  /** Rendered evidence lines for the incident body. Already redacted. */
  evidence: string[];
}

/**
 * The one number in this file that ABL-524 does not state.
 *
 * **§2 S3 gives shapes, not cutoffs** — "many distinct presented prefixes, one
 * source IP, short window" — and `securityReport.ts` renders S3 with no verdict
 * at all for that reason. So the enumeration case cannot be implemented as
 * written, and ABL-578's instruction for that case is to say so and propose,
 * which the closing comment on that issue does.
 *
 * Why it is proposed rather than dropped: credential stuffing *is* the attack
 * ABL-578 leads with, and a watcher that cannot fire on it while reading as
 * coverage is the outcome that issue explicitly calls worse than none.
 *
 * Why **10**, and why the exact value matters less than it looks:
 *
 * - A legitimate caller presents the handle of a key they hold. A wrong secret,
 *   a typo, an expired credential or a retry loop all produce **the same
 *   prefix** — so this count does not grow with volume, only with the number of
 *   distinct key handles one address puts on the wire. That is what makes it a
 *   shape rather than a rate, and it is why raw 401 volume is not used.
 * - Someone walking the key space produces one distinct prefix per guess:
 *   hundreds, in the window. Anything from ~3 to ~100 catches that identically.
 * - Ten leaves room for a customer misconfiguring several keys at once from one
 *   CI host, which is the plausible benign shape and the reason not to pick 2.
 *
 * Overridable by `BREACH_WATCH_MIN_PREFIXES_PER_ORIGIN` so it can be corrected
 * from a deployment when there is finally traffic to calibrate against, rather
 * than needing a code change at the moment somebody is busy.
 */
export const PROVISIONAL_MIN_PREFIXES_PER_ORIGIN = 10;

export interface BreachSignalInputs {
  /** The half-open window S3 and S4 were read over. Reported in the incident. */
  window: AuthFailureWindow;
  byOrigin: readonly OriginFailureRow[];
  secretHolderRows: readonly SecretHolderFailureRow[];
  /** Unwindowed, per `keyOrigins()`; `originLookbackSince` is applied by the classifier. */
  keyOriginRows: readonly KeyOriginRow[];
  originLookbackSince: string;
  minPrefixesPerOrigin: number;
}

/** S4 verdicts that ring. See this file's header for the two that do not. */
const S4_ALARMING = new Set(['origin_never_served', 'no_usage_history']);

function s4Evidence(finding: SecretHolderFinding): string {
  const where = finding.clientIp ?? '(address scrubbed at 90d)';
  return (
    `${finding.errorCode} x${finding.failures} from ${where}, ` +
    `prefix=${finding.presentedPrefix ?? '(none)'}, ` +
    `${finding.firstAt} .. ${finding.lastAt} [${finding.verdict}]`
  );
}

/**
 * S4 — a refusal decided **after** the presented secret had already matched the
 * stored hash.
 *
 * ABL-524 §2 S4: `key_revoked`, `key_expired` and `account_disabled` are reachable
 * only past `secretMatchesHash`, so "there is no guessing path to them" and
 * anyone who triggers one holds a real credential. That makes this the one alarm
 * on the page with no threshold in it at all — the firing condition is which side
 * of a comparison the refusal happened on, which is a column.
 *
 * Grouped **by key**, not by (key, origin): a credential being exercised from
 * twenty addresses is one incident with twenty evidence lines, not twenty
 * incidents. `keyId` is the subject where we have it; a row that reached S4 with
 * no key id is impossible today (the secret matched, so a key was found) but the
 * type allows it, so the prefix is the fallback rather than a crash.
 */
function detectSecretHolderAlarms(rows: readonly SecretHolderFailureRow[]): BreachFinding[] {
  const alarming = classifySecretHolderFailures(rows).filter((row) => S4_ALARMING.has(row.verdict));

  const byKey = new Map<string, SecretHolderFinding[]>();
  for (const finding of alarming) {
    const subject = finding.keyId ?? `prefix ${finding.presentedPrefix ?? '(none)'}`;
    const list = byKey.get(subject);
    if (list) list.push(finding);
    else byKey.set(subject, [finding]);
  }

  return [...byKey].map(([subject, findings]) => {
    const failures = findings.reduce((total, row) => total + row.failures, 0);
    const origins = new Set(findings.map((row) => row.clientIp ?? '(scrubbed)')).size;
    const codes = [...new Set(findings.map((row) => row.errorCode))].sort().join(', ');
    return {
      signal: 'S4' as const,
      basis: 'abl-524' as const,
      incidentKey: `s4:${subject}`,
      subject,
      headline:
        `a real secret for ${subject} was presented and refused (${codes}) from ` +
        `${origins} address(es) we cannot place`,
      magnitude: failures,
      evidence: findings.map(s4Evidence),
    };
  });
}

/**
 * S2 — a new origin appeared for a key **while an older one kept running**.
 *
 * ABL-524 §2 S2 puts it in a two-row table and says of this row: *"The second row
 * is the one to alert on."* The other row — the key simply moving — is a customer
 * redeploying, and `classifyKeyOrigins` already separates the two by comparing
 * timestamps rather than by counting anything.
 *
 * The lookback is bounded by the 90-day scrub (ABL-524 §4), which is why
 * `no_history` exists and is not alarmed on: past that horizon the data says
 * nothing rather than saying no.
 */
function detectKeyOriginAlarms(
  rows: readonly KeyOriginRow[],
  since: string
): BreachFinding[] {
  return classifyKeyOrigins(rows, since)
    .filter((finding) => finding.verdict === 'new_origin_while_old_continues')
    .map((finding: KeyOriginFinding) => ({
      signal: 'S2' as const,
      basis: 'abl-524' as const,
      incidentKey: `s2:${finding.keyId}`,
      subject: finding.keyId,
      headline:
        `${finding.keyId} started serving from a new address while an older one was ` +
        `still active`,
      magnitude: finding.newOrigins.reduce((total, origin) => total + origin.requests, 0),
      evidence: finding.origins.map((origin) => {
        const marker = finding.newOrigins.includes(origin) ? 'NEW ' : '    ';
        return `${marker}${origin.clientIp} x${origin.requests} ${origin.firstAt} .. ${origin.lastAt}`;
      }),
    }));
}

/**
 * S3 — one address presenting many distinct key handles: enumeration.
 *
 * The only alarm here with a number in it. See
 * {@link PROVISIONAL_MIN_PREFIXES_PER_ORIGIN} for where the number came from and
 * why it is marked `provisional` all the way into the incident body.
 *
 * Rows whose address has been scrubbed are skipped rather than grouped: they
 * would collapse every unattributable failure in the window into one `(scrubbed)`
 * bucket whose prefix count is the sum of everyone's, which is a manufactured
 * finding rather than a detected one.
 */
function detectEnumerationAlarms(
  rows: readonly OriginFailureRow[],
  minPrefixesPerOrigin: number
): BreachFinding[] {
  return rows
    .filter((row) => row.clientIp !== null && row.distinctPrefixes >= minPrefixesPerOrigin)
    .map((row) => ({
      signal: 'S3' as const,
      basis: 'provisional' as const,
      incidentKey: `s3:${row.clientIp}`,
      subject: row.clientIp as string,
      headline:
        `${row.clientIp} presented ${row.distinctPrefixes} distinct key prefixes in ` +
        `${row.failures} refused requests`,
      magnitude: row.failures,
      evidence: [
        `${row.failures} failures, ${row.distinctPrefixes} distinct prefixes, ` +
          `${row.secretVerifiedFailures} of them after the secret already matched`,
        `${row.firstAt} .. ${row.lastAt} [${row.errorCodes}]`,
      ],
    }));
}

/**
 * Every signal that rings, ordered by specificity: S4 first, then S2, then the
 * one whose cutoff is provisional.
 *
 * Ordering matters because these become issues in the order they are delivered,
 * and the queue a human sees should start with the finding that needs no
 * calibration to believe.
 */
export function detectBreachSignals(input: BreachSignalInputs): BreachFinding[] {
  const rank: Record<BreachSignal, number> = { S4: 0, S2: 1, S3: 2 };
  return [
    ...detectSecretHolderAlarms(input.secretHolderRows),
    ...detectKeyOriginAlarms(input.keyOriginRows, input.originLookbackSince),
    ...detectEnumerationAlarms(input.byOrigin, input.minPrefixesPerOrigin),
  ].sort((a, b) => rank[a.signal] - rank[b.signal] || a.incidentKey.localeCompare(b.incidentKey));
}
