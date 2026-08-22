import type {
  AuthFailureWindow,
  KeyFingerprintRow,
  KeyOriginRow,
  OriginFailureRow,
  PrefixFailureRow,
  SecretHolderFailureRow,
} from './authFailureStore.js';

/**
 * What the four ABL-524 §2 signals *mean*, as pure functions over the rows the
 * store returns.
 *
 * Split out of the store for the reason `freshness.ts` is split out of
 * `dataFreshnessService.ts`: the judgement is the part worth testing, and it is
 * the part that should be readable without a database in front of it. The store
 * knows how to group rows; this module knows which groupings are findings.
 *
 * ## The rule this file is written to
 *
 * **Every verdict below is a fact about timestamps or counts. None of them is a
 * threshold.**
 *
 * That is deliberate and it is this repository's own scar. `METRIC_THRESHOLDS`
 * graded forecast error against cutoffs nobody had calibrated, and the result was
 * 21 of 24 countries rendered the identical red and every one of them stamped
 * "Needs Improvement" from 9.9% to 76.8% — a confident grade over a distribution
 * that had no gap to put a cutoff in. The temptation here is worse, not better:
 * there is **no live traffic on this surface at all** (`PUBLIC_BIND_HOST`
 * defaults to loopback and no external key exists), so any multiple or rate I
 * picked today would be a number invented against zero observations and then
 * read at three in the morning as though it meant something.
 *
 * So where a judgement needs calibration, this module reports the figure and
 * declines to grade it — see {@link classifyFingerprintBreadth}, which is the
 * only one of the four where that bites. The other three can be stated plainly
 * because their findings are not quantities:
 *
 * - **S4** is `secret_verified = 1`, which is a fact about which side of
 *   `secretMatchesHash` the refusal happened on. Anyone it names holds a real
 *   secret. There is no guessing path to it and no threshold to pick.
 * - **S2**'s finding is "a new origin appeared *and the original kept running*",
 *   which is a comparison of two timestamps.
 * - **S3** is presented as two orderings of the same rows with the ABL-524
 *   reading guide beside them, and no verdict at all: the shapes that matter are
 *   about rate and persistence, which is exactly what nobody can calibrate yet.
 *
 * ## The constraint that shapes half of this file
 *
 * `client_ip` is `NULL` at 90 days (ABL-297 §5, a published commitment fixed by
 * a Board decision). So **"this key has never been used from here" is a claim
 * that can only be made over the retained window**, and past that horizon the
 * data says nothing rather than saying no. Two verdicts exist solely to keep
 * those apart — `no_history` and `origin_unknown` — because collapsing either
 * into its confident neighbour is how this report would name an innocent
 * customer as a credential thief, or miss a real one.
 */

/*
 * ---------------------------------------------------------------------------
 * S2 — a key used from an origin it has never been used from
 * ---------------------------------------------------------------------------
 */

export type KeyOriginVerdict =
  /**
   * The finding. A new origin appeared inside the lookback **and** at least one
   * older origin was still active at that moment.
   *
   * ABL-524 §2: a key that simply *moves* is usually a customer redeploying. A
   * key used from two places where one of them did not know about the other is
   * the classic stolen-credential signature.
   */
  | 'new_origin_while_old_continues'
  /** A new origin appeared and every older one had already stopped. Usually a redeploy. */
  | 'moved'
  /** One origin, unchanged. */
  | 'single_origin'
  /**
   * Several origins, none of them new inside the lookback.
   *
   * Not a breach candidate. AUP §3.4 calls this key sharing and it is a
   * commercial conversation — deliberately a different document from the one
   * `new_origin_while_old_continues` belongs to.
   */
  | 'multiple_origins_steady'
  /**
   * The key's whole retained address history begins at or after the newest
   * origin's first request, so "never used from here before" is unfalsifiable.
   *
   * Two ordinary causes and they are indistinguishable from here: a key issued
   * recently, and a key whose earlier history has been scrubbed at 90 days. Both
   * are reported as *no claim*, which is the honest reading of both.
   */
  | 'no_history';

export interface KeyOriginFinding {
  keyId: string;
  accountId: string;
  verdict: KeyOriginVerdict;
  /** Every origin we still hold an address for, oldest first. */
  origins: KeyOriginRow[];
  /** Those whose first request falls inside the lookback. */
  newOrigins: KeyOriginRow[];
  /** The earliest addressed request we retain for this key. The horizon of any claim. */
  historyFrom: string | null;
  /**
   * Milliseconds of retained history preceding the newest origin's arrival.
   *
   * `0` means the key's history *starts* with that origin, which is what makes
   * the claim unfalsifiable rather than negative. Reported rather than folded
   * into the verdict, so an investigator can see that a `moved` backed by four
   * minutes of history is not the same as one backed by eighty days.
   */
  priorHistoryMs: number;
}

/**
 * Group `usage_events` origins per key and say which pattern each one is in.
 *
 * `since` is the lookback that decides what counts as *new*. It is applied here
 * rather than in the query on purpose: a windowed query cannot answer "has this
 * key ever been used from here before", because every origin looks new if you
 * only fetch the last week.
 */
export function classifyKeyOrigins(
  rows: readonly KeyOriginRow[],
  since: string
): KeyOriginFinding[] {
  const byKey = new Map<string, KeyOriginRow[]>();
  for (const row of rows) {
    const list = byKey.get(row.keyId);
    if (list) list.push(row);
    else byKey.set(row.keyId, [row]);
  }

  const findings: KeyOriginFinding[] = [];
  for (const [keyId, unsorted] of byKey) {
    const origins = [...unsorted].sort((a, b) => a.firstAt.localeCompare(b.firstAt));
    const historyFrom = origins[0]?.firstAt ?? null;
    const newOrigins = origins.filter((origin) => origin.firstAt >= since);
    const newest = newOrigins[newOrigins.length - 1];

    const priorHistoryMs =
      newest && historyFrom ? Date.parse(newest.firstAt) - Date.parse(historyFrom) : 0;

    let verdict: KeyOriginVerdict;
    if (newOrigins.length === 0) {
      verdict = origins.length === 1 ? 'single_origin' : 'multiple_origins_steady';
    } else if (priorHistoryMs <= 0) {
      // The newest origin is the oldest thing we hold for this key. There is no
      // window in which it could have been absent, so there is no claim to make.
      verdict = 'no_history';
    } else {
      // Was anything else still running when the new origin arrived? That, and
      // not the arrival itself, is the theft signature.
      const overlaps = origins.some(
        (origin) => origin.clientIp !== newest.clientIp && origin.lastAt >= newest.firstAt
      );
      verdict = overlaps ? 'new_origin_while_old_continues' : 'moved';
    }

    findings.push({
      keyId,
      accountId: origins[0].accountId,
      verdict,
      origins,
      newOrigins,
      historyFrom,
      priorHistoryMs,
    });
  }

  // Findings first, then the rest, so the alert shape is at the top of the page.
  const rank: Record<KeyOriginVerdict, number> = {
    new_origin_while_old_continues: 0,
    moved: 1,
    no_history: 2,
    multiple_origins_steady: 3,
    single_origin: 4,
  };
  return findings.sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.keyId.localeCompare(b.keyId));
}

/*
 * ---------------------------------------------------------------------------
 * S4 — a refusal by somebody who held a real secret
 * ---------------------------------------------------------------------------
 */

export type SecretHolderVerdict =
  /**
   * The finding, and the highest specificity on the whole list. A real secret,
   * presented from an address this key has never been *served* from inside the
   * retained window.
   *
   * If the key was revoked because it leaked, this is confirmation the leak is
   * being exercised.
   */
  | 'origin_never_served'
  /** The same key has been served from this address before. Most likely its owner. */
  | 'origin_known'
  /**
   * We hold no addressed history for this key at all, so "never served from
   * here" cannot be checked. A key that has only ever failed has no successful
   * traffic to compare against — which is itself worth a look, and is not the
   * same claim.
   */
  | 'no_usage_history'
  /**
   * The refusal row's own address has been scrubbed at 90 days, so the question
   * cannot be asked. Never folded into `origin_never_served`: a `COUNT(*)`
   * against a `NULL` address returns `0` and would read as the most alarming
   * verdict on the page.
   */
  | 'origin_unknown';

export interface SecretHolderFinding extends SecretHolderFailureRow {
  verdict: SecretHolderVerdict;
}

export function classifySecretHolderFailures(
  rows: readonly SecretHolderFailureRow[]
): SecretHolderFinding[] {
  const findings = rows.map((row): SecretHolderFinding => {
    let verdict: SecretHolderVerdict;
    if (row.clientIp === null || row.originServedRequests === null) verdict = 'origin_unknown';
    else if (row.usageHistoryFrom === null) verdict = 'no_usage_history';
    else if (row.originServedRequests > 0) verdict = 'origin_known';
    else verdict = 'origin_never_served';
    return { ...row, verdict };
  });

  const rank: Record<SecretHolderVerdict, number> = {
    origin_never_served: 0,
    no_usage_history: 1,
    origin_unknown: 2,
    origin_known: 3,
  };
  return findings.sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.lastAt.localeCompare(a.lastAt));
}

/*
 * ---------------------------------------------------------------------------
 * S5 — use turning into extraction
 * ---------------------------------------------------------------------------
 */

export type FingerprintBreadthVerdict =
  /**
   * No traffic in the baseline window, so there is nothing of this key's own to
   * compare against.
   *
   * ABL-524 §2 names this exactly: *"a new subscriber's first week looks like
   * extraction against a global baseline and like onboarding against their
   * own."* Reported as its own state rather than as a ratio against zero.
   */
  | 'onboarding'
  /** The key has a baseline of its own. The ratio is reported; it is not graded. */
  | 'comparable';

export interface FingerprintBreadthFinding extends KeyFingerprintRow {
  verdict: FingerprintBreadthVerdict;
  /**
   * `recentFingerprints / baselineFingerprints`, or `null` when there is no
   * baseline.
   *
   * **Deliberately not compared against a cutoff.** See this file's header: the
   * surface has no live traffic, so a multiple chosen today would be invented,
   * and an invented cutoff read at 3am is worse than a number with no cutoff
   * beside it. The two window lengths are printed with it so a reader can see
   * what they are dividing.
   */
  breadthRatio: number | null;
}

export function classifyFingerprintBreadth(
  rows: readonly KeyFingerprintRow[]
): FingerprintBreadthFinding[] {
  return rows
    .map((row): FingerprintBreadthFinding => ({
      ...row,
      verdict: row.baselineRequests === 0 ? 'onboarding' : 'comparable',
      breadthRatio:
        row.baselineFingerprints === 0 ? null : row.recentFingerprints / row.baselineFingerprints,
    }))
    .sort((a, b) => (b.breadthRatio ?? -1) - (a.breadthRatio ?? -1) || a.keyId.localeCompare(b.keyId));
}

/*
 * ---------------------------------------------------------------------------
 * Rendering
 * ---------------------------------------------------------------------------
 *
 * Pure, and returning lines rather than printing them, so the words an
 * investigator reads at three in the morning are asserted by a test rather than
 * captured from a console. The distinctions this whole module exists to preserve
 * are only preserved if they survive into the output — a verdict of
 * `origin_unknown` rendered as a blank cell is the same as not having it.
 */

/** How a value that we no longer hold is written. Never blank, never a zero. */
export const SCRUBBED = '(scrubbed at 90d)';
/** How a value that was never present is written. A different claim from the above. */
export const NONE = '(none)';

/**
 * How many rows of each S3 table are printed before the rest are summarised.
 *
 * Found by running the command rather than by reasoning about it. The very shape
 * this report exists to surface — one address presenting hundreds of distinct
 * prefixes — produces one row *per guessed prefix* in the second table, so a
 * 900-prefix enumeration pushed the finding nine hundred lines off the top of a
 * terminal. The flood is the signal, and printing all of it is what hides it.
 *
 * A cap on a security report is exactly where a silent truncation would be worst,
 * so {@link truncated} states the count and the total on its own line. `--limit`
 * raises it when somebody wants the whole thing.
 */
export const DEFAULT_ROW_LIMIT = 25;

/**
 * The line that keeps a cap from reading as "that was everything".
 *
 * Returns nothing when nothing was dropped, so an ordinary report carries no
 * furniture.
 */
function truncated(shown: number, total: number, noun: string): string[] {
  return total > shown
    ? [`  … and ${total - shown} more ${noun} not shown (${total} in total). Raise --limit to see them.`]
    : [];
}

function origin(clientIp: string | null): string {
  return clientIp ?? SCRUBBED;
}

function windowLine(label: string, { since, until }: AuthFailureWindow): string {
  return `${label}: ${since} .. ${until} (UTC, half-open)`;
}

/**
 * S3. Two orderings of the same rows, with ABL-524's reading guide beside them.
 *
 * No verdict, on purpose — see the header. What separates signal from noise here
 * is rate and persistence, and this deployment has no traffic to calibrate
 * either against. The orderings are the whole contribution: many prefixes from
 * one origin floats to the top of the first table, one prefix from many origins
 * to the top of the second, and a broken client retrying one stale key forever
 * produces the largest raw count on the page and sits below both.
 */
export function renderEnumerationReport(
  window: AuthFailureWindow,
  byOrigin: readonly OriginFailureRow[],
  byPrefix: readonly PrefixFailureRow[],
  limit: number = DEFAULT_ROW_LIMIT
): string[] {
  const lines = [windowLine('Auth failures', window), ''];

  if (byOrigin.length === 0) {
    lines.push('No authentication failures in this window.');
    return lines;
  }

  lines.push('By origin — many distinct prefixes from one address is enumeration:');
  lines.push('  origin                          failures  prefixes  verified  first .. last');
  for (const row of byOrigin.slice(0, limit)) {
    lines.push(
      `  ${origin(row.clientIp).padEnd(30)}  ${String(row.failures).padStart(8)}  ` +
        `${String(row.distinctPrefixes).padStart(8)}  ${String(row.secretVerifiedFailures).padStart(8)}  ` +
        `${row.firstAt} .. ${row.lastAt}  [${row.errorCodes}]`
    );
  }
  lines.push(...truncated(limit, byOrigin.length, 'origins'));

  lines.push('');
  lines.push('By presented prefix — one prefix from many addresses is a leaked key:');
  lines.push('  prefix    failures  origins  first .. last');
  for (const row of byPrefix.slice(0, limit)) {
    lines.push(
      `  ${(row.presentedPrefix ?? NONE).padEnd(8)}  ${String(row.failures).padStart(8)}  ` +
        `${String(row.distinctOrigins).padStart(7)}  ${row.firstAt} .. ${row.lastAt}  [${row.errorCodes}]`
    );
  }
  // The table most likely to be capped, and the one where it matters most: an
  // address walking the key space produces one row per prefix it guessed, so the
  // *volume* of this section is itself the finding the section above names.
  lines.push(...truncated(limit, byPrefix.length, 'prefixes'));

  lines.push('');
  lines.push('Reading it (ABL-524 §2, S3) — these are shapes, not thresholds:');
  lines.push('  many prefixes, one origin, short window  someone is guessing at our key space');
  lines.push('  one prefix, one origin, low steady rate  a customer with a stale key: support');
  lines.push('  one prefix, many origins                 a leaked key tried by several parties');
  lines.push('  key_missing / key_malformed at volume    a misconfigured client, or a scanner');
  lines.push('');
  lines.push(
    'A "verified" count above zero means the caller had already proven a secret — ' +
      'run security:secret-holders.'
  );
  return lines;
}

/** S4. */
export function renderSecretHolderReport(
  window: AuthFailureWindow,
  findings: readonly SecretHolderFinding[],
  limit: number = DEFAULT_ROW_LIMIT
): string[] {
  const lines = [windowLine('Refusals by a caller holding a real secret', window), ''];

  if (findings.length === 0) {
    lines.push('None. No refusal in this window happened after the secret had matched.');
    return lines;
  }

  lines.push(
    'Every row below was refused *after* secretMatchesHash succeeded — revoked, expired,'
  );
  lines.push('disabled, or an environment mismatch. There is no guessing path to any of them.');
  lines.push('');

  for (const finding of findings.slice(0, limit)) {
    lines.push(
      `  ${finding.verdict.padEnd(20)}  ${finding.errorCode.padEnd(17)}  ` +
        `${(finding.keyId ?? NONE).padEnd(18)}  prefix=${finding.presentedPrefix ?? NONE}  ` +
        `from=${origin(finding.clientIp)}  x${finding.failures}  last=${finding.lastAt}`
    );
    if (finding.verdict === 'origin_never_served') {
      lines.push(
        `      This key has never been served from that address in the history we hold ` +
          `(from ${finding.usageHistoryFrom ?? NONE}).`
      );
    }
    if (finding.verdict === 'no_usage_history') {
      lines.push('      We hold no successful request for this key with an address, so there is');
      lines.push('      nothing to compare against. Not a negative finding.');
    }
    if (finding.verdict === 'origin_unknown') {
      lines.push('      The address on this refusal was scrubbed at 90 days, so the question');
      lines.push('      cannot be asked. Not "never seen from here".');
    }
  }

  lines.push(...truncated(limit, findings.length, 'rows'));

  lines.push('');
  lines.push(
    'A key_revoked from an origin the key never used is close to proof the credential is'
  );
  lines.push('in someone else’s hands. Open the incident record early — Privacy Notice §5 is');
  lines.push('what makes preserving evidence past 90 days lawful, and it needs a record to exist.');
  return lines;
}

/** S2. */
export function renderKeyOriginReport(
  since: string,
  findings: readonly KeyOriginFinding[],
  piiDays: number,
  limit: number = DEFAULT_ROW_LIMIT
): string[] {
  const lines = [
    `New origins since: ${since} (UTC)`,
    `Address history retained: ${piiDays} days. Nothing before that can be compared against.`,
    '',
  ];

  if (findings.length === 0) {
    lines.push('No key has a recorded origin. Either nothing has been served, or every');
    lines.push(`request older than ${piiDays} days has had its address scrubbed.`);
    return lines;
  }

  for (const finding of findings.slice(0, limit)) {
    lines.push(
      `  ${finding.verdict.padEnd(30)}  ${finding.keyId}  (${finding.origins.length} origin(s), ` +
        `history from ${finding.historyFrom ?? NONE})`
    );
    for (const row of finding.origins) {
      const isNew = finding.newOrigins.includes(row);
      lines.push(
        `      ${isNew ? 'NEW ' : '    '}${row.clientIp.padEnd(30)}  x${String(row.requests).padStart(7)}  ` +
          `${row.firstAt} .. ${row.lastAt}`
      );
    }
    if (finding.verdict === 'new_origin_while_old_continues') {
      lines.push('      A new origin appeared while an older one kept running. This is the');
      lines.push('      stolen-credential shape, not a redeploy. Run the breach procedure.');
    }
    if (finding.verdict === 'moved') {
      lines.push(
        `      The old origin had stopped. Usually a redeploy — but it rests on only ` +
          `${Math.floor(finding.priorHistoryMs / 3_600_000)}h of prior history.`
      );
    }
    if (finding.verdict === 'no_history') {
      lines.push('      This key’s retained history begins with that origin, so "new" cannot');
      lines.push('      be claimed. A recently issued key and a scrubbed one look identical here.');
    }
    if (finding.verdict === 'multiple_origins_steady') {
      lines.push('      Several origins, none new. AUP §3.4 key sharing — a commercial');
      lines.push('      conversation, not a breach candidate.');
    }
  }
  lines.push(...truncated(limit, findings.length, 'keys'));
  return lines;
}

/** S5. */
export function renderFingerprintBreadthReport(
  recent: AuthFailureWindow,
  baselineSince: string,
  findings: readonly FingerprintBreadthFinding[],
  limit: number = DEFAULT_ROW_LIMIT
): string[] {
  const lines = [
    windowLine('Recent', recent),
    `Baseline: ${baselineSince} .. ${recent.since} (UTC, this key’s own history)`,
    '',
  ];

  if (findings.length === 0) {
    lines.push('No key served a request in the recent window.');
    return lines;
  }

  lines.push('  key                 recent fp / req   baseline fp / req   ratio');
  for (const finding of findings.slice(0, limit)) {
    lines.push(
      `  ${finding.keyId.padEnd(18)}  ${String(finding.recentFingerprints).padStart(6)} / ` +
        `${String(finding.recentRequests).padStart(6)}   ` +
        `${String(finding.baselineFingerprints).padStart(8)} / ` +
        `${String(finding.baselineRequests).padStart(6)}   ` +
        (finding.breadthRatio === null
          ? 'no baseline (onboarding)'
          : finding.breadthRatio.toFixed(2))
    );
  }

  lines.push(...truncated(limit, findings.length, 'keys'));

  lines.push('');
  lines.push('The ratio is distinct request fingerprints, recent against this key’s own');
  lines.push('baseline — never a global one, because a new subscriber’s first week looks like');
  lines.push('extraction against a global baseline and like onboarding against their own.');
  lines.push('');
  lines.push('**It is deliberately not graded.** There is no live traffic on this surface to');
  lines.push('calibrate a multiple against, and an invented cutoff read at 3am is worse than a');
  lines.push('number with no cutoff beside it. Note the two windows are different lengths, so');
  lines.push('the ratio is not normalised — read it with the counts, not instead of them.');
  lines.push('');
  lines.push('What ABL-524 §2 (S5) says to look for, none of which is in the ratio alone:');
  lines.push('  - a narrow, stable, scheduled set of fingerprints suddenly widening');
  lines.push('  - cursor pagination run to exhaustion across the parameter space');
  lines.push('  - start/end windows widening toward the 366-day bound');
  lines.push('  - a rate parked just *under* the limit, which reads differently from a client');
  lines.push('    that hits it and backs off');
  return lines;
}
