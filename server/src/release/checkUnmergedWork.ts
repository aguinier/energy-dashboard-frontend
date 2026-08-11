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
import {
  classifyBranches,
  formatFindings,
  shippingGaps,
  type BranchTip,
} from './unmergedWork.js';

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

/** Local branches only. A remote-tracking ref is a copy of one, not extra work. */
function localBranches(): BranchTip[] {
  const out = git('for-each-ref', '--format=%(refname:short)%09%(objectname:short)', 'refs/heads/');
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, tip] = line.split('\t');
      return { name, tip, merged: isAncestor(tip) };
    })
    .filter((b) => b.name !== TARGET);
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

  if (!statuses) {
    console.log(
      `\n${branches.filter((b) => !b.merged).length} branch(es) not on ${TARGET}. ` +
        'Board status unavailable (set PAPERCLIP_API_URL / PAPERCLIP_API_KEY / ' +
        'PAPERCLIP_COMPANY_ID), so none of them could be judged.',
    );
    return 0;
  }

  const gaps = shippingGaps(findings);
  if (gaps.length === 0) {
    console.log(`\nNo shipping gaps: every issue marked done is on ${TARGET}.`);
    return 0;
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
