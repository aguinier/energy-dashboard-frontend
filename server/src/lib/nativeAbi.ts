/**
 * Turn a `NODE_MODULE_VERSION` mismatch into one actionable line instead of a
 * wall of red (ABL-309).
 *
 * `better-sqlite3` is a V8-ABI addon, not a Node-API one, so its compiled
 * `better_sqlite3.node` only loads under the exact Node ABI it was built
 * against. When the two disagree every DB-touching test file fails at *import*
 * time with a `bindings.js` stack and no test assertion in sight. On 2026-08-12
 * that read `24 failed | 20 passed` on an unmodified `main` — a large red result
 * that has nothing to do with anyone's change. Both ways that lands are bad:
 * someone burns a heartbeat "fixing" phantom failures, or someone learns to
 * dismiss a red server suite and a real regression rides through behind it.
 *
 * **Nothing here names a Node version, deliberately.** `server/node_modules` is
 * junctioned into every per-issue worktree, so a single `npm rebuild` re-points
 * the ABI for all of them at once, and the direction reverses each time someone
 * does it — the module was built for ABI 137 in the morning of 2026-08-12, 141
 * by 15:35, and back to 137 by 15:36. A guard that hardcoded "use Node 24" would
 * become the next wrong instruction the first time that happened. The error text
 * states both numbers; this reads them out and reports what it found.
 *
 * Pure: the caller supplies the error message and its own `process.version`, so
 * this is unit-testable without a native module or a mismatched runtime.
 */

/**
 * `NODE_MODULE_VERSION` -> Node major, for the majors this workstation might
 * plausibly have on `PATH`. Unknown values are reported as the bare ABI number
 * rather than guessed at — a wrong major here would be exactly the confident,
 * plausible, wrong number this codebase exists to avoid.
 */
export const NODE_ABI_MAJORS: Readonly<Record<number, number>> = Object.freeze({
  108: 18,
  115: 20,
  127: 22,
  131: 23,
  137: 24,
  141: 25,
});

export interface AbiMismatch {
  /** ABI the `.node` binary on disk was compiled against. */
  moduleAbi: number;
  /** ABI the Node that tried to load it requires. */
  runtimeAbi: number;
  /** Absolute path of the offending binary, when the message names one. */
  modulePath: string | null;
}

/** `137` -> `"Node 24 (ABI 137)"`; an unmapped ABI keeps its number only. */
export function describeNodeAbi(abi: number): string {
  const major = NODE_ABI_MAJORS[abi];
  return major === undefined ? `ABI ${abi}` : `Node ${major} (ABI ${abi})`;
}

/**
 * Recognise Node's native-module version error. Returns `null` for anything
 * else — including a message whose two ABI numbers agree, which is some other
 * load failure wearing a similar shape and must not be reported as a version
 * mismatch.
 *
 * The real message wraps mid-sentence, so both patterns cross newlines:
 *
 *     was compiled against a different Node.js version using
 *     NODE_MODULE_VERSION 137. This version of Node.js requires
 *     NODE_MODULE_VERSION 141.
 */
export function parseAbiMismatch(message: string): AbiMismatch | null {
  const compiled = /compiled against[\s\S]*?NODE_MODULE_VERSION\s+(\d+)/.exec(message);
  const requires = /requires[\s\S]*?NODE_MODULE_VERSION\s+(\d+)/.exec(message);
  if (!compiled || !requires) return null;

  const moduleAbi = Number(compiled[1]);
  const runtimeAbi = Number(requires[1]);
  if (moduleAbi === runtimeAbi) return null;

  const path = /The module '([^']+)'/.exec(message);
  return { moduleAbi, runtimeAbi, modulePath: path ? path[1] : null };
}

export interface AbiRemedyInput extends AbiMismatch {
  /** The running Node's `process.version`, e.g. `v25.6.1`. */
  runtimeVersion: string;
  /** nvm-for-Windows install root, whose per-version dirs are `v24.18.0` etc. */
  nvmRoot: string;
}

/**
 * The message the preflight prints. Says what mismatched, which way to resolve
 * it, and why not to resolve it the other way.
 *
 * It always steers to changing `PATH` rather than to `npm rebuild`: the rebuild
 * does fix the suite for whichever Node is first on `PATH` and breaks it in the
 * same motion for every other checkout sharing the junctioned `node_modules`.
 * That has already happened twice, and is why this guard exists.
 */
export function formatAbiMismatchRemedy(input: AbiRemedyInput): string {
  const { moduleAbi, runtimeAbi, modulePath, runtimeVersion, nvmRoot } = input;
  const wantedMajor = NODE_ABI_MAJORS[moduleAbi];

  const lines = [
    'Server suite halted before running: the compiled better-sqlite3 binary does not',
    'match the Node running this suite. This is an environment mismatch, not a test',
    'failure — no assertion ran, and nothing is wrong with your branch (ABL-309).',
    '',
    `  binary built for : ${describeNodeAbi(moduleAbi)}`,
    `  this Node        : ${runtimeVersion} — needs ${describeNodeAbi(runtimeAbi)}`,
  ];
  if (modulePath) lines.push(`  binary           : ${modulePath}`);

  lines.push(
    '',
    wantedMajor === undefined
      ? `Re-run under a Node whose ABI is ${moduleAbi}:`
      : `Re-run under Node ${wantedMajor}, prepending it to PATH for this command only:`,
  );
  if (wantedMajor !== undefined) {
    lines.push(
      '',
      `  PATH="${nvmRoot}/v${wantedMajor}.<minor>.<patch>:$PATH" npx vitest run`,
      '',
      `  (\`ls ${nvmRoot}\` for the exact directory; \`nvm install ${wantedMajor}\` if none.)`,
    );
  }

  lines.push(
    '',
    'Do NOT run `npm rebuild better-sqlite3` to make this go away. server/node_modules',
    'is junctioned into every per-issue worktree, so a rebuild re-points the ABI for all',
    'of them at once — it fixes your Node and breaks everyone on the other one. Changing',
    'the Node the whole workstation builds against is a CEO decision, not a fix in passing.',
    '',
    'Do NOT use `nvm use` either: on nvm4w that mutates a machine-wide symlink and would',
    'switch Node under every concurrently running agent.',
    '',
    'To run only the ABI-independent tests under the Node you have, set',
    'SKIP_NATIVE_ABI_PRECHECK=1 — the DB-touching files will still fail.',
  );

  return lines.join('\n');
}
