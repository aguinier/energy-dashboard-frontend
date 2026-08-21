/**
 * `npm run check:unmerged -w server` — did the work an issue was closed on
 * actually reach `main`?
 *
 * The thin shell around `unmergedWork.ts`: gather the branch list and the
 * ancestry answers from git, the issue statuses from the Paperclip board, hand
 * all three to the pure classifier, print, exit 1 on a shipping gap.
 *
 * Kept out of the vitest suite on purpose. A test that fails whenever an
 * unmerged branch exists would be red on every working branch, every day, and a
 * check that cries wolf gets ignored — which is the failure this whole exercise
 * is about. The *logic* is tested (unmergedWork.test.ts, 18 cases); this is the
 * part that has to be run at the moment an issue is closed. Run it before
 * marking anything `done`.
 *
 * Requires PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID. Without
 * them it still runs and lists unmerged branches, but it cannot tell a shipping
 * gap from in-flight work, so it reports and exits 0 rather than guessing.
 *
 * Three gates run, and only the first depends on the board (ABL-311, ABL-498):
 *
 *   1. Per-branch: `done` + not on the target = shipping gap.
 *   2. `main` itself: local `main` ahead of the target = not published.
 *   3. Every local branch: any commit whose patch is not on the target = stranded.
 *
 * Gate 1 asks git two questions per branch, not one: is the tip an ancestor of
 * the target, and — when it is not — how many of its commits have no equivalent
 * patch there (`git cherry`). A branch that was cherry-picked or rebased onto
 * the target fails the first test and passes the second, and reporting it as a
 * gap is a false alarm. See `unmergedWork.ts` for why that mattered enough to
 * add: on 2026-08-12 three of the seven gaps this check reported were phantoms.
 *
 * Gate 2 exists because gate 1 structurally cannot see the commonest form of
 * the defect. It keys on an issue identifier in the branch name, and `main` has
 * none, so a `main` twelve commits ahead of `origin/main` classified as
 * `unattributed` — "reported, not failed" — and the check exited 0. That is
 * exactly what happened on 2026-08-12 with five issues reading `done`. Gate 2
 * also survives the branch being deleted after merge, and a commit made
 * straight to `main`, neither of which leaves a tip for gate 1 to classify.
 * See `publishState.ts` for the classification and its tests.
 *
 * Gate 3 exists because gates 1 and 2 between them still left the 2026-08-20
 * state reading clean: six local branches held the only copy of their work —
 * one of them a finished 16-file feature — while `main` sat 0 ahead and every
 * `done` issue was published, so the last line of this command said "No
 * shipping gaps". Gate 3 asks the question neither of the others does: is any
 * local branch holding a commit whose patch is not on the target? It reports
 * and never fails (this checkout always carries other runs' in-flight
 * branches), so what it changes is the summary and the evidence — see
 * `strandedWork.ts` for the measurement behind that decision.
 *
 * The target defaults to `origin/main`, not local `main` (ABL-190). The repo
 * workflow ends feature work by merging to local `main`, so a target of local
 * `main` makes a branch that is merged-but-never-pushed look shipped — that is
 * exactly how ABL-136's 11-commit backlog passed this check clean. Comparing
 * against `origin/main` after an explicit fetch turns "merged locally, never
 * pushed" back into a reported gap. `CHECK_UNMERGED_TARGET` still overrides
 * this for a deliberate local run — set it and the fetch is skipped, since
 * naming a specific ref by hand is the whole point of the override.
 */
import { execFileSync } from 'node:child_process';
import { classifyBranches, formatFindings, shippingGaps } from './unmergedWork.js';
import {
  classifyPublishState,
  formatPublishState,
  isPublishGap,
  type PublishCounts,
} from './publishState.js';
import {
  classifyStrandedBranches,
  formatStrandedWork,
  isPublishedBranch,
  parseNumstat,
  strandedHeadline,
  type BranchDiffStat,
  type LocalBranch,
} from './strandedWork.js';

const TARGET_OVERRIDE = process.env.CHECK_UNMERGED_TARGET;
const TARGET = TARGET_OVERRIDE ?? 'origin/main';

/**
 * Refuse to compare against a stale or missing target ref. The fetch is
 * skipped when `CHECK_UNMERGED_TARGET` is set — that override names a
 * specific ref by hand for a deliberate local run, so there is nothing to
 * freshen. The resolution check still applies either way: a typo'd or
 * missing target must not be allowed to make every branch look unmerged
 * (or, worse, every branch look merged) — the whole point is to fail loudly
 * rather than let a bad target silently misclassify everything.
 */
function ensureTargetIsFresh(): void {
  if (!TARGET_OVERRIDE) {
    try {
      execFileSync('git', ['fetch', 'origin'], { stdio: 'ignore' });
    } catch (err) {
      throw new Error(
        `git fetch origin failed: ${(err as Error).message}\n` +
          `Refusing to fall back to local main — a silent fallback to a possibly-unpushed ` +
          `local ref is the exact failure this check exists to catch (ABL-136, ABL-190).`,
      );
    }
  }
  try {
    execFileSync('git', ['rev-parse', '--verify', `${TARGET}^{commit}`], { stdio: 'ignore' });
  } catch {
    throw new Error(
      `Target ref '${TARGET}' does not resolve${TARGET_OVERRIDE ? '' : " even after 'git fetch origin'"}. ` +
        'Refusing to silently fall back to local main.',
    );
  }
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/**
 * Commits on `tip` whose patch is not already on the target.
 *
 * `git cherry <target> <tip>` prints one line per commit: `+` when its patch is
 * absent from the target, `-` when an equivalent patch is already there. Zero
 * `+` lines means the branch's work shipped under different shas, which
 * `unmergedWork.ts` reports as `rebased` rather than as a gap — three of the
 * seven gaps this check reported on 2026-08-12 were that case.
 *
 * Returns null when the count cannot be taken (an unborn or corrupt ref, a
 * `git cherry` that errors). Null is judged on ancestry alone, so a failure
 * here can only over-report, never under-report.
 */
function novelCommitCount(tip: string): number | null {
  try {
    const out = execFileSync('git', ['cherry', TARGET, tip], { encoding: 'utf8' });
    return out.split('\n').filter((line) => line.startsWith('+')).length;
  } catch {
    return null;
  }
}

/**
 * Size of a branch against its merge base with the target.
 *
 * Gathered only for branches gate 3 has already established as stranded — this
 * checkout carries ~140 local branches and diffing all of them would make
 * `predone` slow enough to skip, which is its own failure mode.
 *
 * Returns null when the diff cannot be taken; `strandedWork.ts` renders that as
 * "size not measured" rather than as a zero.
 */
function branchDiffStat(tip: string): BranchDiffStat | null {
  try {
    // Three dots: diff the branch against its merge base, not against the
    // target's tip, so unrelated commits landed on the target since the fork
    // are not counted as this branch's work.
    return parseNumstat(
      execFileSync('git', ['diff', '--numstat', `${TARGET}...${tip}`], { encoding: 'utf8' }),
    );
  } catch {
    return null;
  }
}

/** The branch this checkout has checked out, or null when HEAD is detached. */
function currentBranch(): string | null {
  try {
    return execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

/** Local branches only. A remote-tracking ref is a copy of one, not extra work. */
function localBranches(): LocalBranch[] {
  const head = currentBranch();
  const out = git(
    'for-each-ref',
    '--format=%(refname:short)%09%(objectname:short)%09%(committerdate:iso-strict)',
    'refs/heads/',
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, tip, lastCommitIso] = line.split('\t');
      const merged = isAncestor(tip);
      // Only worth asking for a branch that failed the ancestry test — an
      // ancestor is already the strongest possible answer.
      const novelCommits = merged ? null : novelCommitCount(tip);
      const published = isPublishedBranch({ merged, novelCommits });
      return {
        name,
        tip,
        merged,
        novelCommits,
        lastCommitIso: lastCommitIso ?? null,
        // Same predicate gate 3 classifies with, so the skip can never disagree
        // with the verdict about which branches are worth measuring.
        diffVsMergeBase: published ? null : branchDiffStat(tip),
        current: name === head,
      };
    })
    .filter((b) => b.name !== TARGET);
}

/**
 * Ahead/behind for local `main` against the target, from the one command that
 * reports both — `git rev-list --left-right --count <target>...main` prints
 * "<only-on-target>\t<only-on-main>", so behind is left and ahead is right.
 * Two separate counts could disagree with each other if the refs moved between
 * them; this cannot.
 *
 * Returns null when there is no local `main` to compare, which
 * `classifyPublishState` reports rather than fails.
 */
function publishCounts(): PublishCounts | null {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'main^{commit}'], { stdio: 'ignore' });
  } catch {
    return null;
  }
  const [behind, ahead] = git('rev-list', '--left-right', '--count', `${TARGET}...main`)
    .split(/\s+/)
    .map(Number);
  return { ahead, behind };
}

function isAncestor(tip: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', tip, TARGET], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function boardStatuses(): Promise<Map<string, string> | null> {
  const rawUrl = process.env.PAPERCLIP_API_URL;
  const key = process.env.PAPERCLIP_API_KEY;
  const company = process.env.PAPERCLIP_COMPANY_ID;
  if (!rawUrl || !key || !company) return null;

  const base = rawUrl.replace(/\/$/, '').replace(/\/api$/, '');
  const res = await fetch(`${base}/api/companies/${company}/issues?limit=500`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`board returned ${res.status} ${res.statusText}`);

  const issues = (await res.json()) as Array<{ identifier?: string; status?: string }>;
  const map = new Map<string, string>();
  for (const i of issues) {
    if (i.identifier && i.status) map.set(i.identifier.toUpperCase(), i.status);
  }
  return map;
}

async function main(): Promise<number> {
  ensureTargetIsFresh();

  // Gate 2 first, and unconditionally: it needs nothing but git, so it is the
  // one answer this command can always give. Every early return below has to
  // carry it, which is why it is a variable and not a `return` here.
  const counts = publishCounts();
  const publishVerdict = classifyPublishState(counts);
  console.log(formatPublishState(publishVerdict, counts, TARGET));
  const publishGap = isPublishGap(publishVerdict);

  const branches = localBranches();

  let statuses: Map<string, string> | null = null;
  try {
    statuses = await boardStatuses();
  } catch (err) {
    console.error(`Could not read the board: ${(err as Error).message}`);
  }

  const findings = classifyBranches(branches, statuses ?? new Map());
  const report = formatFindings(findings, TARGET);

  if (report) console.log(report);

  // Gate 3. Printed before every summary sentence below and regardless of the
  // board, because the incident it exists for (ABL-487) was a dead push
  // credential — the condition under which the board half is least likely to be
  // reachable and stranded work is most likely to be piling up.
  const stranded = classifyStrandedBranches(branches, Date.now());
  const strandReport = formatStrandedWork(stranded, TARGET);
  if (strandReport) console.log(`\n${strandReport}`);
  const strandNote = strandedHeadline(stranded);

  if (!statuses) {
    console.log(
      // "not an ancestor", not "unpublished": this is the raw count, and five
      // of the thirteen it reported on 2026-08-20 were phantoms already on the
      // target under other shas. Gate 3's figure below is the measured one, and
      // the two must not read as competing answers to the same question.
      `\n${branches.filter((b) => !b.merged).length} branch(es) are not ancestors of ${TARGET}. ` +
        'Board status unavailable (set PAPERCLIP_API_URL / PAPERCLIP_API_KEY / ' +
        'PAPERCLIP_COMPANY_ID), so none of them could be judged.' +
        (strandNote ? ` Gate 3 needs no board: ${strandNote}` : ''),
    );
    return publishGap ? 1 : 0;
  }

  const gaps = shippingGaps(findings);
  if (gaps.length === 0) {
    if (!publishGap) {
      // The sentence a reader skims to. On 2026-08-20 it was true, complete and
      // still left six branches unaccounted for, so it never stands alone now.
      console.log(
        `\nNo shipping gaps: every issue marked done is on ${TARGET}, ` +
          `and main is published.` +
          (strandNote ? `\nBut ${strandNote}` : ''),
      );
    }
    return publishGap ? 1 : 0;
  }
  console.log(
    `\n${gaps.length} issue(s) marked done with work that is not on ${TARGET}. ` +
      'Merge the branch, or reopen the issue.',
  );
  return 1;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(`check:unmerged: ${(err as Error).message}`);
  process.exitCode = 1;
}
