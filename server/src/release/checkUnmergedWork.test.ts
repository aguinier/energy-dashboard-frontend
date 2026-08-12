/**
 * Integration proof that a locally-committed-but-unpushed commit is reported
 * as unmerged when the target is `origin/main`.
 *
 * This is the property that checkUnmergedWork.ts must preserve (ABL-266).
 * Prior to ABL-190 the target was local `main`, so a merge that never reached
 * the remote passed the check silently — producing ABL-136, ABL-189/190,
 * ABL-196, ABL-251, ABL-262.
 *
 * The test creates a minimal git topology:
 *   remote.git (bare)  ←── clone (repo)
 *
 * then commits on a feature branch, merges to local main, and does NOT push.
 * It asserts that `git merge-base --is-ancestor <tip> origin/main` fails — the
 * git primitive that `isAncestor()` in checkUnmergedWork.ts wraps.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('checkUnmergedWork — locally-committed-but-unpushed detection', () => {
  let tmpDir: string;
  let remoteDir: string;
  let repoDir: string;
  let featureTip: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'abl266-'));
    remoteDir = join(tmpDir, 'remote.git');
    repoDir = join(tmpDir, 'repo');

    function g(args: string[], cwd: string) {
      execFileSync('git', args, { cwd, stdio: 'ignore' });
    }

    // Bare remote (acts as origin)
    execFileSync('git', ['init', '--bare', remoteDir], { stdio: 'ignore' });

    // Working clone
    g(['clone', remoteDir, repoDir], tmpDir);
    g(['config', 'user.email', 'test@example.com'], repoDir);
    g(['config', 'user.name', 'Test'], repoDir);
    // Disable CRLF conversion inside the temp repo so the test is host-agnostic
    g(['config', 'core.autocrlf', 'false'], repoDir);

    // Initial commit on main — pushed so origin/main exists
    g(['checkout', '-b', 'main'], repoDir);
    writeFileSync(join(repoDir, 'README.md'), 'hello');
    g(['add', 'README.md'], repoDir);
    g(['commit', '-m', 'initial'], repoDir);
    g(['push', '--set-upstream', 'origin', 'main'], repoDir);

    // Feature branch: one commit that will be merged locally but never pushed
    g(['checkout', '-b', 'feat/abl-999-test-issue'], repoDir);
    writeFileSync(join(repoDir, 'feature.txt'), 'work done here');
    g(['add', 'feature.txt'], repoDir);
    g(['commit', '-m', 'feat: ABL-999 new work'], repoDir);

    featureTip = execFileSync('git', ['rev-parse', 'feat/abl-999-test-issue'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();

    // Merge to local main — simulates engineer marking the issue done locally
    g(['checkout', 'main'], repoDir);
    g(['merge', '--no-ff', 'feat/abl-999-test-issue'], repoDir);
    // Intentionally NOT pushing — this is the failure scenario
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('tip is an ancestor of local main (old behaviour would have seen it as merged)', () => {
    // This would have made the pre-ABL-190 check pass silently.
    expect(() => {
      execFileSync('git', ['merge-base', '--is-ancestor', featureTip, 'main'], {
        cwd: repoDir,
        stdio: 'ignore',
      });
    }).not.toThrow();
  });

  it('tip is NOT an ancestor of origin/main — locally-committed-but-unpushed is correctly detected as unmerged', () => {
    // This is the check that checkUnmergedWork.ts now uses (ABL-266).
    // git merge-base --is-ancestor exits non-zero when tip is not an ancestor.
    expect(() => {
      execFileSync('git', ['merge-base', '--is-ancestor', featureTip, 'origin/main'], {
        cwd: repoDir,
        stdio: 'ignore',
      });
    }).toThrow();
  });
});
