#!/usr/bin/env node
// Tripwire (ABL-640, option 3). Names the fault in seconds instead of letting
// it surface as 17 different plausible-looking environment errors.
//
//   npm run check:modules      # explicit
//   npm run dev                # runs it automatically via `predev`
//
// Dependency-free on purpose: this has to run on a tree that has just lost 107
// packages, which is precisely when nothing under node_modules can be imported.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMissingPackages } from './worktreeGuard.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(repoRoot, 'package-lock.json');

if (!existsSync(lockPath)) {
  console.error(`check:modules: no package-lock.json at ${lockPath}`);
  process.exit(2);
}

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const missing = findMissingPackages(
  lock.packages,
  (rel) => existsSync(join(repoRoot, rel)),
  { platform: process.platform, arch: process.arch },
);

console.log(`missing packages: ${missing.length}`);

if (missing.length === 0) process.exit(0);

console.error('');
console.error(`node_modules is INCOMPLETE: ${missing.length} package(s) the lockfile requires are absent.`);
console.error('');
console.error('First few:');
for (const m of missing.slice(0, 8)) console.error(`  ${m}`);
if (missing.length > 8) console.error(`  ... and ${missing.length - 8} more`);
console.error('');
console.error('This is almost certainly a recursive delete that walked a node_modules');
console.error('junction -- not a failed install. Do NOT run `npm install` here: ~20 live');
console.error('node processes share this tree. Use the additive donor copy in');
console.error('docs/claude/03-quick-start.md, and see `npm run guard:node-modules status`.');
process.exit(1);
