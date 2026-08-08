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
 * Everything here is pure — the caller supplies the branch list, the ancestry
 * answers and the status map, so the classification is unit-testable without a
 * repo or a network. `checkUnmergedWork.ts` is the thin shell that gathers those
 * three inputs.
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
 * Classify one branch. `statusByIssue` is the board's answer keyed by
 * identifier; a missing key means the board does not know the issue, which is
 * reported rather than treated as either state.
 */
export function classifyBranch(
  branch: BranchTip,
  statusByIssue: Map<string, string>,
): Finding {
  const issue = issueFromBranch(branch.name);
  const issueStatus = issue ? (statusByIssue.get(issue) ?? null) : null;

  let verdict: Verdict;
  if (branch.merged) verdict = 'merged';
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
 */
export function classifyBranches(
  branches: BranchTip[],
  statusByIssue: Map<string, string>,
): Finding[] {
  const order: Verdict[] = ['shipping-gap', 'unknown-issue', 'in-flight', 'unattributed'];
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
      case 'merged':
        break;
    }
  }
  return lines.join('\n');
}
