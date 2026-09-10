import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHECKED_EXTENSIONS,
  SKIPPED_DIRECTORIES,
  listJsSources,
  shebangLineEnding,
  shebangProblem,
} from './lineEndings.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const bytes = (text: string) => Buffer.from(text, 'utf8');

describe('shebangLineEnding', () => {
  it('accepts the shape Vite can strip', () => {
    expect(shebangLineEnding(bytes('#!/usr/bin/env node\nexport const a = 1;\n'))).toBe('lf');
  });

  it('names CRLF, the shape that breaks the import', () => {
    expect(shebangLineEnding(bytes('#!/usr/bin/env node\r\nexport const a = 1;\r\n'))).toBe('crlf');
  });

  it('names a bare CR, which defeats the same regex', () => {
    // `.` in a JS regex excludes \r as well as \n, so `/^#!.*\n/` misses this
    // one for the identical reason.
    expect(shebangLineEnding(bytes('#!/usr/bin/env node\rexport const a = 1;'))).toBe('cr');
  });

  it('names a shebang-only file with no terminator', () => {
    expect(shebangLineEnding(bytes('#!/usr/bin/env node'))).toBe('eof');
  });

  it('reports no shebang for a CRLF file that has none', () => {
    // The control that isolated the cause: scripts/worktreeGuard.mjs was CRLF
    // and its test collected fine, beside scripts/testFloor.mjs which did not.
    // CRLF alone is not the bug.
    expect(shebangLineEnding(bytes('// a comment\r\nexport const a = 1;\r\n'))).toBe('none');
  });

  it('does not read a lone `#` as a shebang', () => {
    expect(shebangLineEnding(bytes('# not js\r\n'))).toBe('none');
  });

  it('handles an empty file rather than reading past the end', () => {
    expect(shebangLineEnding(bytes(''))).toBe('none');
  });
});

describe('shebangProblem', () => {
  it('passes an LF shebang', () => {
    expect(shebangProblem('ok.mjs', bytes('#!/usr/bin/env node\nexport {};\n'))).toBeNull();
  });

  it('passes a file with no shebang whatever its line endings', () => {
    expect(shebangProblem('ok.mjs', bytes('export {};\r\n'))).toBeNull();
  });

  it('explains a CRLF shebang, names the file, and gives the remedy', () => {
    const problem = shebangProblem('scripts/testFloor.mjs', bytes('#!/usr/bin/env node\r\n'));
    expect(problem).toContain('scripts/testFloor.mjs');
    expect(problem).toContain('SyntaxError: Invalid or unexpected token');
    expect(problem).toContain('git checkout --');
  });
});

describe('the working tree', () => {
  const sources = listJsSources(REPO_ROOT);

  it('contains at least one shebang script, so the check below is not vacuous', () => {
    // Without this, deleting every executable script — or a walk that silently
    // returns nothing — would leave the assertion below green and meaningless.
    const shebanged = sources.filter(
      (file) => shebangLineEnding(readFileSync(file)) !== 'none'
    );
    expect(shebanged.length).toBeGreaterThan(0);
  });

  it('has no JavaScript source that vitest cannot import', () => {
    const problems = sources
      .map((file) => shebangProblem(relative(REPO_ROOT, file), readFileSync(file)))
      .filter((problem): problem is string => problem !== null);

    expect(problems).toEqual([]);
  });
});

describe('the walk', () => {
  it('skips node_modules, which is a junction into the shared tree here', () => {
    expect(SKIPPED_DIRECTORIES.has('node_modules')).toBe(true);
    expect(listJsSources(REPO_ROOT).some((file) => file.includes('node_modules'))).toBe(false);
  });

  it('covers both workspaces and the repo-root scripts, not just one of them', () => {
    const relatives = listJsSources(REPO_ROOT).map((file) => relative(REPO_ROOT, file));
    expect(relatives).toContain(join('scripts', 'testFloor.mjs'));
    expect(relatives.some((file) => file.startsWith('client'))).toBe(true);
  });

  it('checks every extension Vite may hand the hashbang strip', () => {
    expect(CHECKED_EXTENSIONS).toEqual(['.mjs', '.cjs', '.js']);
  });
});
