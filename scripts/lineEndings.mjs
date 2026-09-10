// A shebang followed by CRLF is a file vitest cannot import (ABL-726).
//
// Vite strips the hashbang line with `/^#!.*\n/`. In JavaScript `.` does not
// match `\r`, so on a CRLF file the pattern never matches: the `#!` line
// survives into the wrapped module body and V8 rejects it with
//
//     SyntaxError: Invalid or unexpected token
//
// and no file, no line and no stack — the error names neither the module that
// threw nor the character. It is invisible on Linux, because `core.autocrlf`
// is a Windows checkout's behaviour, so the file is green in CI and a dead
// suite on the workstation. `scripts/testFloor.test.ts` spent its first day
// exactly there.
//
// `.gitattributes` pins `*.mjs`/`*.cjs`/`*.js` to `eol=lf`, which prevents it
// on any checkout made after that landed. This module is the other half: the
// blobs were already LF, so the attribute change touches no file, so `git pull`
// does not refresh a working tree that already has CRLF copies — and `git
// status` stays clean throughout, because the clean filter normalises CRLF
// back to LF before comparing. A tree can therefore be broken, up to date and
// clean at the same time. That is only detectable by reading the bytes.
//
// Dependency-free, like `worktreeGuard.mjs`: it must run on a tree whose
// node_modules is in doubt.
import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

/** Extensions Vite/vitest may hand to the hashbang strip. */
export const CHECKED_EXTENSIONS = ['.mjs', '.cjs', '.js'];

/**
 * Directories the walk does not enter. `node_modules` is three NTFS junctions
 * into the primary tree here (ABL-640) and is not ours to judge; the rest are
 * build output.
 */
export const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.vite',
  '.turbo',
]);

/** The one-liner that re-applies `.gitattributes` to files git thinks are fine. */
export const REFRESH_COMMAND =
  'rm <file> && git checkout -- <file>   (git checkout-index -f does NOT ' +
  'rewrite a file the stat cache calls current)';

/**
 * How the shebang line of `bytes` ends.
 *
 * `'lf'` is the only ending Vite's `/^#!.*\n/` matches, and `'none'` (no
 * shebang at all) is the only other safe answer. A CRLF file WITHOUT a shebang
 * is fine and common — `scripts/worktreeGuard.mjs` was CRLF and green beside
 * `testFloor.mjs`, which is the measurement that isolated the shebang as the
 * necessary second half.
 *
 * @param {Uint8Array} bytes raw file contents, not a decoded string
 * @returns {'none' | 'lf' | 'crlf' | 'cr' | 'eof'}
 */
export function shebangLineEnding(bytes) {
  if (bytes.length < 2 || bytes[0] !== 0x23 || bytes[1] !== 0x21) return 'none';

  for (let i = 2; i < bytes.length; i += 1) {
    // CR is tested first, and with a look-ahead: a CR that is not followed by
    // LF is a JS line terminator in its own right, so `.` stops there too and
    // the strip fails for the identical reason.
    if (bytes[i] === 0x0d) return bytes[i + 1] === 0x0a ? 'crlf' : 'cr';
    if (bytes[i] === 0x0a) return 'lf';
  }

  return 'eof';
}

/**
 * @param {string} file path to name in the message
 * @param {Uint8Array} bytes raw file contents
 * @returns {string | null} null when the file is importable, else why it is not
 */
export function shebangProblem(file, bytes) {
  const ending = shebangLineEnding(bytes);
  if (ending === 'none' || ending === 'lf') return null;

  const seen = ending === 'eof' ? 'no line terminator at all' : `${ending.toUpperCase()} line endings`;
  return (
    `${file} starts with a shebang and has ${seen}. Vite strips the shebang ` +
    `with /^#!.*\\n/, which only matches a bare LF, so this file throws ` +
    `"SyntaxError: Invalid or unexpected token" when a test imports it — with ` +
    `no file, line or stack. Refresh the working copy: ${REFRESH_COMMAND}`
  );
}

/**
 * Every JavaScript source under `root`, skipping build output and node_modules.
 *
 * @param {string} root
 * @returns {string[]} absolute paths
 */
export function listJsSources(root) {
  const found = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(full);
      } else if (entry.isFile() && CHECKED_EXTENSIONS.includes(extname(entry.name))) {
        found.push(full);
      }
    }
  };

  walk(root);
  return found;
}
