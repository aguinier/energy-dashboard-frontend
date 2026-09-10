#!/usr/bin/env node
// The acceptance proof for ABL-640, re-runnable:
//
//   npm run repro:junction-delete
//
// Builds a throwaway git repo + linked worktree junctioned to a throwaway
// stand-in for the shared tree, then runs `git worktree remove --force` at it
// twice -- once unguarded, once with the same deny-DELETE ACE the real control
// applies -- and reports whether the target survived.
//
// Re-run this after a git upgrade. The control rests on a measured behaviour of
// git's recursive removal, not on a documented guarantee, so it can regress
// under us silently.
//
// SAFETY: everything happens under os.tmpdir(). The script refuses to run if
// its scratch root resolves anywhere near the real checkouts.
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildDenyAclArgs, buildReleaseAclArgs, resolvePrincipal, WORKTREE_LINK_PATHS } from './worktreeGuard.mjs';

if (process.platform !== 'win32') {
  console.error('This reproduction is about NTFS junctions; nothing to do off Windows.');
  process.exit(0);
}

const scratchRoot = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'abl640-repro-'));
if (/[\\/]code[\\/]able[\\/]/i.test(resolve(scratchRoot) + '\\')) {
  console.error(`refusing to run: scratch root ${scratchRoot} is inside the real checkout area`);
  process.exit(2);
}

const principal = resolvePrincipal(process.env);
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8' });

function countFiles(dir) {
  if (!existsSync(dir)) return -1;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) n += countFiles(p);
    else n += 1;
  }
  return n;
}

/** A stand-in for the shared tree: nested dirs and files, like node_modules. */
function makeSharedTree(dir) {
  for (const pkg of ['@alloc/quick-lru', '@babel/core', 'vitest']) {
    mkdirSync(join(dir, pkg, 'lib'), { recursive: true });
    writeFileSync(join(dir, pkg, 'package.json'), '{"version":"1.0.0"}');
    writeFileSync(join(dir, pkg, 'lib', 'index.js'), 'module.exports = 1;');
  }
  mkdirSync(join(dir, '.bin'), { recursive: true });
  writeFileSync(join(dir, '.bin', 'vitest.cmd'), '@echo off');
}

function buildCase(name) {
  const base = join(scratchRoot, name);
  const primary = join(base, 'primary');
  const shared = WORKTREE_LINK_PATHS.map((rel) => join(primary, rel.replace(/\//g, '\\')));

  mkdirSync(join(primary, 'client'), { recursive: true });
  mkdirSync(join(primary, 'server'), { recursive: true });
  run('git', ['init', '-q', '-b', 'main', primary]);
  run('git', ['config', 'user.email', 'repro@able.local'], primary);
  run('git', ['config', 'user.name', 'repro'], primary);
  writeFileSync(join(primary, 'package.json'), '{"name":"repro"}');
  writeFileSync(join(primary, 'client', 'a.txt'), 'a');
  writeFileSync(join(primary, 'server', 'b.txt'), 'b');
  run('git', ['add', '-A'], primary);
  run('git', ['commit', '-qm', 'init'], primary);

  for (const s of shared) makeSharedTree(s);

  const wt = join(base, 'worktree');
  run('git', ['worktree', 'add', '-q', '-b', `wt-${name}`, wt], primary);
  mkdirSync(join(wt, 'client'), { recursive: true });
  mkdirSync(join(wt, 'server'), { recursive: true });
  for (const rel of WORKTREE_LINK_PATHS) {
    const link = join(wt, rel.replace(/\//g, '\\'));
    run('cmd', ['/c', 'mklink', '/J', link, join(primary, rel.replace(/\//g, '\\'))]);
  }
  return { base, primary, wt, shared };
}

function report(label, c, before, gitOut) {
  const after = c.shared.map(countFiles);
  const lost = before.reduce((a, b) => a + b, 0) - after.reduce((a, b) => a + b, 0);
  console.log(`\n=== ${label} ===`);
  WORKTREE_LINK_PATHS.forEach((rel, i) => {
    console.log(`  target ${rel.padEnd(22)} ${before[i]} -> ${after[i]} files`);
  });
  console.log(`  worktree removed : ${!existsSync(c.wt)}`);
  console.log(`  git said         : ${(gitOut.trim() || '(nothing)').split('\n')[0]}`);
  console.log(`  VERDICT          : ${lost > 0 ? `*** SHARED TREE DESTROYED (${lost} files lost) ***` : 'SHARED TREE INTACT'}`);
  return lost;
}

// ---------------- BEFORE: no guard ----------------
const before = buildCase('unguarded');
const b0 = before.shared.map(countFiles);
const rb = run('git', ['worktree', 'remove', '--force', before.wt], before.primary);
const lostBefore = report('BEFORE - unguarded (today\'s behaviour)', before, b0, `${rb.stdout}${rb.stderr}`);

// ---------------- AFTER: the control ----------------
const after = buildCase('guarded');
for (const s of after.shared) {
  const r = run('icacls', buildDenyAclArgs(s, principal));
  if (r.status !== 0) {
    console.error(`could not apply guard to ${s}: ${r.stdout}${r.stderr}`);
    process.exit(2);
  }
}
const a0 = after.shared.map(countFiles);
const ra = run('git', ['worktree', 'remove', '--force', after.wt], after.primary);
const lostAfter = report('AFTER - deny-DELETE guard applied', after, a0, `${ra.stdout}${ra.stderr}`);

// ---------------- AFTER: the guard + the wrapper ----------------
const wrapped = buildCase('guarded-wrapper');
for (const s of wrapped.shared) run('icacls', buildDenyAclArgs(s, principal));
const w0 = wrapped.shared.map(countFiles);
for (const rel of WORKTREE_LINK_PATHS) {
  run('cmd', ['/c', 'rmdir', join(wrapped.wt, rel.replace(/\//g, '\\'))]);
}
const rw = run('git', ['worktree', 'remove', '--force', wrapped.wt], wrapped.primary);
const lostWrapped = report('AFTER - guard on, junctions dropped first (npm run worktree:remove)', wrapped, w0, `${rw.stdout}${rw.stderr}`);
const wrapperRemoved = !existsSync(wrapped.wt);

// ---------------- cleanup ----------------
for (const c of [before, after, wrapped]) {
  for (const s of c.shared) run('icacls', buildReleaseAclArgs(s, principal));
}
try {
  rmSync(scratchRoot, { recursive: true, force: true });
} catch {
  console.log(`\n(scratch left behind at ${scratchRoot})`);
}

console.log('\n----------------------------------------------------------------');
const pass = lostBefore > 0 && lostAfter === 0 && lostWrapped === 0 && wrapperRemoved;
console.log(pass ? 'PASS: the guard turns a silent destruction into a refused delete,' : 'FAIL: unexpected result -- read the cases above');
if (pass) console.log('      and the wrapper still removes the worktree cleanly with the guard on.');
process.exit(pass ? 0 : 1);
