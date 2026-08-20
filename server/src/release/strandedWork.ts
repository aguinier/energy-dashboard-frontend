/**
 * Is any local branch the *only* copy of finished work?
 *
 * The third gate, and it exists because the first two are structurally blind to
 * the commonest remaining shape of the defect (ABL-498).
 *
 * On 2026-08-20 `predone` printed "No shipping gaps: every issue marked done is
 * on origin/main, and main is published." while six local branches held commits
 * whose patch was nowhere on the remote — one of them `ABL-469` (`6d2c1f3`), a
 * finished 16-file feature with tests, +1804/-35. Neither existing gate is wrong
 * on its own terms:
 *
 *   - `unmergedWork.ts` (gate 1) keys off *issue status*: only `done` + unmerged
 *     fails. ABL-469's issue read `blocked`, so its branch printed as a quiet
 *     `in flight` line and was never a failure. Correct by design — an in-flight
 *     branch is not a defect — but it means the one line that mattered looked
 *     exactly like the five beside it that did not.
 *   - `publishState.ts` (gate 2) asks only whether local `main` is ahead of the
 *     target. Work stranded one level below `main` leaves it at `0 ahead,
 *     0 behind`, so gate 2 passes cleanly and truthfully.
 *
 * Nothing asked the question that actually matters: *is there any local branch
 * holding a commit whose patch is not on the target?* That is what this answers.
 *
 * **Patch identity, not ancestry** — the same rule gate 1 already learned the
 * hard way. A raw `git rev-list --count origin/main..<branch>` reported eleven
 * non-ancestor branches on this checkout, of which five were phantoms already
 * cherry-picked onto `origin/main`. `git cherry <target> <branch>` printing no
 * `+` lines is what separates them, and quoting the raw count as a stranding
 * figure would be this repo's signature defect — a confidently wrong number —
 * committed by the very check meant to catch it.
 *
 * **Board-independent, like gate 2.** ABL-487 is the incident behind this: the
 * GitHub push credential expired, so no branch *could* be published, and
 * `predone` said everything was fine. A gate whose report degrades when a
 * credential dies is a gate that goes quiet at the exact moment work starts
 * piling up. This asks git and nothing else.
 *
 * Pure, as `publishState.ts` is: the caller hands over git's output, so every
 * verdict — including the numstat parse — is asserted without a repo, a remote
 * or a network.
 */
import type { BranchTip } from './unmergedWork.js';

/**
 * **This gate reports; it never fails the check. That is deliberate and it is
 * measured.**
 *
 * This is one physical checkout shared by many concurrent runs, so several
 * other agents' in-flight branches are present at all times: on 2026-08-20 the
 * six branches holding novel patches were ABL-469, ABL-93, ABL-460, ABL-494,
 * `claude/practical-panini-71e4bd` and `fix/frontend-wal-mount`, and exactly one
 * of those belonged to the run that was reading the report. Any exit-code rule
 * over that set is red on an ordinary working day, and `unmergedWork.ts`'s
 * header already records what happens next: "a check that cries wolf gets
 * ignored", which is precisely the failure this whole exercise is about.
 *
 * So the fix is not a new red light. It is that the *summary* can no longer read
 * as an all-clear while branches are stranded, and that each stranded branch
 * arrives with enough evidence — commit count, size against the merge base, age
 * — to tell a finished feature from a scratch commit. Gate 1 rendered ABL-469's
 * 16 files / +1804 and `fix/frontend-wal-mount`'s 1 file / +3 as the same line.
 *
 * Flipping this to `true` makes `predone` fail on every branch any concurrent
 * run has in flight. If a future checkout is single-tenant that may become the
 * right call — measure the branch population first, and do not infer it from
 * this comment.
 */
export const STRANDED_WORK_FAILS_CHECK = false;

/** Summed `git diff --numstat <target>...<tip>` — the branch against its merge base. */
export interface BranchDiffStat {
  /** Paths touched. A binary file counts here but contributes no lines. */
  files: number;
  insertions: number;
  deletions: number;
}

/**
 * One local branch, as the shell gathers it.
 *
 * Extends gate 1's `BranchTip` on purpose: both gates read one gathered list, so
 * the ancestry answer and the patch-identity count cannot disagree between them.
 * `novelCommits` is narrowed from optional to required-but-nullable, because a
 * caller that has not decided whether it measured is a caller that will be read
 * as clean — see `classifyStrandedBranch`.
 */
export interface LocalBranch extends BranchTip {
  /** Commits on this branch with no equivalent patch on the target. Null = not measured. */
  novelCommits: number | null;
  /** Committer date of the tip, ISO-8601. Null when unreadable. */
  lastCommitIso: string | null;
  /**
   * Size of the branch against its merge base with the target.
   *
   * Deliberately *not* called "unpublished lines": for a partially
   * cherry-picked branch this still counts the published hunks. It is the
   * figure the ABL-487 audit quoted, it is cheap and exactly defined, and it is
   * only ever rendered for a branch already established as stranded. Null when
   * not measured, which the report shows rather than hides.
   */
  diffVsMergeBase: BranchDiffStat | null;
  /** The branch this checkout currently has checked out. */
  current?: boolean;
}

export type StrandVerdict =
  /** Tip is an ancestor of the target. Nothing here. */
  | 'merged'
  /**
   * Not an ancestor, but every commit's patch is already on the target —
   * cherry-picked or rebased. The five phantoms. Counted, never listed.
   */
  | 'rebased'
  /** Measured: at least one commit whose patch is not on the target. */
  | 'stranded'
  /**
   * The patch-identity count could not be taken. Reported as if stranded — see
   * `classifyStrandedBranch` for why that direction and not the other.
   */
  | 'unmeasured';

export interface StrandedFinding {
  /**
   * Every local ref pointing at this tip, sorted; usually one.
   *
   * Several refs on one commit is the normal state of this checkout, not an
   * edge case — the Paperclip execution-workspace name and the hand-cut
   * convention name routinely coexist (`ABL-494-day-ahead-…` and
   * `fix/abl-494-per-stream-day-ahead-deadline` were both `16f27cb` on the day
   * this was written), and older tips carry up to five refs each. Counting them
   * as separate stranded work overstates the headline, which is the one thing
   * this gate must not do.
   */
  branches: string[];
  tip: string;
  verdict: StrandVerdict;
  novelCommits: number | null;
  diffVsMergeBase: BranchDiffStat | null;
  /** Whole days between the tip's committer date and `now`. Null when unknown. */
  ageDays: number | null;
  /** One of `branches` is what this checkout has checked out. */
  current: boolean;
}

/**
 * Sum a `git diff --numstat` block.
 *
 * Each line is `<added>\t<deleted>\t<path>`, and a binary file is reported as
 * `-\t-\t<path>`. A binary file is a real changed file and is counted as one,
 * but contributes no lines — inventing a line count for it would be a fabricated
 * number, and this repo has a NUL-byte-makes-git-say-binary scar already
 * (`keyFormat.test.ts`, ABL-300). A line that is not three tab-separated fields
 * is not numstat output and is skipped rather than guessed at.
 */
export function parseNumstat(raw: string): BranchDiffStat {
  let files = 0;
  let insertions = 0;
  let deletions = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;

    files += 1;
    const added = Number(parts[0]);
    const deleted = Number(parts[1]);
    // `Number('-')` is NaN, which is the binary case: counted as a file, no lines.
    if (Number.isInteger(added)) insertions += added;
    if (Number.isInteger(deleted)) deletions += deleted;
  }

  return { files, insertions, deletions };
}

/**
 * Is this branch's work provably already on the target?
 *
 * Exported so the shell can skip the expensive `git diff --numstat` for the
 * ~130 branches that are plainly published, without keeping a second copy of
 * the rule that decides it. `classifyStrandedBranch` calls the same function.
 *
 * Only a measured, integral `0` counts as published-under-other-shas. `null`,
 * `undefined`, a negative and a non-integer all mean "not measured", and fall
 * through to stranded.
 */
export function isPublishedBranch(branch: {
  merged: boolean;
  novelCommits?: number | null;
}): boolean {
  if (branch.merged) return true;
  const n = branch.novelCommits;
  return typeof n === 'number' && Number.isInteger(n) && n === 0;
}

/** Whole days from an ISO-8601 committer date to `nowMs`. Null when unusable. */
function ageInDays(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000));
}

/**
 * Classify one branch. `nowMs` is passed in rather than read from the clock, so
 * the age arithmetic is pinned by tests instead of drifting with the calendar.
 *
 * **Fail closed on an unmeasurable signal.** A branch whose `git cherry` count
 * could not be taken is `unmeasured` and is listed with the stranded ones,
 * because the two errors are not symmetric: over-reporting costs a reader one
 * line, and under-reporting is how work becomes the only copy of itself. Gate 1
 * establishes the same rule for the same reason.
 */
export function classifyStrandedBranch(
  branch: LocalBranch,
  nowMs: number,
): StrandedFinding {
  let verdict: StrandVerdict;
  if (branch.merged) verdict = 'merged';
  else if (isPublishedBranch(branch)) verdict = 'rebased';
  else if (branch.novelCommits === null || branch.novelCommits === undefined) {
    verdict = 'unmeasured';
  } else if (!Number.isInteger(branch.novelCommits) || branch.novelCommits < 0) {
    // Nonsense from a caller that mis-parsed `git cherry`. Not measured, and
    // must not read as an all-clear.
    verdict = 'unmeasured';
  } else verdict = 'stranded';

  return {
    branches: [branch.name],
    tip: branch.tip,
    verdict,
    novelCommits: verdict === 'unmeasured' ? null : (branch.novelCommits ?? null),
    diffVsMergeBase: branch.diffVsMergeBase,
    ageDays: ageInDays(branch.lastCommitIso, nowMs),
    current: branch.current === true,
  };
}

/** Worst first, so merging two findings can only ever be conservative. */
const SEVERITY: StrandVerdict[] = ['unmeasured', 'stranded', 'rebased', 'merged'];

/**
 * Fold every ref that points at one commit into a single finding.
 *
 * Two refs on the same tip get identical answers from `git merge-base` and
 * `git cherry` by construction, so in practice this only concatenates names.
 * It still merges conservatively — worst verdict, largest commit count, first
 * measured size — because a caller that hands over inconsistent records for one
 * commit must not have the disagreement resolved in the reassuring direction.
 */
function mergeByTip(findings: StrandedFinding[]): StrandedFinding[] {
  const byTip = new Map<string, StrandedFinding>();

  for (const f of findings) {
    const seen = byTip.get(f.tip);
    if (!seen) {
      byTip.set(f.tip, { ...f, branches: [...f.branches] });
      continue;
    }
    seen.branches = [...new Set([...seen.branches, ...f.branches])].sort((a, b) =>
      a.localeCompare(b),
    );
    seen.verdict =
      SEVERITY.indexOf(f.verdict) < SEVERITY.indexOf(seen.verdict) ? f.verdict : seen.verdict;
    seen.novelCommits =
      seen.verdict === 'unmeasured'
        ? null
        : Math.max(seen.novelCommits ?? 0, f.novelCommits ?? 0);
    seen.diffVsMergeBase = seen.diffVsMergeBase ?? f.diffVsMergeBase;
    seen.ageDays = seen.ageDays ?? f.ageDays;
    seen.current = seen.current || f.current;
  }

  return [...byTip.values()];
}

/**
 * Sort key. Lower sorts first.
 *
 * `unmeasured` leads because it is the one verdict nobody has confirmed. The
 * branch this checkout is *on* sorts below the other stranded ones whatever its
 * verdict — it is the reader's own live work and needs no action right now,
 * and burying the five branches that do need one beneath it would recreate the
 * problem this gate exists to fix.
 */
function rank(f: StrandedFinding): number {
  if (f.verdict === 'merged') return 5;
  if (f.verdict === 'rebased') return 4;
  if (f.current) return 3;
  return f.verdict === 'unmeasured' ? 0 : 1;
}

/** Total lines touched, for ordering. Unknown sorts first, never last. */
function changedLines(f: StrandedFinding): number {
  const d = f.diffVsMergeBase;
  return d ? d.insertions + d.deletions : Number.POSITIVE_INFINITY;
}

/**
 * Classify every branch, biggest unpublished body of work first.
 *
 * Size ordering is the whole point of the gate: on the checkout that produced
 * ABL-498 it puts ABL-469 (16 files, +1804/-35) at the top and
 * `fix/frontend-wal-mount` (1 file, +3/-1) at the bottom, where gate 1 rendered
 * the two as indistinguishable lines. Every finding is returned, including
 * `merged` and `rebased` — `formatStrandedWork` decides what to print, so a
 * caller can still count what was filtered out.
 */
export function classifyStrandedBranches(
  branches: LocalBranch[],
  nowMs: number,
): StrandedFinding[] {
  return mergeByTip(branches.map((b) => classifyStrandedBranch(b, nowMs))).sort(
    (a, b) =>
      rank(a) - rank(b) ||
      changedLines(b) - changedLines(a) ||
      a.branches[0].localeCompare(b.branches[0]),
  );
}

/** The findings this gate reports: real unpublished work, and anything unmeasured. */
export function strandedFindings(findings: StrandedFinding[]): StrandedFinding[] {
  return findings.filter(
    (f) => f.verdict === 'stranded' || f.verdict === 'unmeasured',
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function describeSize(d: BranchDiffStat | null): string {
  if (!d) return 'size not measured';
  return `${plural(d.files, 'file')} +${d.insertions}/-${d.deletions} vs merge base`;
}

function describeCommits(f: StrandedFinding): string {
  if (f.verdict === 'unmeasured' || f.novelCommits === null) {
    return 'novel-commit count UNMEASURED';
  }
  return `${plural(f.novelCommits, 'commit')} not on the target`;
}

function describeAge(days: number | null): string {
  if (days === null) return 'age unknown';
  return days === 0 ? 'committed today' : `${plural(days, 'day')} since last commit`;
}

/**
 * One clause for the caller's summary line, so `predone`'s final sentence can
 * never read as an all-clear while branches are stranded. Empty when there is
 * nothing to say.
 *
 * That sentence — "No shipping gaps: every issue marked done is on origin/main,
 * and main is published." — is what a reader skims to, and on 2026-08-20 it was
 * true and complete and still left six branches unaccounted for.
 */
export function strandedHeadline(findings: StrandedFinding[]): string {
  const stranded = strandedFindings(findings);
  if (stranded.length === 0) return '';
  const others = stranded.filter((f) => !f.current).length;
  const tail = others === stranded.length ? '' : ` (${others} of them not the commit you are on)`;
  // Counted by commit, not by ref: several branch names on one tip is one body
  // of unpublished work, and reporting it as several would overstate the
  // figure this whole gate turns on.
  return (
    `${plural(stranded.length, 'local commit', 'local commits')} carry work ` +
    `that is not on the target${tail} — listed above.`
  );
}

/**
 * Render the gate for a terminal. Returns '' when every branch is published, so
 * a caller can treat empty as clean.
 *
 * Rebased branches are **counted and not listed**. Listing them is what makes a
 * report skimmable-past — five verbose paragraphs about branches that are safe
 * to delete pushed the one that mattered off the top of the screen. The count
 * stays because it is the evidence that patch identity ran at all: without it,
 * "6 stranded" and a raw ancestry count of 11 are indistinguishable to a reader.
 */
export function formatStrandedWork(findings: StrandedFinding[], target: string): string {
  const stranded = strandedFindings(findings);
  const rebased = findings.filter((f) => f.verdict === 'rebased').length;
  if (stranded.length === 0 && rebased === 0) return '';

  const lines: string[] = [];

  if (stranded.length > 0) {
    const refs = stranded.reduce((n, f) => n + f.branches.length, 0);
    const refNote = refs === stranded.length ? '' : ` (across ${plural(refs, 'local ref')})`;
    lines.push(
      `STRANDED WORK  ${plural(stranded.length, 'commit')}${refNote} not on ${target}:`,
    );
    for (const f of stranded) {
      const [lead, ...also] = f.branches;
      const marker = f.current ? ', checked out here' : '';
      lines.push(`  ${lead} (${f.tip}${marker})`);
      if (also.length > 0) lines.push(`      also at: ${also.join(', ')}`);
      lines.push(
        `      ${describeCommits(f)}; ${describeSize(f.diffVsMergeBase)}; ${describeAge(f.ageDays)}.`,
      );
    }
    lines.push(
      `  Publish what is finished, or accept it is unpublished — a branch is the ` +
        `only copy of its work until its patch is on ${target}.`,
    );
  }

  if (rebased > 0) {
    lines.push(
      `  Excluded by patch identity: ${plural(rebased, 'commit')} not an ancestor ` +
        `of ${target} but carrying no novel patch (already there under other shas).`,
    );
  }

  return lines.join('\n');
}
