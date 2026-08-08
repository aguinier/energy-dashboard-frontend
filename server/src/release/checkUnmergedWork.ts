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
 */
import { execFileSync } from 'node:child_process';
import {
  classifyBranches,
  formatFindings,
  shippingGaps,
  type BranchTip,
} from './unmergedWork.js';

const TARGET = process.env.CHECK_UNMERGED_TARGET ?? 'main';

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

process.exitCode = await main();
