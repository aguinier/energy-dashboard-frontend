// Pure helpers behind the three node_modules guards (ABL-640). No imports, no
// side effects: every CLI here has to run on a tree that has just been damaged,
// so nothing in this file may depend on node_modules existing.
//
// Measured behaviour these encode (see docs/claude/03-quick-start.md):
// `git worktree remove --force` is the ONLY recursive delete that walks an NTFS
// junction. Remove-Item -Recurse, fs.rmSync, rm -rf and rmdir /s /q all remove
// the link and leave the target intact.

/**
 * The link paths a worktree carries, relative to its root. Three, not one:
 * dependencies hoist to the repo root, `better-sqlite3` sits unhoisted in
 * `server/node_modules`, and `client/node_modules` is junctioned too.
 * Ordered parent-first so a caller dropping them never orphans a nested link.
 */
export const WORKTREE_LINK_PATHS = Object.freeze([
  'node_modules',
  'client/node_modules',
  'server/node_modules',
]);

/**
 * Paths under the primary checkout that must survive a worktree removal,
 * relative to the checkout root.
 *
 * `server/node_modules` is guarded at `better-sqlite3` rather than at the
 * directory, deliberately: vitest keeps its dep-optimizer cache in
 * `server/node_modules/.vite` and must stay free to evict it. A recursive
 * delete that reaches this directory first therefore loses only regenerable
 * cache before it aborts on the native module. `client/node_modules` is
 * unguarded because it holds no package the lockfile requires.
 */
export const PROTECTED_PATHS = Object.freeze([
  'node_modules',
  'server/node_modules/better-sqlite3',
]);

/** @typedef {'junction'|'directory'|'absent'} LinkKind */

/**
 * Classify what sits at a link path from an `fs.lstat` result.
 * A junction reports BOTH isDirectory() and isSymbolicLink() true on Windows,
 * so the symlink test has to be asked first or every junction reads as a plain
 * directory and gets deleted through.
 *
 * @param {{isSymbolicLink(): boolean, isDirectory(): boolean}|null} stat
 * @returns {LinkKind}
 */
export function classifyLink(stat) {
  if (!stat) return 'absent';
  if (stat.isSymbolicLink()) return 'junction';
  if (stat.isDirectory()) return 'directory';
  return 'directory';
}

/**
 * Decide which of a worktree's link paths to drop before handing it to git.
 *
 * Only reparse points are dropped. A real directory is left for git: it is the
 * worktree's own tree, and `rmdir` on it would be an unrequested delete.
 *
 * @param {Array<{path: string, kind: LinkKind}>} entries
 * @returns {{drop: string[], leaveToGit: string[], absent: string[]}}
 */
export function planLinkDrops(entries) {
  const plan = { drop: [], leaveToGit: [], absent: [] };
  for (const e of entries) {
    if (e.kind === 'junction') plan.drop.push(e.path);
    else if (e.kind === 'directory') plan.leaveToGit.push(e.path);
    else plan.absent.push(e.path);
  }
  return plan;
}

/**
 * Refuse targets that are not a removable worktree. Removing the primary
 * checkout is the failure this whole issue exists to prevent, so it is a
 * refusal rather than a warning.
 *
 * @param {string} target absolute path being removed
 * @param {string} primaryRoot absolute path of the primary checkout
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function assertRemovableWorktree(target, primaryRoot) {
  const norm = (p) => p.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  const t = norm(target);
  const p = norm(primaryRoot);
  if (!t) return { ok: false, reason: 'no worktree path given' };
  if (t === p) return { ok: false, reason: `refusing to remove the primary checkout (${primaryRoot})` };
  if (p.startsWith(t + '\\')) {
    return { ok: false, reason: `refusing: ${target} contains the primary checkout` };
  }
  return { ok: true };
}

/**
 * icacls argv that denies delete to a principal across a tree.
 * (OI)(CI) makes the ACE inheritable, so packages added later by an additive
 * repair are covered without re-running this. DE is the right of deleting the
 * object itself; DC is deleting a child. Both are needed: Windows grants a
 * delete when the object allows DELETE *or* its parent allows FILE_DELETE_CHILD.
 *
 * @param {string} target
 * @param {string} principal
 * @returns {string[]}
 */
export function buildDenyAclArgs(target, principal) {
  return [target, '/deny', `${principal}:(OI)(CI)(DE,DC)`];
}

/**
 * icacls argv that lifts the deny ACEs this guard added. Removing the
 * inheritable ACE from the root re-computes every inherited child ACE, so no
 * tree walk is needed.
 *
 * @param {string} target
 * @param {string} principal
 * @returns {string[]}
 */
export function buildReleaseAclArgs(target, principal) {
  return [target, '/remove:d', principal];
}

/**
 * The Windows principal to deny. Agents run unelevated as this account.
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
export function resolvePrincipal(env) {
  const user = env.USERNAME;
  if (!user) throw new Error('USERNAME is not set; cannot resolve an ACL principal');
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
}

/**
 * Whether an icacls run reported success. icacls exits 0 and prints
 * "Successfully processed N files; Failed processing 0 files"; a partial
 * failure still exits 0, so the count has to be read rather than the code.
 *
 * @param {string} output
 * @returns {boolean}
 */
export function icaclsSucceeded(output) {
  return /Failed processing 0 files/i.test(output);
}

/**
 * The lockfile completeness check, extracted from the shell one-liner in
 * CLAUDE.md so it has one home and a test.
 *
 * Semantics are kept byte-for-byte identical to that one-liner so the number it
 * prints stays comparable with every figure on record: entries outside
 * node_modules, workspace links and versionless entries are skipped, and os/cpu
 * are matched by substring (which is also why a negated `!win32` constraint
 * reads as a match -- preserved deliberately, not overlooked).
 *
 * @param {Record<string, {link?: boolean, version?: string, os?: string[]|string, cpu?: string[]|string}>} lockPackages
 * @param {(relPath: string) => boolean} exists receives `<pkgPath>/package.json`
 * @param {{platform?: string, arch?: string}} [host]
 * @returns {string[]} paths of absent packages
 */
export function findMissingPackages(lockPackages, exists, host = {}) {
  const platform = host.platform ?? 'win32';
  const arch = host.arch ?? 'x64';
  const missing = [];
  for (const [p, v] of Object.entries(lockPackages)) {
    if (!p.includes('node_modules/') || v.link || !v.version) continue;
    if (v.os && !v.os.includes(platform)) continue;
    if (v.cpu && !v.cpu.includes(arch)) continue;
    if (!exists(p + '/package.json')) missing.push(p);
  }
  return missing;
}

/**
 * Classify a completeness check's result for the human-facing message
 * (ABL-667). A missing `node_modules` directory is a never-linked worktree --
 * the normal state of a fresh execution worktree, which has not been pointed
 * at the shared tree yet -- and must read as a link/donor-copy task, not as
 * the ABL-460/517/636 junction-delete symptom, which only afflicts a tree
 * that was linked and then lost packages out from under it.
 *
 * @param {number} missingCount
 * @param {boolean} nodeModulesExists whether `<repoRoot>/node_modules` exists at all
 * @returns {'complete'|'never-linked'|'incomplete'}
 */
export function classifyMissingPackagesVerdict(missingCount, nodeModulesExists) {
  if (missingCount === 0) return 'complete';
  if (!nodeModulesExists) return 'never-linked';
  return 'incomplete';
}
