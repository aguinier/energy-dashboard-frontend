import { formatAbiMismatchRemedy, parseAbiMismatch } from '../lib/nativeAbi.js';

/**
 * vitest `globalSetup` for the server suite: prove the compiled
 * `better-sqlite3` binary can actually run under this Node *before* 60-odd test
 * files import it (ABL-309).
 *
 * Without this the mismatch surfaces as ~16-24 files failing at import with a
 * `bindings.js` stack, no assertion named, and a passing remainder — a shape
 * that reads like a broken branch and is not one. One fatal, explanatory error
 * is the whole point: see `../lib/nativeAbi.ts` for why it reports the ABI
 * numbers out of the error instead of naming a Node version.
 *
 * `require()` alone is not enough of a check. `better-sqlite3` defers loading
 * the addon until a `Database` is constructed, so under a mismatched Node the
 * import resolves fine and only construction throws — which is exactly why the
 * failure lands scattered across test files rather than at a single obvious
 * point.
 */

/** nvm-for-Windows root on the able workstation; only used to print a hint. */
const NVM_ROOT = '/c/Users/guill/AppData/Local/nvm';

export default async function setup(): Promise<void> {
  if (process.env.SKIP_NATIVE_ABI_PRECHECK === '1') return;

  try {
    const { default: Database } = await import('better-sqlite3');
    new Database(':memory:').close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const mismatch = parseAbiMismatch(message);

    // Anything that is not an ABI mismatch — a missing package, a corrupt
    // binary — is re-thrown untouched. Dressing an unknown failure in a
    // confident diagnosis is the failure mode this repo cares most about.
    if (!mismatch) throw error;

    throw new Error(
      `\n\n${formatAbiMismatchRemedy({
        ...mismatch,
        runtimeVersion: process.version,
        nvmRoot: NVM_ROOT,
      })}\n`,
    );
  }
}
