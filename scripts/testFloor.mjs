#!/usr/bin/env node
// CI tripwire (ABL-647): a green suite that ran fewer tests than it used to is
// not a green suite.
//
//   node scripts/testFloor.mjs <workspace> <vitest-json-report>
//
// vitest's exit code answers "did anything fail?". It does not answer "did
// anything run?" — a bad `--reporter=`, a broken `include` glob or a deleted
// test file all exit 0 having run less, or nothing (the shape recorded in
// docs/claude/21-testing.md). CI is the one reader that never notices, because
// nobody reads a green check. So the count is asserted, not eyeballed.
//
// Dependency-free on purpose: it has to be able to run in a job whose install
// step is the thing under suspicion.
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * The measured floor per workspace. Set from a full green run, NOT guessed.
 *
 * Re-measure with:
 *
 *   cd <workspace> && npx vitest run --reporter=default \
 *     --reporter=json --outputFile.json=report.json
 *   node ../scripts/testFloor.mjs <workspace> report.json
 *
 * Raising a floor is routine — do it in the commit that adds the tests. LOWERING
 * one is the interesting case: it means test coverage left the repo, so say in
 * the commit message which tests went and why. A floor lowered to make CI green
 * again, with no explanation, is the failure this file exists to prevent.
 *
 * `files` counts test FILES (`report.testResults.length`), not
 * `numTotalTestSuites` — that field counts `describe` blocks, which is a
 * different and much larger number (704 for 129 server files).
 *
 * `files` and `tests` are platform-stable: a skipped test is still collected
 * and still counted in `numTotalTests` (measured — 5 total / 4 pending for a
 * probe file holding one live test, one `.skip`, one `runIf(false)` and a
 * two-test `describe.skipIf`). That is exactly why `maxSkipped` has to exist
 * separately: the count floors below cannot see a `.skip`.
 *
 * Server re-measured 2026-09-10 on Node 24.18.0 in the ABL-739 release-train
 * worktree, on the tree that merges ABL-736, ABL-728, ABL-631 and ABL-740's
 * four `describeSizeHeadroom` tests: **136 files / 2,850 tests, 0 failed, 0
 * skipped**, `numTotalTests` (which counts a `.skip`, so it is the same figure
 * on Ubuntu, where 4 of them self-skip). Client left at ABL-728's 75 / 918;
 * that branch added no client test and the +1 the tree ran was not its to
 * baseline.
 *
 * ABL-728 had to take the server figure from CI run 34466054189 instead,
 * because `scripts/testFloor.test.ts` would not collect in its worktree
 * (`SyntaxError: Invalid or unexpected token`, ABL-726). That is the CRLF
 * stale-checkout symptom in `docs/claude/25-common-issues.md`, not a platform
 * gap: the file collects fine in a worktree created after the `.gitattributes`
 * pin, which is why a local run now reconciles with CI directly.
 *
 * **ABL-632 raises these by its own counted delta, on top of that baseline.**
 * It adds 1 server file / 25 server tests (`freshnessCoverage.test.ts` 22,
 * `dataFreshness.test.ts` 21 → 24) and 2 client tests (`freshnessPill.test.ts`
 * 11 → 13), counted per file, so the floors move by exactly that much:
 * 136 → 137 files, 2,850 → 2,875 server tests, 918 → 920 client tests.
 * Confirmed against the merged tree (`origin/main` = `02bbdbc` merged in),
 * which runs 137 / 2,875 server and 75 / 921 client — the extra client test is
 * ABL-740's unbaselined +1, deliberately left as slack rather than claimed
 * here. Ratchet by a counted delta rather than by a local absolute: a local run
 * also executes the four `win32`/sibling-gated tests CI skips, and a floor set
 * from an absolute that CI cannot reach fails the build on the gate it was
 * supposed to protect.
 *
 * **ABL-727 raises the server floor by its own counted delta: +5 tests, no new
 * file** (`coreNetPositionService.test.ts` gains the covered-row stamp test and
 * four window-coverage tests), so 2,875 → 2,880 and 137 files stays 137.
 * Confirmed against the merged tree (`origin/main` = `d6e7373` merged in),
 * which runs 137 / 2,880 server tests on Node 24.18.0.
 *
 * **ABL-761 raises the client floor by its own counted delta: +8 tests, no new
 * file** (`mapRows.test.ts` 10 → 15, `endedSeriesNotice.test.ts` 4 → 7), so
 * 920 → 928 and 75 files stays 75. The tree (`origin/main` = `f0fc303`) runs
 * 75 / 929 client on Node 24.18.0 — ABL-740's +1 is still left as slack.
 *
 * **ABL-763 and ABL-762 each raise the client floor by their own counted delta
 * off the same ABL-761 base of 928, on files each touches independently**
 * (`NetPositionTab.test.tsx` 4 → 6 for ABL-763's cause-neutral-notice tests,
 * 4 → 5 for ABL-762's Core-view UTC test, both landing on the merged tree as
 * 4 → 7; `mapRows.test.ts` 15 → 16 is ABL-763 alone; `endedSeriesNotice.test.ts`
 * stays 7, its pinned sentence updated in place). Combined: 928 + 3 + 1 = 932,
 * 75 files stays 75.
 *
 * **ABL-717 raises the server floor by its own counted delta: +1 file, +20
 * tests** (new `dataFreshnessService.test.ts` 7, `freshness.test.ts` +13), so
 * 137 → 138 files and 2,880 → 2,900 tests. The tree (`origin/main` =
 * `4630634`, ABL-717 merged) runs 138 / 2,900 server tests on Node 24.18.0.
 */
export const TEST_FLOORS = {
  client: { files: 75, tests: 932, maxSkipped: 0 },
  server: { files: 138, tests: 2900, maxSkipped: 4 },
};

/**
 * Why `server.maxSkipped` is 4 and not 0.
 *
 * These four tests are gated on something a Linux CI runner does not have, and
 * each gate is a deliberate, named condition in the test file — not a silenced
 * failure. They run on the Windows workstation, where the suite reports 0
 * skipped, and they self-skip in CI:
 *
 *   1. server/src/v1/keys/sqliteApiKeyStore.test.ts — `it.runIf(win32)`, the
 *      case-insensitive path comparison. Asserts a Windows filesystem rule.
 *   2. server/src/docs/claudeMdCitations.test.ts — `it.skipIf(!siblingCheckedOut)`,
 *      resolving `../energy-data-gathering`. CI checks out one repo.
 *   3-4. server/src/services/generationService.test.ts — two
 *      `describe.skipIf(!replicaHasGenerationTable())` blocks, one test each,
 *      reading the workstation replica at a hard-coded absolute path.
 *
 * The ceiling is the point: a fifth skip fails the build. Someone answering a
 * red CI run with `.skip` has to raise this number to get past it, in a diff,
 * with a reason — which is the whole difference between a suppressed test and a
 * hidden one.
 */
export const SKIP_ALLOWANCE_NOTE =
  'Known environment-gated tests: 1 Windows-only path rule, 1 sibling-checkout ' +
  'citation, 2 workstation-replica probes. Anything beyond those is a new skip.';

/** Flatten a vitest JSON report into the numbers this gate cares about. */
export function readReportCounts(report) {
  return {
    files: Array.isArray(report.testResults) ? report.testResults.length : 0,
    tests: report.numTotalTests ?? 0,
    failedTests: report.numFailedTests ?? 0,
    // Counted separately, not folded in: `numFailedTestSuites` counts `describe`
    // blocks, so one failing test reports 2 failing suites and adding them
    // together would print a number that matches nothing a reader can see. It
    // still has to be read, because a file that throws at import reports zero
    // failing TESTS and a failing suite.
    failedSuites: report.numFailedTestSuites ?? 0,
    // A `.skip` keeps its test in `numTotalTests`, so the count gate alone
    // cannot see it. Skipping is the other way coverage leaves silently.
    skipped: (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0),
    success: report.success === true,
  };
}

/**
 * @returns a list of human-readable problems; empty means the run is acceptable.
 */
export function evaluateTestRun(workspace, counts, floors = TEST_FLOORS) {
  const floor = floors[workspace];
  if (!floor) {
    return [`No floor is recorded for workspace "${workspace}". Known: ${Object.keys(floors).join(', ')}.`];
  }

  const problems = [];

  if (!counts.success || counts.failedTests > 0 || counts.failedSuites > 0) {
    problems.push(
      `The report says the run failed (${counts.failedTests} failing test(s), ` +
        `${counts.failedSuites} failing suite(s)).`
    );
  }

  if (counts.files < floor.files) {
    problems.push(
      `Ran ${counts.files} test files; the floor is ${floor.files}. ` +
        `${floor.files - counts.files} file(s) that used to run did not.`
    );
  }

  if (counts.tests < floor.tests) {
    problems.push(
      `Ran ${counts.tests} tests; the floor is ${floor.tests}. ` +
        `${floor.tests - counts.tests} test(s) that used to run did not.`
    );
  }

  const maxSkipped = floor.maxSkipped ?? 0;
  if (counts.skipped > maxSkipped) {
    problems.push(
      `${counts.skipped} test(s) are skipped or todo; the allowance is ${maxSkipped}. ` +
        `A skipped test still counts towards the total, so the floors above cannot ` +
        `see it — it is asserted separately. ${SKIP_ALLOWANCE_NOTE}`
    );
  }

  return problems;
}

function main(argv) {
  const [workspace, reportPath] = argv;

  if (!workspace || !reportPath) {
    console.error('usage: node scripts/testFloor.mjs <workspace> <vitest-json-report>');
    return 2;
  }

  if (!existsSync(reportPath)) {
    console.error(`testFloor: no report at ${reportPath}.`);
    console.error('');
    console.error('vitest was asked for a JSON report and did not write one. That is the');
    console.error('"exited 0 having run nothing" shape, not a missing-file nuisance — treat');
    console.error('the suite as UNRUN, not as passed.');
    return 1;
  }

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (error) {
    console.error(`testFloor: ${reportPath} is not readable JSON: ${error.message}`);
    return 1;
  }

  const counts = readReportCounts(report);
  const floor = TEST_FLOORS[workspace];
  console.log(
    `testFloor(${workspace}): ${counts.files} files / ${counts.tests} tests ` +
      `(floor ${floor ? `${floor.files} / ${floor.tests}` : 'UNKNOWN'}), ` +
      `${counts.failedTests} failed, ${counts.skipped} skipped ` +
      `(allowance ${floor ? (floor.maxSkipped ?? 0) : 'UNKNOWN'})`
  );

  const problems = evaluateTestRun(workspace, counts);
  if (problems.length === 0) return 0;

  console.error('');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  console.error(`If the drop is deliberate, lower TEST_FLOORS.${workspace} in`);
  console.error('scripts/testFloor.mjs in the same commit, and say which tests went and why.');
  return 1;
}

// Only run the CLI when invoked directly, so the test can import the module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
