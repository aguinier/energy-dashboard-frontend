import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../..');

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/**
 * CP1252 mojibake: a UTF-8 file re-saved through a Windows-1252 code path
 * produces sequences where each original UTF-8 byte becomes a separate
 * Unicode codepoint.  The tell-tale pattern is a Latin-1 supplement character
 * in the range U+00C2-U+00C3 or U+00E2 (which is what 0xC2, 0xC3, 0xE2 look
 * like when mis-decoded as Latin-1/CP1252) immediately followed by another
 * character in U+0080-U+00BF (the range of UTF-8 continuation bytes decoded
 * as Latin-1 characters).
 *
 * This check operates at the Unicode codepoint level, so legitimate em dashes
 * (U+2014) or other Unicode characters are single codepoints and never trigger
 * it -- only the multi-codepoint mojibake sequences do.
 *
 * Positive self-test anchor: U+00E2 followed by U+0080 is the start of any
 * three-byte UTF-8 sequence (like U+2014 em dash, U+2022 bullet, etc.) after
 * CP1252 mis-decoding.  The self-tests below use \uXXXX escape sequences
 * rather than literal non-printing codepoints so that a tool that silently
 * strips C1 control characters cannot turn a positive test into a vacuous pass.
 */
function hasMojibake(text: string): boolean {
  for (let i = 0; i < text.length - 1; i++) {
    const cp = text.charCodeAt(i);
    if (cp === 0x00c2 || cp === 0x00c3 || cp === 0x00e2) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0x0080 && next <= 0x00bf) {
        return true;
      }
    }
  }
  return false;
}

/**
 * UTF-8 BOM: 0xEF 0xBB 0xBF at the start of the file, or U+FEFF as the first
 * codepoint when decoded as UTF-8.  Never correct in a .ts/.tsx source file.
 */
function hasUtf8Bom(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

// ---------------------------------------------------------------------------
// Self-tests -- a detector that passes vacuously is worse than no detector
// ---------------------------------------------------------------------------

describe('encoding detector self-tests', () => {
  it('hasMojibake fires on U+00E2 followed by a continuation-range char', () => {
    // U+00E2 (the CP1252 mis-decoding of byte 0xE2) followed by U+0080 (the
    // mis-decoding of continuation byte 0x80) -- the start of any three-byte
    // UTF-8 sequence such as U+2014 em dash or U+2022 bullet.
    // Written as \uXXXX escapes: a tool that strips non-printing C1 chars
    // would leave only the letter 's', and hasMojibake('\u00e2s...') returns
    // false -- turning this into a vacuous pass with no error.
    const badText = '\u00e2\u0080some text';
    expect(hasMojibake(badText)).toBe(true);
  });

  it('hasMojibake fires on the classic mojibake triple for em dash', () => {
    // U+2014 (em dash) is stored as UTF-8 bytes E2 80 94.  When that file is
    // re-read as CP1252/Latin-1 those three bytes become three codepoints:
    // U+00E2, U+0080, U+0094.  The pair U+00E2 + U+0080 triggers the detector.
    // Written as \uXXXX escapes for the same reason as the test above.
    const badText = '\u00e2\u0080\u0094';
    expect(hasMojibake(badText)).toBe(true);
  });

  it('hasMojibake does NOT fire on a correct em dash', () => {
    // U+2014 is a single codepoint -- not a mojibake sequence
    expect(hasMojibake('hello — world')).toBe(false);
  });

  it('hasMojibake does NOT fire on clean ASCII', () => {
    expect(hasMojibake('hello world')).toBe(false);
  });

  it('hasMojibake does NOT fire on U+00E2 followed by a non-continuation char', () => {
    // U+00E2 (a-circumflex) followed by 'x' (U+0078) -- not in continuation range
    expect(hasMojibake('\u00e2x')).toBe(false);
  });

  it('hasUtf8Bom fires on a BOM-prefixed buffer', () => {
    expect(hasUtf8Bom(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe(true);
  });

  it('hasUtf8Bom does not fire on a clean buffer', () => {
    expect(hasUtf8Bom(Buffer.from('hello', 'utf8'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Repository-wide sweep via git ls-files
// ---------------------------------------------------------------------------

describe('encoding guard (repo-wide, git-tracked files only)', () => {
  let trackedFiles: string[];

  try {
    const out = execFileSync('git', ['ls-files', '--cached', '-z'], {
      cwd: repoRoot,
      encoding: 'buffer',
    });
    trackedFiles = out
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
  } catch {
    // git not available -- skip gracefully
    trackedFiles = [];
  }

  it('has at least one tracked file (sanity check)', () => {
    expect(trackedFiles.length).toBeGreaterThan(100);
  });

  it('zero git-tracked source files contain CP1252 mojibake', () => {
    const SOURCE_EXTS = new Set([
      '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs',
      '.json', '.jsonc', '.md', '.mdx', '.html', '.css',
      '.yaml', '.yml', '.txt', '.sh', '.env',
    ]);

    const failures: string[] = [];
    for (const rel of trackedFiles) {
      const ext = path.extname(rel).toLowerCase();
      if (!SOURCE_EXTS.has(ext)) continue;
      let text: string;
      try {
        const buf = readFileSync(path.join(repoRoot, rel));
        // Strip BOM before decoding so it doesn't confuse the check
        const raw = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
        text = raw.toString('utf8');
      } catch {
        continue; // binary file or deleted from disk -- skip
      }
      if (hasMojibake(text)) {
        failures.push(rel);
      }
    }
    expect(failures, `CP1252 mojibake found in:\n${failures.join('\n')}`).toEqual([]);
  });

  it('zero git-tracked files carry a UTF-8 BOM', () => {
    const failures: string[] = [];
    for (const rel of trackedFiles) {
      let buf: Buffer;
      try {
        buf = readFileSync(path.join(repoRoot, rel));
      } catch {
        continue;
      }
      if (hasUtf8Bom(buf)) {
        failures.push(rel);
      }
    }
    expect(failures, `UTF-8 BOM found in:\n${failures.join('\n')}`).toEqual([]);
  });
});
