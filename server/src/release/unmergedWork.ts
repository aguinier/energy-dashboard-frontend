/**
 * Is the work an issue was closed on actually on `main`?
 *
 * The repo convention is branch-per-concern *then merge to local `main`*. ABL-76
 * found five issues marked `done` whose branch was created, committed, and never
 * merged — three of them entirely absent from `main` and `origin/main`,
 * including ABL-58, a live confidently-wrong-number defect that was in prod for
 * a week because prod is built from `main`. Nothing caught it: branch existence
 * and issue status were both treated as proof of shipping, and neither is.
 *
 * The rule is one line of git — `git merge-base --is-ancestor <tip> main` — and
 * the reason it needs a module is the *join*. An unmerged branch on its own is
 * normal and constant: it is what in-flight work looks like. It only means
 * something next to the issue's status. So this classifies (branch, issue
 * status) pairs, and only `done` + unmerged is a defect.
 *
 * **Ancestry alone over-reports, and a check that cries wolf gets disabled.**
 * That is not a hypothetical: run against this repo on 2026-08-12 the ancestry
 * rule reported *seven* shipping gaps, and three of them were false — ABL-166
 * (`3c42ec8`), ABL-216 (`484b3e2`) and ABL-249 (`d84e97b`) had every one of
 * their commits already on `origin/main` under a different sha, landed by
 * cherry-pick or rebase. A tip that is not an ancestor says the *commit* did not
 * reach the target; it does not say the *work* did not. Reporting 3 phantom
 * gaps beside 4 real ones is how the next reader learns to skim past the word
 * SHIPPING GAP, which costs more than the check earns.
 *
 * So a branch is judged on two signals, and the second is patch identity:
 * `git cherry <target> <tip>` marks each commit `+` (its patch is not on the
 * target) or `-` (an equivalent patch is). Zero `+` lines means the work is
 * published under other shas — the `rebased` verdict, reported quietly and
 * never failed. One or more means real, unpublished work, and the issue status
 * decides from there exactly as before.
 *
 * This stays **fail-closed**, deliberately, in the one place the second signal
 * is weak: a squash merge collapses N commits into one whose patch-id matches
 * none of them, so a squash-merged branch still reads as novel and still gets
 * reported. Over-reporting there is the safe direction, and this repo merges
 * with merge commits rather than squashes, so it is also rare. `novelCommits`
 * is likewise optional — `null` or absent means "not measured", and an
 * unmeasured branch is judged on ancestry alone, the pre-existing behaviour.
 * A signal that could not be gathered must never be read as an all-clear.
 *
 * Everything here is pure — the caller supplies the branch list, the ancestry
 * answers, the patch-identity counts and the status map, so the classification
 * is unit-testable without a repo or a network. `checkUnmergedWork.ts` is the
 * thin shell that gathers those inputs.
 */

/**
 * The one issue status that makes an unmerged branch a defect.
 *
 * Everything else is a legitimate reason for a branch to be behind `main`:
 * `in_progress`/`todo`/`backlog` have not claimed to be finished, `blocked` and
 * `in_review` explicitly have not. If Paperclip gains another terminal status
 * (a `cancelled`, say) think before adding it — cancelled work is *supposed* to
 * stay unmerged, so it belongs in the ignore list, not here.
 */
export const SHIPPED_STATUSES = new Set(['done']);

export type Verdict =
  /** Tip is an ancestor of the target ref. Nothing to do. */
  | 'merged'
  /**
   * Tip is not an ancestor, but every commit on it has an equivalent patch on
   * the target — cherry-picked or rebased. The work shipped; only the shas
   * differ. Not a gap, and the branch is safe to delete.
   */
  | 'rebased'
  /** Closed as done, but the code is not on the target ref. The defect. */
  | 'shipping-gap'
  /** Unmerged, and the issue does not claim to be finished. Normal. */
  | 'in-flight'
  /** Unmerged, names an issue the board does not have. Reported, not failed. */
  | 'unknown-issue'
  /** Unmerged, and the branch name names no issue at all. Reported, not failed. */
  | 'unattributed';

export interface BranchTip {
  name: string;
  /** Short sha, for the report. */
  tip: string;
  /** `git merge-base --is-ancestor tip <target>` succeeded. */
  merged: boolean;
  /**
   * Commits on this branch whose patch is *not* already on the target — the
   * count of `+` lines from `git cherry <target> <tip>`.
   *
   * `0` means every commit landed on the target under a different sha. Omitted
   * or `null` means the count could not be taken, and is judged on ancestry
   * alone rather than assumed clean.
   */
  novelCommits?: number | null;
}

export interface Finding {
  branch: string;
  tip: string;
  /** Issue identifier read out of the branch name, e.g. `ABL-58`. */
  issue: string | null;
  /** Status as the board reports it, or null when the board has no such issue. */
  issueStatus: string | null;
  verdict: Verdict;
}

/**
 * Pull an issue identifier out of a branch name.
 *
 * Both shapes this repo uses are covered, because both produced an unmerged
 * branch in the ABL-76 audit: the Paperclip execution-workspace form
 * (`ABL-15-automate-the-claude-md-citation-check`) and the hand-cut convention
 * form (`fix/abl-35-impossible-zero-load-actuals`, `docs/abl-21-join-site-shapes`).
 *
 * The digit run is taken whole so `abl-6` and `abl-60` cannot be confused, and
 * the identifier is normalised to upper case because the two shapes disagree on
 * that. Returns null for a branch that names no issue (`main`,
 * `feat/accuracy-model-param`, `claude/nervous-mcnulty-abf971`) — those are
 * reported as unattributed rather than guessed at.
 */
export function issueFromBranch(branch: string): string | null {
  const m = /(?:^|[/-])abl-(\d+)(?![0-9])/i.exec(branch);
  return m ? `ABL-${m[1]}` : null;
}

/**
 * Has every commit on this branch already landed on the target under some other
 * sha?
 *
 * Only an explicit, measured `0` counts. `undefined` and `null` both mean the
 * count was never taken — by an older caller, or because the git command
 * failed — and must fall through to the ancestry judgement rather than read as
 * an all-clear. A negative or non-integer count is nonsense from a caller that
 * mis-parsed `git cherry`, and is treated the same way: not measured.
 */
function isPublishedUnderOtherShas(branch: BranchTip): boolean {
  const n = branch.novelCommits;
  return typeof n === 'number' && Number.isInteger(n) && n === 0;
}

/**
 * Classify one branch. `statusByIssue` is the board's answer keyed by
 * identifier; a missing key means the board does not know the issue, which is
 * reported rather than treated as either state.
 *
 * Order matters: ancestry first (the cheapest and strongest signal), then patch
 * identity, and only then the issue status. A branch whose work is on the
 * target is not a gap no matter what the board says about it.
 */
export function classifyBranch(
  branch: BranchTip,
  statusByIssue: Map<string, string>,
): Finding {
  const issue = issueFromBranch(branch.name);
  const issueStatus = issue ? (statusByIssue.get(issue) ?? null) : null;

  let verdict: Verdict;
  if (branch.merged) verdict = 'merged';
  else if (isPublishedUnderOtherShas(branch)) verdict = 'rebased';
  else if (!issue) verdict = 'unattributed';
  else if (issueStatus === null) verdict = 'unknown-issue';
  else if (SHIPPED_STATUSES.has(issueStatus)) verdict = 'shipping-gap';
  else verdict = 'in-flight';

  return { branch: branch.name, tip: branch.tip, issue, issueStatus, verdict };
}

/**
 * Classify every branch, worst first so the report leads with the defect.
 *
 * `merged` branches are dropped: on a repo with dozens of old branches they are
 * the overwhelming majority and listing them buries the two lines that matter.
 * `rebased` branches are *kept*, last — there are few of them, and each one is
 * an old branch whose work has shipped, which is exactly the list you want when
 * deciding what to delete. Dropping them would also hide the reason a gap this
 * check used to report has stopped being reported.
 */
export function classifyBranches(
  branches: BranchTip[],
  statusByIssue: Map<string, string>,
): Finding[] {
  const order: Verdict[] = [
    'shipping-gap',
    'unknown-issue',
    'in-flight',
    'unattributed',
    'rebased',
  ];
  return branches
    .map((b) => classifyBranch(b, statusByIssue))
    .filter((f) => f.verdict !== 'merged')
    .sort(
      (a, b) =>
        order.indexOf(a.verdict) - order.indexOf(b.verdict) ||
        a.branch.localeCompare(b.branch),
    );
}

/** The findings that should fail the check. */
export function shippingGaps(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.verdict === 'shipping-gap');
}

/**
 * Render findings for a terminal. Returns '' when there is nothing to say, so a
 * caller can treat empty as clean.
 */
export function formatFindings(findings: Finding[], target: string): string {
  if (findings.length === 0) return '';
  const lines: string[] = [];
  for (const f of findings) {
    const issue = f.issue ?? '(no issue in branch name)';
    switch (f.verdict) {
      case 'shipping-gap':
        lines.push(
          `SHIPPING GAP  ${issue} reads "${f.issueStatus}" but ${f.branch} (${f.tip}) is not on ${target}.`,
        );
        break;
      case 'unknown-issue':
        lines.push(
          `unknown issue ${issue} named by ${f.branch} (${f.tip}); not on the board, so its status could not be checked.`,
        );
        break;
      case 'in-flight':
        lines.push(`in flight     ${issue} ("${f.issueStatus}") — ${f.branch} (${f.tip}).`);
        break;
      case 'unattributed':
        lines.push(`unattributed  ${f.branch} (${f.tip}) — names no issue.`);
        break;
      case 'rebased':
        lines.push(
          `already on ${target}  ${f.branch} (${f.tip}) — the tip is not an ancestor, ` +
            `but every commit's patch is already there (cherry-picked or rebased). ` +
            `Safe to delete the branch.`,
        );
        break;
      case 'merged':
        break;
    }
  }
  return lines.join('\n');
}
