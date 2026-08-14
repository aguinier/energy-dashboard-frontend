import { describe, it, expect } from 'vitest';
import {
  NODE_ABI_MAJORS,
  describeNodeAbi,
  formatAbiMismatchRemedy,
  parseAbiMismatch,
} from './nativeAbi.js';

/**
 * Verbatim from `node -e "new (require('better-sqlite3'))(':memory:')"` under
 * v25.6.1 against the ABI-137 binary on 2026-08-12 — line wraps included, since
 * the wrap is the thing a naive single-line regex gets wrong.
 */
const REAL_MESSAGE = [
  "Error: The module '\\\\?\\C:\\Code\\able\\energy-dashboard-frontend\\server\\node_modules\\better-sqlite3\\build\\Release\\better_sqlite3.node'",
  'was compiled against a different Node.js version using',
  'NODE_MODULE_VERSION 137. This version of Node.js requires',
  'NODE_MODULE_VERSION 141. Please try re-compiling or re-installing',
  'the module (for instance, using `npm rebuild` or `npm install`).',
].join('\n');

const remedy = (over: Partial<Parameters<typeof formatAbiMismatchRemedy>[0]> = {}) =>
  formatAbiMismatchRemedy({
    moduleAbi: 137,
    runtimeAbi: 141,
    modulePath: null,
    runtimeVersion: 'v25.6.1',
    nvmRoot: '/c/Users/guill/AppData/Local/nvm',
    ...over,
  });

describe('parseAbiMismatch', () => {
  it('reads both ABI numbers out of the real wrapped error', () => {
    expect(parseAbiMismatch(REAL_MESSAGE)).toEqual({
      moduleAbi: 137,
      runtimeAbi: 141,
      modulePath:
        '\\\\?\\C:\\Code\\able\\energy-dashboard-frontend\\server\\node_modules\\better-sqlite3\\build\\Release\\better_sqlite3.node',
    });
  });

  it('reads the reversed direction too — the module ABI is whatever was built last', () => {
    const reversed = REAL_MESSAGE.replace('VERSION 137', 'VERSION 999').replace(
      'VERSION 141',
      'VERSION 137',
    );
    expect(parseAbiMismatch(reversed)).toMatchObject({ moduleAbi: 999, runtimeAbi: 137 });
  });

  it('returns null for an unrelated load failure', () => {
    expect(parseAbiMismatch("Error: Cannot find module 'better-sqlite3'")).toBeNull();
  });

  it('returns null when only one of the two numbers is present', () => {
    expect(parseAbiMismatch('was compiled against a different Node.js version using\nNODE_MODULE_VERSION 137.')).toBeNull();
  });

  it('returns null when the two agree — that is a different failure, not a mismatch', () => {
    expect(parseAbiMismatch(REAL_MESSAGE.replace('VERSION 141', 'VERSION 137'))).toBeNull();
  });
});

describe('describeNodeAbi', () => {
  it('names the Node major for an ABI it knows', () => {
    expect(describeNodeAbi(137)).toBe('Node 24 (ABI 137)');
    expect(describeNodeAbi(141)).toBe('Node 25 (ABI 141)');
  });

  it('reports the bare number rather than guessing a major it does not know', () => {
    expect(describeNodeAbi(145)).toBe('ABI 145');
  });

  it('maps only ABIs whose Node major is actually known', () => {
    expect(NODE_ABI_MAJORS[137]).toBe(24);
    expect(NODE_ABI_MAJORS[999]).toBeUndefined();
  });
});

describe('formatAbiMismatchRemedy', () => {
  it('states both sides of the mismatch and the Node to re-run under', () => {
    const text = remedy();
    expect(text).toContain('binary built for : Node 24 (ABI 137)');
    expect(text).toContain('this Node        : v25.6.1 — needs Node 25 (ABI 141)');
    expect(text).toContain('Re-run under Node 24');
    expect(text).toContain('PATH="/c/Users/guill/AppData/Local/nvm/v24.<minor>.<patch>:$PATH"');
  });

  it('says plainly that this is not a test failure', () => {
    expect(remedy()).toContain('not a test');
  });

  it('steers away from npm rebuild and nvm use, which break other runs', () => {
    const text = remedy();
    expect(text).toContain('Do NOT run `npm rebuild better-sqlite3`');
    expect(text).toContain('Do NOT use `nvm use`');
  });

  it('names the escape hatch for the ABI-independent tests', () => {
    expect(remedy()).toContain('SKIP_NATIVE_ABI_PRECHECK=1');
  });

  it('follows the direction of the mismatch rather than hardcoding Node 24', () => {
    const text = remedy({ moduleAbi: 141, runtimeAbi: 137, runtimeVersion: 'v24.18.0' });
    expect(text).toContain('binary built for : Node 25 (ABI 141)');
    expect(text).toContain('Re-run under Node 25');
    expect(text).not.toContain('Re-run under Node 24');
  });

  it('degrades to the ABI number, and offers no PATH line, for an unknown major', () => {
    const text = remedy({ moduleAbi: 145, runtimeAbi: 141 });
    expect(text).toContain('Re-run under a Node whose ABI is 145');
    expect(text).not.toContain('nvm install');
  });

  it('includes the binary path when the error named one', () => {
    expect(remedy({ modulePath: 'C:\\x\\better_sqlite3.node' })).toContain(
      'binary           : C:\\x\\better_sqlite3.node',
    );
  });
});
