#!/usr/bin/env node
// The control (ABL-640). Makes the shared node_modules mechanically undeletable
// rather than asking agents to remember an ordering rule -- which was written in
// two places and lost four times.
//
//   npm run guard:node-modules status
//   npm run guard:node-modules apply
//   npm run guard:node-modules release
//
// A deny-DELETE ACE on the shared tree makes `git worktree remove --force`
// abort on its first unlink with the tree fully intact. Reads, additive writes
// and overwrites are untouched, so Node resolution and the donor-copy repair
// both still work; only deletes inside the tree are refused.
//
// Cost of the guard being on: a raw `git worktree remove --force` against a
// junctioned worktree now FAILS and leaves the worktree behind. That is the
// intended trade -- a leftover directory is cheap and visible, a destroyed
// shared tree is expensive and silent. Use `npm run worktree:remove` instead.
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  PROTECTED_PATHS,
  buildDenyAclArgs,
  buildReleaseAclArgs,
  resolvePrincipal,
  icaclsSucceeded,
} from './worktreeGuard.mjs';

const cmd = process.argv[2] ?? 'status';
if (!['status', 'apply', 'release'].includes(cmd)) {
  console.error('usage: npm run guard:node-modules [status|apply|release]');
  process.exit(2);
}

if (process.platform !== 'win32') {
  console.error('guard:node-modules is Windows-only (NTFS ACLs); nothing to do.');
  process.exit(0);
}

// Always guard the PRIMARY checkout's tree -- that is the junction target, and
// it is the same tree whether this script is run from a worktree or from the
// checkout itself.
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const common = spawnSync('git', ['-C', here, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
  encoding: 'utf8',
});
const primaryRoot = common.status === 0 ? dirname(common.stdout.trim()) : here;

const principal = resolvePrincipal(process.env);
console.log(`primary   : ${primaryRoot}`);
console.log(`principal : ${principal}\n`);

let failed = 0;

for (const rel of PROTECTED_PATHS) {
  const target = join(primaryRoot, rel);
  if (!existsSync(target)) {
    console.log(`${rel.padEnd(40)} ABSENT (skipped)`);
    continue;
  }

  if (cmd === 'status') {
    const r = spawnSync('icacls', [target], { encoding: 'utf8' });
    const denied = (r.stdout || '')
      .split('\n')
      .some((l) => l.includes('(DENY)') && l.toLowerCase().includes(principal.toLowerCase()));
    console.log(`${rel.padEnd(40)} ${denied ? 'PROTECTED' : 'UNPROTECTED'}`);
    if (!denied) failed = 1;
    continue;
  }

  const args = cmd === 'apply' ? buildDenyAclArgs(target, principal) : buildReleaseAclArgs(target, principal);
  const r = spawnSync('icacls', args, { encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ok = r.status === 0 && icaclsSucceeded(out);
  console.log(`${rel.padEnd(40)} ${cmd} ${ok ? 'OK' : 'FAILED'}`);
  if (!ok) {
    console.error(out.trim());
    failed = 1;
  }
}

if (cmd === 'apply' && !failed) {
  console.log('\nGuard on. `git worktree remove --force` against a junctioned worktree will now');
  console.log('fail rather than delete the shared tree. Remove worktrees with:');
  console.log('  npm run worktree:remove -- <path>');
}
if (cmd === 'release' && !failed) {
  console.log('\nGuard off. The shared tree is deletable through a junction again.');
}
if (cmd === 'status' && failed) {
  console.log('\nGuard is NOT fully on. Turn it on with: npm run guard:node-modules apply');
}

process.exit(failed);
