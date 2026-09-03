#!/usr/bin/env node
// Safe worktree removal (ABL-640, option 2).
//
//   npm run worktree:remove -- <path-to-worktree> [--dry-run]
//
// Drops every node_modules junction first, then calls git. `cmd /c rmdir` is
// the only removal guaranteed not to follow a junction; `git worktree remove
// --force` is the only one measured to follow it.
//
// This is the convenient path, not the control -- an agent that types the raw
// git command still gets there. `npm run guard:node-modules apply` is the
// control that makes the raw command harmless.
import { lstatSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { WORKTREE_LINK_PATHS, classifyLink, planLinkDrops, assertRemovableWorktree } from './worktreeGuard.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const target = args.find((a) => !a.startsWith('--'));

if (!target) {
  console.error('usage: npm run worktree:remove -- <path-to-worktree> [--dry-run]');
  process.exit(2);
}

const worktree = resolve(target);

// The main worktree owns the shared tree the junctions point at.
const common = spawnSync('git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
  encoding: 'utf8',
});
if (common.status !== 0) {
  console.error(`not a git worktree: ${worktree}`);
  console.error((common.stderr || '').trim());
  process.exit(2);
}
const primaryRoot = dirname(common.stdout.trim());

const guard = assertRemovableWorktree(worktree, primaryRoot);
if (!guard.ok) {
  console.error(`worktree:remove: ${guard.reason}`);
  process.exit(2);
}

const entries = WORKTREE_LINK_PATHS.map((rel) => {
  let st = null;
  try {
    st = lstatSync(join(worktree, rel));
  } catch {
    st = null;
  }
  return { path: rel, kind: classifyLink(st) };
});

const plan = planLinkDrops(entries);

console.log(`worktree : ${worktree}`);
console.log(`primary  : ${primaryRoot}`);
for (const e of entries) console.log(`  ${e.path.padEnd(22)} ${e.kind}`);

if (dryRun) {
  console.log(`\n--dry-run: would rmdir ${plan.drop.length} junction(s), then git worktree remove --force`);
  process.exit(0);
}

for (const rel of plan.drop) {
  const p = join(worktree, rel);
  const r = spawnSync('cmd', ['/c', 'rmdir', p], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`failed to drop junction ${p}: ${(r.stderr || r.stdout || '').trim()}`);
    console.error('ABORTING before git runs -- a live junction here is how the shared tree gets deleted.');
    process.exit(1);
  }
  console.log(`dropped junction: ${rel}`);
}

// Re-read: only hand git a worktree we have just confirmed carries no reparse point.
for (const rel of WORKTREE_LINK_PATHS) {
  let st = null;
  try {
    st = lstatSync(join(worktree, rel));
  } catch {
    st = null;
  }
  if (classifyLink(st) === 'junction') {
    console.error(`junction still present at ${rel} after rmdir -- refusing to call git.`);
    process.exit(1);
  }
}

const rm = spawnSync('git', ['-C', primaryRoot, 'worktree', 'remove', '--force', worktree], {
  encoding: 'utf8',
  stdio: 'inherit',
});
process.exit(rm.status ?? 1);
