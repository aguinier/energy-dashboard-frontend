import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMENT_CITATION_ALLOWLIST,
  checkCitations,
  classifyLine,
  findTopLevelDeclaration,
  formatProblems,
  isExternalPath,
  looksLikeSourcePath,
  parseCitations,
  resolveCitedPath,
  type RepoView,
} from './claudeMdCitations.js';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parseCitations', () => {
  it('reads a plain citation and a range', () => {
    const cites = parseCitations('see `store/migrate.ts:51` and `forecastModels.ts:180-190`.');
    expect(cites.map((c) => [c.file, c.startLine, c.endLine])).toEqual([
      ['store/migrate.ts', 51, 51],
      ['forecastModels.ts', 180, 190],
    ]);
  });

  it('binds a bare continuation to the file named before it, not the last one on the line', () => {
    // The shape CLAUDE.md actually uses: continuations to the left of a second,
    // unrelated file. Binding to "last file on the line" would attribute :76 and
    // :138 to dashboardService.ts.
    const cites = parseCitations(
      '(`routes/dashboard.ts:49`, `:76`, `:138`; via `getTimeRangeDates` in `dashboardService.ts:7`)'
    );
    expect(cites.map((c) => `${c.file}:${c.startLine}`)).toEqual([
      'routes/dashboard.ts:49',
      'routes/dashboard.ts:76',
      'routes/dashboard.ts:138',
      'dashboardService.ts:7',
    ]);
  });

  it('carries the binding across lines, because the document wraps mid-sentence', () => {
    const cites = parseCitations('`migrate.ts:130` remaps a metric\nand deletes `layers` (`:82`).');
    expect(cites[1]).toMatchObject({ file: 'migrate.ts', startLine: 82, continuation: true });
  });

  it('marks a continuation with no preceding file rather than guessing', () => {
    expect(parseCitations('a stray `:42` reference')[0]).toMatchObject({
      file: '',
      continuation: true,
    });
  });

  it('records the doc line so a failure is clickable', () => {
    const cites = parseCitations('intro\n\nsee `migrate.ts:3`');
    expect(cites[0].docLine).toBe(3);
  });

  it('ignores clock times, dates, URLs and offsets that also contain a colon', () => {
    const noise = [
      '`http://localhost:3001`',
      '`http://192.168.86.36:3001`',
      '`2026-08-06 00:00`',
      '`T12:00:00Z`',
      '`+02:00`',
      '`00:15`',
      "`new Date('2026-08-07 05:45:00')`",
      '`2025-11-28T00:00:00+02:00`',
      '`Record<TimePreset, TimeAnchor>`',
    ].join(' ');
    expect(parseCitations(noise)).toEqual([]);
  });

  it('picks up the symbol the prose names just before the citation', () => {
    const cites = parseCitations('`getDateRangeForPreset()` (`useDashboardData.ts:47`)');
    expect(cites[0].anchor).toBe('getDateRangeForPreset');
  });

  it('leaves the anchor null when no identifier precedes the citation', () => {
    expect(parseCitations('as of `useDashboardData.ts:47`')[0].anchor).toBeNull();
  });
});

describe('looksLikeSourcePath / isExternalPath', () => {
  it('accepts source files, including the extensionless ones we cite', () => {
    expect(looksLikeSourcePath('client/src/store/migrate.ts')).toBe(true);
    expect(looksLikeSourcePath('src/db.py')).toBe(true);
    expect(looksLikeSourcePath('../energy-data-gathering/docker/Dockerfile')).toBe(true);
  });

  it('rejects things that are not files', () => {
    expect(looksLikeSourcePath('http://localhost')).toBe(false);
    expect(looksLikeSourcePath('00')).toBe(false);
  });

  it('recognises a sibling-module path', () => {
    expect(isExternalPath('../energy-data-gathering/src/db.py')).toBe(true);
    expect(isExternalPath('server/src/index.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

describe('resolveCitedPath', () => {
  const tracked = [
    'client/src/store/migrate.ts',
    'client/src/store/migrate.test.ts',
    'client/src/types/index.ts',
    'server/src/types/index.ts',
  ];

  it('resolves a bare filename by path suffix', () => {
    expect(resolveCitedPath('migrate.ts', tracked)).toEqual({
      kind: 'resolved',
      path: 'client/src/store/migrate.ts',
    });
  });

  it('does not let a suffix match cut a filename in half', () => {
    // 'migrate.ts' must not match 'migrate.test.ts'.
    expect(resolveCitedPath('migrate.ts', tracked)).toEqual({
      kind: 'resolved',
      path: 'client/src/store/migrate.ts',
    });
  });

  it('reports ambiguity instead of picking one', () => {
    expect(resolveCitedPath('index.ts', tracked)).toEqual({
      kind: 'ambiguous',
      candidates: ['client/src/types/index.ts', 'server/src/types/index.ts'],
    });
  });

  it('disambiguates once the doc cites a longer path', () => {
    expect(resolveCitedPath('server/src/types/index.ts', tracked)).toEqual({
      kind: 'resolved',
      path: 'server/src/types/index.ts',
    });
  });

  it('reports a path that matches nothing', () => {
    expect(resolveCitedPath('gone.ts', tracked)).toEqual({ kind: 'missing' });
  });
});

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

describe('classifyLine', () => {
  it('calls an empty or whitespace line blank', () => {
    expect(classifyLine('', 'a.ts')).toBe('blank');
    expect(classifyLine('   ', 'a.ts')).toBe('blank');
  });

  it('recognises the comment forms this codebase uses', () => {
    expect(classifyLine('// a line comment', 'a.ts')).toBe('comment');
    expect(classifyLine('/**', 'a.ts')).toBe('comment');
    expect(classifyLine(' * jsdoc continuation', 'a.ts')).toBe('comment');
    expect(classifyLine(' */', 'a.ts')).toBe('comment');
    expect(classifyLine('*', 'a.ts')).toBe('comment');
    expect(classifyLine('# python comment', 'src/db.py')).toBe('comment');
    expect(classifyLine('# dockerfile comment', 'docker/Dockerfile')).toBe('comment');
    expect(classifyLine('-- sql comment', 'q.sql')).toBe('comment');
  });

  it('does not mistake multiplication or a spread for a comment', () => {
    expect(classifyLine('  const x = a * b;', 'a.ts')).toBe('code');
    expect(classifyLine('  ...rest,', 'a.ts')).toBe('code');
  });

  it('treats a trailing comment on a real statement as code', () => {
    expect(classifyLine("  'today': 24,      // one Brussels market day", 'a.ts')).toBe('code');
  });

  it('does not apply hash comments to TypeScript', () => {
    expect(classifyLine('#!/usr/bin/env node', 'a.ts')).toBe('code');
  });
});

// ---------------------------------------------------------------------------
// Declaration lookup
// ---------------------------------------------------------------------------

describe('findTopLevelDeclaration', () => {
  const lines = [
    "import x from 'y';", // 1
    '', // 2
    'export const PERSIST_VERSION = 6;', // 3
    '', // 4
    'export function target(a: number) {', // 5
    '  if (a) {', // 6
    '    return 1;', // 7
    '  }', // 8
    '  return 0;', // 9
    '}', // 10
    '', // 11
    'export function next() {}', // 12
  ];

  it('finds a function and the lines it spans', () => {
    expect(findTopLevelDeclaration(lines, 'target')).toEqual({ startLine: 5, endLine: 11 });
  });

  it('finds a const declaration', () => {
    expect(findTopLevelDeclaration(lines, 'PERSIST_VERSION')).toEqual({
      startLine: 3,
      endLine: 4,
    });
  });

  it('ignores a name that is only used, never declared at the top level', () => {
    // The case that keeps the symbol rule quiet: `ENERGY_DB_PATH` is only ever
    // read off process.env, so a citation naming it is not judged.
    const usage = ['const dbPath = process.env.ENERGY_DB_PATH || "/data/x.db";'];
    expect(findTopLevelDeclaration(usage, 'ENERGY_DB_PATH')).toBeNull();
  });

  it('ignores a destructured local, which is indented', () => {
    const inner = ['export function h() {', '  const { showComparisonMode } = useStore();', '}'];
    expect(findTopLevelDeclaration(inner, 'showComparisonMode')).toBeNull();
  });

  it('does not match a name that merely starts the same way', () => {
    expect(findTopLevelDeclaration(['export const targetValue = 1;'], 'target')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The rules, end to end
// ---------------------------------------------------------------------------

function viewOf(files: Record<string, string>, externals: Record<string, boolean | null> = {}): RepoView {
  return {
    trackedFiles: Object.keys(files),
    readLines: (p) => (p in files ? files[p].split('\n') : null),
    externalExists: (p) => (p in externals ? externals[p] : null),
  };
}

const SUBJECT = [
  'import x from "y";', // 1
  '', // 2
  '/**', // 3
  ' * Explains the thing.', // 4
  ' */', // 5
  'export function subject() {', // 6
  '  return callHelper();', // 7
  '}', // 8
  '', // 9
  'export function other() {', // 10
  '  return 2;', // 11
  '}', // 12
].join('\n');

describe('checkCitations', () => {
  const repo = viewOf({ 'src/subject.ts': SUBJECT });

  const problemsFor = (md: string, view: RepoView = repo, allow = COMMENT_CITATION_ALLOWLIST) =>
    checkCitations(md, view, allow).problems;

  it('passes a citation that lands on the code it names', () => {
    expect(problemsFor('`subject` (`src/subject.ts:6`)', repo, [])).toEqual([]);
  });

  it('fails a citation past the end of the file', () => {
    const [problem] = problemsFor('`subject` (`src/subject.ts:99`)', repo, []);
    expect(problem.kind).toBe('out-of-range');
    expect(problem.message).toContain('12 lines');
  });

  it('fails a range whose end runs past the file even when the start is fine', () => {
    expect(problemsFor('`subject` (`src/subject.ts:6-99`)', repo, [])[0].kind).toBe('out-of-range');
  });

  it('fails a citation that lands on a blank line', () => {
    expect(problemsFor('`subject` (`src/subject.ts:9`)', repo, [])[0].kind).toBe('blank-line');
  });

  it('fails a citation that lands on a comment', () => {
    expect(problemsFor('`subject` (`src/subject.ts:4`)', repo, [])[0].kind).toBe('comment-line');
  });

  it('allows a comment citation the allowlist covers, matched by excerpt not line', () => {
    const allow = [
      { file: 'src/subject.ts', excerpt: 'Explains the thing', reason: 'quoted as a comment' },
    ];
    expect(problemsFor('`subject` (`src/subject.ts:4`)', repo, allow)).toEqual([]);
  });

  it('still allows it after the comment moves down the file', () => {
    // The point of keying on an excerpt: a citation updated from :4 to :5 needs
    // no allowlist edit.
    const shifted = viewOf({ 'src/subject.ts': '\n' + SUBJECT });
    const allow = [
      { file: 'src/subject.ts', excerpt: 'Explains the thing', reason: 'quoted as a comment' },
    ];
    expect(problemsFor('`subject` (`src/subject.ts:5`)', shifted, allow)).toEqual([]);
  });

  it('reports an allowlist entry that no longer matches anything', () => {
    const allow = [{ file: 'src/subject.ts', excerpt: 'reworded away', reason: 'stale' }];
    const problems = problemsFor('`subject` (`src/subject.ts:6`)', repo, allow);
    expect(problems.map((p) => p.kind)).toEqual(['unused-allowlist-entry']);
  });

  it('fails a citation that sits outside the declaration it is cited for', () => {
    // The drift this rule exists for: an insertion above pushes the function
    // down, the old line number still holds code, so nothing else notices.
    const [problem] = problemsFor('`other` (`src/subject.ts:7`)', repo, []);
    expect(problem.kind).toBe('symbol-elsewhere');
    expect(problem.message).toContain('src/subject.ts:10-12');
  });

  it('accepts a call site, where the line mentions the symbol but sits elsewhere', () => {
    expect(problemsFor('`callHelper` (`src/subject.ts:7`)', repo, [])).toEqual([]);
  });

  it('does not judge a bare continuation, which idiomatically points at a use site', () => {
    // "declared at :6, applied at :7" is correct prose and must not fail.
    expect(problemsFor('`other` (`src/subject.ts:10`, applied at `:7`)', repo, [])).toEqual([]);
  });

  it('reports a file the repo does not track', () => {
    expect(problemsFor('`subject` (`src/gone.ts:1`)', repo, [])[0].kind).toBe('file-not-found');
  });

  it('reports an ambiguous path rather than picking a file', () => {
    const twins = viewOf({ 'a/index.ts': 'const a = 1;', 'b/index.ts': 'const b = 1;' });
    expect(problemsFor('see `index.ts:1`', twins, [])[0].kind).toBe('ambiguous-path');
  });

  it('reports a continuation with nothing to bind to', () => {
    expect(problemsFor('a stray `:3`', repo, [])[0].kind).toBe('unbound-continuation');
  });

  it('checks a sibling-module file for presence only', () => {
    const present = viewOf({}, { '../sibling/src/db.py': true });
    expect(problemsFor('`db` (`../sibling/src/db.py:99999`)', present, [])).toEqual([]);

    const absent = viewOf({}, { '../sibling/src/db.py': false });
    expect(problemsFor('`db` (`../sibling/src/db.py:1`)', absent, [])[0].kind).toBe(
      'external-missing'
    );
  });

  it('skips sibling citations when the module is not checked out', () => {
    const unchecked = viewOf({}, {});
    const result = checkCitations('`db` (`../sibling/src/db.py:1`)', unchecked, []);
    expect(result.problems).toEqual([]);
    expect(result.skippedExternal).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The real document
// ---------------------------------------------------------------------------

/**
 * Source of truth for the check.
 *
 * The working tree by default, so editing CLAUDE.md and running the suite tells
 * you straight away whether the citation is right. Set
 * `CLAUDE_MD_CITATIONS_REF=HEAD` (or any ref) to check a committed snapshot
 * instead — useful in the primary checkout, where a concurrent run's
 * half-finished edit to a cited file would otherwise shift lines under you.
 * CLAUDE.md and the files it cites are always read from the same source, so the
 * two can never be compared across a boundary.
 */
const REF = process.env.CLAUDE_MD_CITATIONS_REF ?? null;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

function git(args: string[]): string {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Where `../energy-data-gathering` is, as CLAUDE.md means it: relative to the
 * primary checkout. Resolving against the repo root would be wrong when the
 * suite runs from a git worktree, which sits several directories deeper.
 */
function primaryCheckout(): string {
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  return path.dirname(commonDir);
}

function buildRepoView(): RepoView {
  // In working-tree mode, count files that exist but are not staged yet, so a
  // citation to a file written moments ago is not reported as untracked. Ignored
  // paths (node_modules, dist) stay out via --exclude-standard.
  const listing = REF
    ? ['ls-tree', '-r', '--name-only', REF]
    : ['ls-files', '--cached', '--others', '--exclude-standard'];
  const trackedFiles = git(listing)
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);

  const checkout = primaryCheckout();
  const cache = new Map<string, string[] | null>();

  return {
    trackedFiles,
    readLines(p) {
      if (!cache.has(p)) {
        try {
          const text = REF
            ? git(['show', `${REF}:${p}`])
            : readFileSync(path.join(REPO_ROOT, p), 'utf8');
          cache.set(p, text.split('\n'));
        } catch {
          cache.set(p, null);
        }
      }
      return cache.get(p) ?? null;
    },
    externalExists(p) {
      const segments = p.split('/');
      // '..', '<module>', ...rest
      const moduleRoot = path.resolve(checkout, segments.slice(0, 2).join('/'));
      if (!existsSync(moduleRoot)) return null; // sibling not checked out — skip
      return existsSync(path.resolve(checkout, p));
    },
  };
}

function readClaudeMd(): string {
  return REF ? git(['show', `${REF}:CLAUDE.md`]) : readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
}

describe('CLAUDE.md citations', () => {
  const view = buildRepoView();
  const result = checkCitations(readClaudeMd(), view);

  // The sibling module is not part of this repo and is absent on CI and in a
  // Docker build, where its citations are skipped by design. Where it *is*
  // checked out, assert the presence check is really wired — otherwise a bug
  // that returned "skip" for everything would look identical to a clean run.
  const siblingCheckedOut =
    view.externalExists('../energy-data-gathering/src/db.py') !== null;

  it.skipIf(!siblingCheckedOut)('resolves sibling-module paths against the primary checkout', () => {
    expect(view.externalExists('../energy-data-gathering/src/db.py')).toBe(true);
    expect(view.externalExists('../energy-data-gathering/src/no-such-file.py')).toBe(false);
  });

  it('finds the citations, so a silent parse failure cannot pass as a clean run', () => {
    // Guards the check itself: if a regex change stopped matching, `problems`
    // would be empty and the real assertion below would go green for the wrong
    // reason.
    expect(result.citations.length).toBeGreaterThan(40);
  });

  it('every citation points at real code', () => {
    expect(formatProblems(result.problems)).toBe('');
  });
});
