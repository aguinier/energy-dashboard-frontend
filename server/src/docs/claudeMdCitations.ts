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

// Size budget enforcement is in claudeMdBudget.ts; the real-document assertion
// runs from claudeMdCitations.test.ts so one command covers both checks.

/** KB means KiB throughout this repo, so the 35 KB budget is 35,840 B. */
const KB = 1024;

/** A document measured in both dimensions the budget bounds. */
export interface DocSize {
  /** Lines of text. A trailing newline terminates the last line, it does not start an empty one. */
  lines: number;
  /** UTF-8 bytes of the LF-normalised text, BOM excluded — see `measureDocSize`. */
  bytes: number;
}

/**
 * The enforced budget, and the other half of the rule CLAUDE.md states in prose.
 *
 * CLAUDE.md auto-loads into every agent context, so its size is a per-turn tax
 * on the whole fleet rather than a cost paid by whoever opens it: it reached
 * 6,752 lines / 426,865 B and killed runs outright, and ABL-536 trimmed it to
 * 450 lines / 25,849 B. That fixed the level, not the slope — the file grew
 * because each issue appended its findings and no merge ever removed anything,
 * with nothing standing against it but a paragraph asking people not to. This
 * is that paragraph with teeth.
 *
 * Both dimensions are checked because they fail differently: a wall of short
 * bullets blows the line count while staying small, and a few long unwrapped
 * paragraphs blow the byte count while staying short.
 */
export const CLAUDE_MD_BUDGET: DocSize = { lines: 700, bytes: 35 * KB };

/**
 * Measure a document the same way on every platform.
 *
 * **Bytes are the LF-normalised UTF-8 length, BOM excluded** — every CRLF counts
 * as the one byte git stores, so this figure is `git cat-file -s` on the blob.
 * Measuring the file as it sits on disk would make "35 KB" mean something
 * different per platform: `core.autocrlf` is `true` on the Windows checkouts
 * this repo is developed on and `.gitattributes` does not pin `*.md`, so the
 * working-tree copy carries CRLF — 26,299 B against 25,849 B in the blob when
 * this was written. That 450 B is one byte per line and no content at all, and
 * it is invisible until a document sits within it of the ceiling; then the same
 * commit fails here and passes on an LF checkout. Same reasoning as the OpenAPI
 * drift check — see `.gitattributes`.
 *
 * Bytes, not characters: the document is dense with em dashes and ellipses, each
 * three bytes of UTF-8, so a character count understates it by ~2%.
 */
export function measureDocSize(text: string): DocSize {
  // `\uFEFF` written as an escape, never as a literal: a BOM character in this
  // source would be invisible in every editor, and any tool that repairs
  // encodings would strip it — silently turning the BOM handling into a no-op.
  const normalised = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (normalised === '') return { lines: 0, bytes: 0 };
  return {
    lines: normalised.split('\n').length - (normalised.endsWith('\n') ? 1 : 0),
    bytes: new TextEncoder().encode(normalised).length,
  };
}

/** `35 KB` for an exact multiple, `36.4 KB` otherwise — never a pointless `.0`. */
function formatKb(bytes: number): string {
  const kb = (bytes / KB).toFixed(1);
  return `${kb.endsWith('.0') ? kb.slice(0, -2) : kb} KB`;
}

/** `12 lines and 1.4 KB` — a sub-KB overage stays in bytes, since "0.0 KB" says nothing. */
function formatOverage(size: DocSize, budget: DocSize): string {
  const parts: string[] = [];
  if (size.lines > budget.lines) {
    const over = size.lines - budget.lines;
    parts.push(`${over} line${over === 1 ? '' : 's'}`);
  }
  if (size.bytes > budget.bytes) {
    const over = size.bytes - budget.bytes;
    parts.push(over < KB ? `${over} B` : formatKb(over));
  }
  return parts.join(' and ');
}

/**
 * The budget assertion's message, or `null` when the document fits.
 *
 * The message is as much the deliverable as the assertion. Whoever trips this is
 * mid-landing on something else, so it has to say how far over, on which
 * dimension, and where the material goes — without sending anyone to read this
 * module first, and without leaving "raise the budget" looking like an option.
 */
export function checkSizeBudget(
  text: string,
  budget: DocSize = CLAUDE_MD_BUDGET,
  name = 'CLAUDE.md'
): string | null {
  const size = measureDocSize(text);
  const overLines = size.lines > budget.lines;
  const overBytes = size.bytes > budget.bytes;
  if (!overLines && !overBytes) return null;

  const breach =
    overLines && overBytes ? 'both line count and size' : overLines ? 'line count' : 'size';
  return (
    `${name} is ${size.lines.toLocaleString('en-US')} lines / ${formatKb(size.bytes)}, over ` +
    `the ABL-536 budget of ${budget.lines.toLocaleString('en-US')} lines / ` +
    `${formatKb(budget.bytes)} on ${breach} — ${formatOverage(size, budget)} too much. ` +
    `Move narrative, dated measurements or per-issue forensics into ` +
    `docs/claude/<topic>.md and leave a one-line pointer here. Do not raise the ` +
    `budget to fit: every line here is paid on every turn by every run. ` +
    `(Bytes are LF-normalised, as git stores the file.)`
  );
}

/**
 * The budget as CLAUDE.md states it in prose: "**Hard budget: 700 lines / 35 KB.**"
 *
 * Tolerant of the bold markers, of thousands separators and of the sentence
 * rewrapping, because reflowing a paragraph must never fail the suite.
 */
const STATED_BUDGET = /Hard budget:\s*\**\s*([\d,]+)\s*lines?\s*\/\s*([\d,]+)\s*KB/i;

/**
 * Check that the rule the document *states* is the rule this module *enforces*,
 * or `null` if they agree.
 *
 * Agents learn this rule by reading CLAUDE.md, not by reading here. The two
 * drifting apart puts us back where ABL-536 started: a stated rule nothing
 * enforces, or an enforced rule nobody was told about.
 */
export function checkStatedBudget(
  text: string,
  budget: DocSize = CLAUDE_MD_BUDGET
): string | null {
  const match = STATED_BUDGET.exec(text.replace(/\r\n/g, '\n'));
  if (match === null) {
    return (
      `CLAUDE.md no longer states its own size budget. Agents learn this rule by ` +
      `reading the file, so restate it as "Hard budget: ${budget.lines} lines / ` +
      `${formatKb(budget.bytes)}." in the "How to maintain this file" section.`
    );
  }

  const digits = (s: string) => Number(s.replace(/,/g, ''));
  const stated: DocSize = { lines: digits(match[1]), bytes: digits(match[2]) * KB };
  if (stated.lines === budget.lines && stated.bytes === budget.bytes) return null;

  return (
    `CLAUDE.md states a budget of ${stated.lines} lines / ${formatKb(stated.bytes)}, but ` +
    `${budget.lines} lines / ${formatKb(budget.bytes)} is enforced (CLAUDE_MD_BUDGET, ` +
    `server/src/docs/claudeMdCitations.ts). Change both together.`
  );
}
