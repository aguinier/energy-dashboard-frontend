/**
 * The mechanical half of keeping CLAUDE.md honest.
 *
 * CLAUDE.md carries ~60 `file:line` citations. They are the reason the file is
 * fast to use, and they rot silently: the line still exists after an unrelated
 * commit inserts twenty lines above it, so nothing errors — the citation just
 * points at a blank line, a comment, or the wrong function. ABL-3 verified every
 * citation by hand; a merge the same hour re-broke thirteen of them.
 *
 * Everything here is pure. The caller supplies the document text and a `RepoView`
 * that reads files (from the working tree, or from a git ref — see
 * claudeMdCitations.test.ts), so the rules can be unit-tested without a repo.
 *
 * Two rules run, both chosen by measuring them against the real document:
 *
 *   1. The cited line must exist, and must not be blank or comment-only.
 *   2. If the prose names a symbol just before the citation, and that symbol is
 *      declared at the top level of the cited file, the cited line must either
 *      mention the symbol or fall inside its declaration.
 *
 * Rule 2 exists because most drift lands on a *code* line — just the wrong one.
 * Of the eight stale citations found when this check was written, rule 1 caught
 * three and rule 2 caught seven. It is deliberately narrow: it is skipped for
 * bare `:NNN` continuations, which idiomatically point at a *use* site ("declared
 * at `x.ts:56`, applied at `:115`"), and skipped when the anchor is not a
 * top-level declaration. Both exclusions were required to reach zero false
 * positives across the whole document — a check that cries wolf gets disabled.
 */

/** A `file:line` (or `file:line-line`) reference parsed out of the document. */
export interface Citation {
  /** 1-based line in CLAUDE.md where the citation appears. */
  docLine: number;
  /** Backtick contents as written, e.g. `migrate.ts:130` or `:88`. */
  raw: string;
  /** Path as cited. Inherited from the preceding citation for a continuation. */
  file: string;
  startLine: number;
  endLine: number;
  /** True for a bare `:NNN` that inherits its file from an earlier citation. */
  continuation: boolean;
  /**
   * Nearest preceding backticked bare identifier — the symbol the prose is
   * naming. `getDateRangeForPreset` in "`getDateRangeForPreset()`
   * (`useDashboardData.ts:47`)".
   */
  anchor: string | null;
}

export type ProblemKind =
  | 'unbound-continuation'
  | 'file-not-found'
  | 'ambiguous-path'
  | 'out-of-range'
  | 'blank-line'
  | 'comment-line'
  | 'symbol-elsewhere'
  | 'external-missing'
  | 'unused-allowlist-entry';

export interface Problem {
  kind: ProblemKind;
  /** 1-based line in CLAUDE.md, or 0 for a problem with the allowlist itself. */
  docLine: number;
  message: string;
}

/**
 * Citations that land on a comment **on purpose**, because the prose quotes the
 * comment as a comment.
 *
 * Keyed by file and by an excerpt of the comment rather than by line number, so
 * an entry survives the comment moving: when the citation is updated from `:168`
 * to `:171`, the excerpt still matches and nothing here needs touching. If the
 * comment is deleted or reworded, the entry stops matching and the check fails —
 * which is correct, because the doc is then quoting something that no longer
 * exists.
 */
export interface CommentAllowance {
  /** Repo-relative path of the file whose comment is cited. */
  file: string;
  /** Substring the cited comment line must contain. */
  excerpt: string;
  /** Why the doc means to point at a comment here. */
  reason: string;
}

export const COMMENT_CITATION_ALLOWLIST: CommentAllowance[] = [
  {
    file: 'server/src/config/forecastModels.ts',
    excerpt: 'catboost and xgboost cover DISJOINT country sets',
    reason:
      'CLAUDE.md cites this comment to say the comment itself is now stale for `price`.',
  },
];

const SOURCE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'sql',
  'sh',
  'json',
  'yml',
  'yaml',
  'md',
]);

/** Files we cite that carry no extension. */
const EXTENSIONLESS_SOURCE_NAMES = new Set(['Dockerfile', 'Makefile']);

const C_LIKE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']);
const HASH_COMMENT_EXTENSIONS = new Set(['py', 'sh', 'yml', 'yaml']);

/** Every backticked span in the document, in reading order. */
const BACKTICK_SPAN = /`([^`]+)`/g;

/**
 * `path/to/file.ts:12` or `file.ts:12-20`. The path charset excludes `:` and
 * whitespace, which is what keeps `http://localhost:3001`, `2026-08-06 00:00`,
 * `T12:00:00Z` and `+02:00` from being read as citations.
 */
const NAMED_CITATION = /^([A-Za-z0-9_.@/-]*[A-Za-z0-9_-](?:\.[A-Za-z0-9]+)?):(\d+)(?:-(\d+))?$/;

/** A bare `:76` continuation. */
const CONTINUATION = /^:(\d+)(?:-(\d+))?$/;

/** A backticked span that is exactly one identifier, optionally `()`-suffixed. */
const BARE_IDENTIFIER = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\(\))?$/;

/**
 * How many backticked spans back to look for the symbol a citation is about.
 * Four covers the longest real run in the document — "`useDashboardOverview`
 * sends an explicit `start`/`end` computed by `getDateRangeForPreset`
 * (`useDashboardData.ts:175`)" — without reaching into a previous sentence.
 */
const ANCHOR_LOOKBACK = 4;

function basename(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1];
}

function extensionOf(p: string): string | null {
  const base = basename(p);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : null;
}

/** Does this path look like a source file we could open, rather than a URL or a clock time? */
export function looksLikeSourcePath(p: string): boolean {
  if (p.includes('://')) return false;
  if (EXTENSIONLESS_SOURCE_NAMES.has(basename(p))) return true;
  const ext = extensionOf(p);
  return ext !== null && SOURCE_EXTENSIONS.has(ext);
}

/** True for a path pointing outside this repository, e.g. the sibling data module. */
export function isExternalPath(p: string): boolean {
  return p.startsWith('../');
}

/**
 * Pull every citation out of the document, in order.
 *
 * A bare `:76` binds to the file named *before it positionally* — not to the
 * last file mentioned on the line. The document relies on this: in
 * "(`dashboard.ts:49`, `:76`, `:138`; ... via `getTimeRangeDates` in
 * `dashboardService.ts:7`)" the continuations belong to `dashboard.ts`, which is
 * to their left, while `dashboardService.ts` sits to their right on the same
 * line. Binding carries across lines too, since the document wraps mid-sentence.
 */
export function parseCitations(markdown: string): Citation[] {
  const spans: Array<{ docLine: number; text: string }> = [];
  markdown.split('\n').forEach((line, index) => {
    BACKTICK_SPAN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BACKTICK_SPAN.exec(line)) !== null) {
      spans.push({ docLine: index + 1, text: match[1] });
    }
  });

  const anchorAt = (spanIndex: number): string | null => {
    const floor = Math.max(0, spanIndex - ANCHOR_LOOKBACK);
    for (let i = spanIndex - 1; i >= floor; i--) {
      const identifier = BARE_IDENTIFIER.exec(spans[i].text);
      if (identifier) return identifier[1];
    }
    return null;
  };

  const citations: Citation[] = [];
  let currentFile: string | null = null;

  spans.forEach((span, index) => {
    const named = NAMED_CITATION.exec(span.text);
    if (named && looksLikeSourcePath(named[1])) {
      currentFile = named[1];
      citations.push({
        docLine: span.docLine,
        raw: span.text,
        file: named[1],
        startLine: Number(named[2]),
        endLine: named[3] ? Number(named[3]) : Number(named[2]),
        continuation: false,
        anchor: anchorAt(index),
      });
      return;
    }

    const continued = CONTINUATION.exec(span.text);
    if (continued) {
      citations.push({
        docLine: span.docLine,
        raw: span.text,
        file: currentFile ?? '',
        startLine: Number(continued[1]),
        endLine: continued[2] ? Number(continued[2]) : Number(continued[1]),
        continuation: true,
        anchor: anchorAt(index),
      });
    }
  });

  return citations;
}

export type PathResolution =
  | { kind: 'resolved'; path: string }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; candidates: string[] };

/**
 * Match a cited path against the repo's tracked files by path suffix, so the
 * document can write `migrate.ts` or `store/migrate.ts` instead of the full path.
 * A suffix that matches more than one file is an error rather than a guess — the
 * document has to be specific enough to be unambiguous.
 */
export function resolveCitedPath(cited: string, trackedFiles: string[]): PathResolution {
  const normalised = cited.replace(/^\.\//, '');
  const candidates = trackedFiles.filter(
    (f) => f === normalised || f.endsWith('/' + normalised)
  );
  if (candidates.length === 1) return { kind: 'resolved', path: candidates[0] };
  if (candidates.length === 0) return { kind: 'missing' };
  return { kind: 'ambiguous', candidates };
}

export type LineKind = 'blank' | 'comment' | 'code';

/**
 * Classify a source line well enough to say "this citation points at nothing".
 *
 * Deliberately a heuristic on the leading token: a line inside a block comment
 * that happens not to start with `*` reads as code here. That direction of error
 * is the safe one — a missed comment is a citation that survives, a false comment
 * is a check that cries wolf.
 */
export function classifyLine(line: string, path: string): LineKind {
  const trimmed = line.trim();
  if (trimmed === '') return 'blank';

  const ext = extensionOf(path);
  if (ext !== null && C_LIKE_EXTENSIONS.has(ext)) {
    if (trimmed.startsWith('//')) return 'comment';
    if (trimmed.startsWith('/*') || trimmed.startsWith('*/')) return 'comment';
    // A JSDoc continuation line. `*=` and `*/` aside, a line opening with `*`
    // is not valid TypeScript, so this cannot swallow a real statement.
    if (trimmed.startsWith('* ') || trimmed === '*') return 'comment';
  }
  if (ext !== null && HASH_COMMENT_EXTENSIONS.has(ext)) {
    if (trimmed.startsWith('#')) return 'comment';
  }
  if (EXTENSIONLESS_SOURCE_NAMES.has(basename(path)) && trimmed.startsWith('#')) {
    return 'comment';
  }
  if (ext === 'sql' && trimmed.startsWith('--')) return 'comment';

  return 'code';
}

export interface DeclarationSpan {
  startLine: number;
  endLine: number;
}

/**
 * Locate a top-level declaration of `symbol` and the lines it spans.
 *
 * Column 0 is load-bearing: it restricts the rule to module-level bindings, so a
 * destructured local (`const { showComparisonMode } = useDashboardStore()`) or a
 * name that only appears as `process.env.ENERGY_DB_PATH` is not treated as a
 * declaration at all, and the citation is left alone. That is what keeps the
 * symbol rule quiet on the citations it has no business judging.
 *
 * The span runs to the next top-level declaration, which over-estimates rather
 * than under-estimates. Again the safe direction: too wide only lets a citation
 * pass.
 */
export function findTopLevelDeclaration(
  lines: string[],
  symbol: string
): DeclarationSpan | null {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(
    `^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?` +
      `(?:function|const|let|var|class|type|interface|enum)\\s+${escaped}\\b`
  );

  for (let i = 0; i < lines.length; i++) {
    if (!declaration.test(lines[i])) continue;

    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line === '' || /^\s/.test(line)) continue; // blank or indented: still inside
      if (/^[})\];]/.test(line)) continue; // a closer at column 0
      if (/^[/*]/.test(line)) continue; // a comment introducing the next thing
      end = j; // 0-based index of the next declaration == 1-based end of this one
      break;
    }
    return { startLine: i + 1, endLine: end };
  }

  return null;
}

/** File access, injected so the rules stay pure and testable. */
export interface RepoView {
  /** Repo-relative paths, as `git ls-files` reports them. */
  trackedFiles: string[];
  /** Lines of a tracked file, or null if it cannot be read. */
  readLines(path: string): string[] | null;
  /**
   * Whether a path outside the repo exists. Return null when the sibling module
   * is not checked out at all, so its citations are skipped rather than failed.
   */
  externalExists(path: string): boolean | null;
}

export interface CheckResult {
  citations: Citation[];
  problems: Problem[];
  /** External citations skipped because the sibling module is not present. */
  skippedExternal: number;
}

function describe(citation: Citation): string {
  const range =
    citation.endLine === citation.startLine
      ? `${citation.startLine}`
      : `${citation.startLine}-${citation.endLine}`;
  return `${citation.file}:${range}`;
}

export function checkCitations(
  markdown: string,
  repo: RepoView,
  allowlist: CommentAllowance[] = COMMENT_CITATION_ALLOWLIST
): CheckResult {
  const citations = parseCitations(markdown);
  const problems: Problem[] = [];
  const usedAllowances = new Set<CommentAllowance>();
  let skippedExternal = 0;

  for (const citation of citations) {
    if (citation.file === '') {
      problems.push({
        kind: 'unbound-continuation',
        docLine: citation.docLine,
        message: `\`${citation.raw}\` continues a citation, but no file is named before it.`,
      });
      continue;
    }

    if (isExternalPath(citation.file)) {
      const exists = repo.externalExists(citation.file);
      if (exists === null) {
        skippedExternal++;
      } else if (!exists) {
        problems.push({
          kind: 'external-missing',
          docLine: citation.docLine,
          message: `${describe(citation)} points outside this repo, and that file does not exist.`,
        });
      }
      continue;
    }

    const resolution = resolveCitedPath(citation.file, repo.trackedFiles);
    if (resolution.kind === 'missing') {
      problems.push({
        kind: 'file-not-found',
        docLine: citation.docLine,
        message: `${describe(citation)} names a file that is not tracked in this repo.`,
      });
      continue;
    }
    if (resolution.kind === 'ambiguous') {
      problems.push({
        kind: 'ambiguous-path',
        docLine: citation.docLine,
        message:
          `${describe(citation)} matches ${resolution.candidates.length} files ` +
          `(${resolution.candidates.join(', ')}). Cite a longer path.`,
      });
      continue;
    }

    const path = resolution.path;
    const lines = repo.readLines(path);
    if (lines === null) {
      problems.push({
        kind: 'file-not-found',
        docLine: citation.docLine,
        message: `${describe(citation)} resolved to ${path}, which could not be read.`,
      });
      continue;
    }

    if (citation.startLine < 1 || citation.endLine > lines.length) {
      problems.push({
        kind: 'out-of-range',
        docLine: citation.docLine,
        message: `${describe(citation)} is out of range — ${path} has ${lines.length} lines.`,
      });
      continue;
    }

    const landing = lines[citation.startLine - 1];
    const kind = classifyLine(landing, path);

    if (kind === 'blank') {
      problems.push({
        kind: 'blank-line',
        docLine: citation.docLine,
        message: `${describe(citation)} lands on a blank line in ${path}.`,
      });
      continue;
    }

    if (kind === 'comment') {
      const allowance = allowlist.find(
        (a) => a.file === path && landing.includes(a.excerpt)
      );
      if (allowance) {
        usedAllowances.add(allowance);
      } else {
        problems.push({
          kind: 'comment-line',
          docLine: citation.docLine,
          message:
            `${describe(citation)} lands on a comment in ${path}: ` +
            `"${landing.trim()}". If the doc means to quote this comment, ` +
            `add it to COMMENT_CITATION_ALLOWLIST.`,
        });
      }
      continue;
    }

    // Rule 2. Only for citations that name their own file: a bare continuation
    // idiomatically points at a use site away from the declaration.
    if (citation.continuation || citation.anchor === null) continue;

    const ext = extensionOf(path);
    if (ext === null || !C_LIKE_EXTENSIONS.has(ext)) continue;

    const declaration = findTopLevelDeclaration(lines, citation.anchor);
    if (declaration === null) continue;

    const insideDeclaration =
      citation.startLine >= declaration.startLine &&
      citation.startLine <= declaration.endLine;
    if (insideDeclaration || landing.includes(citation.anchor)) continue;

    problems.push({
      kind: 'symbol-elsewhere',
      docLine: citation.docLine,
      message:
        `${describe(citation)} is cited for \`${citation.anchor}\`, but line ` +
        `${citation.startLine} does not mention it and sits outside its ` +
        `declaration (${path}:${declaration.startLine}-${declaration.endLine}).`,
    });
  }

  for (const allowance of allowlist) {
    if (usedAllowances.has(allowance)) continue;
    problems.push({
      kind: 'unused-allowlist-entry',
      docLine: 0,
      message:
        `COMMENT_CITATION_ALLOWLIST entry for ${allowance.file} ` +
        `("${allowance.excerpt}") matched no citation. The comment moved, was ` +
        `reworded, or is no longer cited — update or drop the entry.`,
    });
  }

  return { citations, problems, skippedExternal };
}

/** Render problems as one message, each line prefixed with a clickable doc location. */
export function formatProblems(problems: Problem[]): string {
  return problems
    .map((p) => (p.docLine > 0 ? `CLAUDE.md:${p.docLine}  ${p.message}` : `  ${p.message}`))
    .join('\n');
}
