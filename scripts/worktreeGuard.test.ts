import { describe, expect, it } from 'vitest';
import {
  WORKTREE_LINK_PATHS,
  PROTECTED_PATHS,
  classifyLink,
  planLinkDrops,
  assertRemovableWorktree,
  buildDenyAclArgs,
  buildReleaseAclArgs,
  resolvePrincipal,
  icaclsSucceeded,
  findMissingPackages,
} from './worktreeGuard.mjs';

const stat = (isLink: boolean, isDir: boolean) => ({
  isSymbolicLink: () => isLink,
  isDirectory: () => isDir,
});

describe('classifyLink', () => {
  // The whole bug in one assertion: on Windows a junction answers TRUE to both
  // predicates. Ask isDirectory() first and every junction reads as a plain
  // directory, which is exactly how a recursive delete ends up walking through.
  it('calls a junction a junction even though it also reports as a directory', () => {
    expect(classifyLink(stat(true, true))).toBe('junction');
  });

  it('calls a real directory a directory', () => {
    expect(classifyLink(stat(false, true))).toBe('directory');
  });

  it('calls a missing path absent', () => {
    expect(classifyLink(null)).toBe('absent');
  });
});

describe('planLinkDrops', () => {
  it('drops only reparse points and leaves real directories to git', () => {
    const plan = planLinkDrops([
      { path: 'node_modules', kind: 'junction' },
      { path: 'client/node_modules', kind: 'absent' },
      { path: 'server/node_modules', kind: 'directory' },
    ]);
    expect(plan.drop).toEqual(['node_modules']);
    expect(plan.leaveToGit).toEqual(['server/node_modules']);
    expect(plan.absent).toEqual(['client/node_modules']);
  });

  it('handles a worktree with no links at all', () => {
    expect(planLinkDrops([])).toEqual({ drop: [], leaveToGit: [], absent: [] });
  });
});

describe('WORKTREE_LINK_PATHS', () => {
  // Three, not one. CLAUDE.md described a single `<worktree>\node_modules`
  // rmdir until ABL-640 measured the real layout; a caller that drops one of
  // three still hands git two live junctions.
  it('covers all three junction sites, parent first', () => {
    expect(WORKTREE_LINK_PATHS).toEqual([
      'node_modules',
      'client/node_modules',
      'server/node_modules',
    ]);
  });
});

describe('PROTECTED_PATHS', () => {
  it('guards the hoisted tree and the unhoisted native module', () => {
    expect(PROTECTED_PATHS).toEqual(['node_modules', 'server/node_modules/better-sqlite3']);
  });

  it('does not freeze the vitest dep-optimizer cache', () => {
    // server/node_modules/.vite must stay evictable, so the guard may not sit
    // on server/node_modules itself.
    expect(PROTECTED_PATHS).not.toContain('server/node_modules');
  });
});

describe('assertRemovableWorktree', () => {
  const primary = 'C:\\Code\\able\\energy-dashboard-frontend';

  it('accepts a sibling worktree', () => {
    expect(assertRemovableWorktree('C:\\Code\\able\\ABL-288-ops', primary)).toEqual({ ok: true });
  });

  it('refuses the primary checkout itself', () => {
    const r = assertRemovableWorktree(primary, primary);
    expect(r.ok).toBe(false);
  });

  it('refuses the primary checkout under a trailing separator or mixed slashes', () => {
    expect(assertRemovableWorktree('C:/Code/able/energy-dashboard-frontend\\', primary).ok).toBe(false);
  });

  it('is case-insensitive, as NTFS is', () => {
    expect(assertRemovableWorktree('c:\\code\\ABLE\\Energy-Dashboard-Frontend', primary).ok).toBe(false);
  });

  it('refuses an ancestor of the primary checkout', () => {
    expect(assertRemovableWorktree('C:\\Code\\able', primary).ok).toBe(false);
  });

  it('does not refuse a sibling whose name merely prefixes the primary', () => {
    expect(assertRemovableWorktree('C:\\Code\\able\\energy-dashboard', primary)).toEqual({ ok: true });
  });

  it('refuses an empty target', () => {
    expect(assertRemovableWorktree('', primary).ok).toBe(false);
  });
});

describe('acl argv', () => {
  it('denies both DELETE and DELETE_CHILD, inheritably', () => {
    expect(buildDenyAclArgs('C:\\t\\node_modules', 'CAT\\guill')).toEqual([
      'C:\\t\\node_modules',
      '/deny',
      'CAT\\guill:(OI)(CI)(DE,DC)',
    ]);
  });

  it('releases by principal', () => {
    expect(buildReleaseAclArgs('C:\\t\\node_modules', 'CAT\\guill')).toEqual([
      'C:\\t\\node_modules',
      '/remove:d',
      'CAT\\guill',
    ]);
  });

  it('resolves a domain-qualified principal', () => {
    expect(resolvePrincipal({ USERDOMAIN: 'CAT', USERNAME: 'guill' })).toBe('CAT\\guill');
  });

  it('falls back to the bare username', () => {
    expect(resolvePrincipal({ USERNAME: 'guill' })).toBe('guill');
  });

  it('throws rather than denying a guessed principal', () => {
    expect(() => resolvePrincipal({})).toThrow(/USERNAME/);
  });
});

describe('icaclsSucceeded', () => {
  it('reads the failure count, not the exit code', () => {
    expect(icaclsSucceeded('Successfully processed 1 files; Failed processing 0 files')).toBe(true);
    expect(icaclsSucceeded('Successfully processed 0 files; Failed processing 1 files')).toBe(false);
  });
});

describe('findMissingPackages', () => {
  const lock = {
    '': { version: '1.0.0' },
    'node_modules/present': { version: '1.0.0' },
    'node_modules/absent': { version: '2.0.0' },
    'client': { link: true, version: '1.0.0' },
    'node_modules/client': { link: true, resolved: 'client' },
    'node_modules/no-version': {},
    'node_modules/linux-only': { version: '1.0.0', os: ['linux'] },
    'node_modules/arm-only': { version: '1.0.0', cpu: ['arm64'] },
    'node_modules/win-only': { version: '1.0.0', os: ['win32'] },
  } as Record<string, { link?: boolean; version?: string; os?: string[]; cpu?: string[] }>;

  const onDisk = new Set(['node_modules/present/package.json']);
  const exists = (p: string) => onDisk.has(p);

  it('reports only packages the host actually needs and lacks', () => {
    expect(findMissingPackages(lock, exists)).toEqual(['node_modules/absent', 'node_modules/win-only']);
  });

  it('skips workspace links, versionless entries and foreign os/cpu', () => {
    const missing = findMissingPackages(lock, exists);
    expect(missing).not.toContain('node_modules/client');
    expect(missing).not.toContain('node_modules/no-version');
    expect(missing).not.toContain('node_modules/linux-only');
    expect(missing).not.toContain('node_modules/arm-only');
  });

  it('reports nothing on a complete tree', () => {
    expect(findMissingPackages(lock, () => true)).toEqual([]);
  });

  it('honours a non-Windows host when asked', () => {
    const missing = findMissingPackages(lock, exists, { platform: 'linux', arch: 'x64' });
    expect(missing).toContain('node_modules/linux-only');
    expect(missing).not.toContain('node_modules/win-only');
  });
});
