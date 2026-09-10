import { describe, expect, it } from 'vitest';
import { TEST_FLOORS, evaluateTestRun, readReportCounts } from './testFloor.mjs';

/** A vitest JSON report, trimmed to the fields the gate reads. */
const report = (over: Record<string, unknown> = {}) => ({
  numTotalTestSuites: 704,
  numFailedTestSuites: 0,
  numTotalTests: 2678,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  testResults: Array.from({ length: 129 }, () => ({})),
  success: true,
  ...over,
});

const floors = { demo: { files: 10, tests: 100, maxSkipped: 0 } };
const counts = (over: Record<string, unknown> = {}) => ({
  files: 10,
  tests: 100,
  failedTests: 0,
  failedSuites: 0,
  skipped: 0,
  success: true,
  ...over,
});

describe('readReportCounts', () => {
  it('counts test FILES, not describe blocks', () => {
    // The whole reason this helper exists. `numTotalTestSuites` is 704 for the
    // 129-file server suite: reading it as a file count would put the floor
    // 5x too high and make every run red for the wrong reason.
    expect(readReportCounts(report()).files).toBe(129);
  });

  it('keeps failing suites separate from failing tests rather than summing them', () => {
    // Measured: one timed-out test reports numFailedTests 1 and
    // numFailedTestSuites 2, because suites are `describe` blocks. Adding them
    // would print "3 failing entries" for one failing test.
    const c = readReportCounts(report({ numFailedTests: 1, numFailedTestSuites: 2 }));
    expect(c.failedTests).toBe(1);
    expect(c.failedSuites).toBe(2);
  });

  it('adds pending and todo together as skipped', () => {
    expect(readReportCounts(report({ numPendingTests: 2, numTodoTests: 1 })).skipped).toBe(3);
  });

  it('treats a report with no testResults array as zero files rather than crashing', () => {
    expect(readReportCounts({ numTotalTests: 5 }).files).toBe(0);
  });

  it('reads success strictly, so a missing field is not a pass', () => {
    expect(readReportCounts({}).success).toBe(false);
  });
});

describe('evaluateTestRun', () => {
  it('accepts a run that meets the floor exactly', () => {
    expect(evaluateTestRun('demo', counts(), floors)).toEqual([]);
  });

  it('accepts a run above the floor — adding tests must not need a floor bump first', () => {
    expect(evaluateTestRun('demo', counts({ files: 11, tests: 140 }), floors)).toEqual([]);
  });

  it('rejects a green run that lost a whole test file', () => {
    // The ABL-647 case: nothing failed, so vitest exits 0, and 40 tests are gone.
    const problems = evaluateTestRun('demo', counts({ files: 9, tests: 60 }), floors);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('Ran 9 test files; the floor is 10');
    expect(problems[1]).toContain('Ran 60 tests; the floor is 100');
  });

  it('rejects a run that reports failures even if the counts are met', () => {
    expect(
      evaluateTestRun('demo', counts({ failedTests: 1, success: false }), floors)[0]
    ).toContain('the run failed');
  });

  it('rejects a file that threw at import, which fails a suite and no test', () => {
    // Zero failing TESTS, one failing SUITE. Reading numFailedTests alone would
    // call this run clean.
    const problems = evaluateTestRun('demo', counts({ failedSuites: 1, success: false }), floors);
    expect(problems[0]).toContain('1 failing suite(s)');
  });

  it('rejects a run whose report claims failure while every count is intact', () => {
    // vitest sets success:false for an unhandled error outside any test. The
    // counts are intact, so only the success flag catches it.
    expect(evaluateTestRun('demo', counts({ success: false }), floors)).toHaveLength(1);
  });

  it('rejects a skipped test the allowance does not cover', () => {
    // `it.skip` leaves the test in numTotalTests, so files and tests both still
    // meet the floor. Coverage left anyway.
    const problems = evaluateTestRun('demo', counts({ skipped: 1 }), floors);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('1 test(s) are skipped or todo; the allowance is 0');
  });

  it('allows skips up to the recorded allowance, so a CI-gated test is not a failure', () => {
    // The server suite reports 0 skipped on the Windows workstation and 4 in
    // Linux CI, because four tests are gated on a sibling checkout, the local
    // replica and win32 path semantics.
    const gated = { demo: { files: 10, tests: 100, maxSkipped: 4 } };
    expect(evaluateTestRun('demo', counts({ skipped: 4 }), gated)).toEqual([]);
  });

  it('rejects one skip past the allowance — the fifth is the new one', () => {
    const gated = { demo: { files: 10, tests: 100, maxSkipped: 4 } };
    const problems = evaluateTestRun('demo', counts({ skipped: 5 }), gated);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the allowance is 4');
  });

  it('treats a floor with no maxSkipped as allowing none', () => {
    const legacy = { demo: { files: 10, tests: 100 } };
    expect(evaluateTestRun('demo', counts({ skipped: 1 }), legacy)).toHaveLength(1);
  });

  it('refuses an unknown workspace instead of passing it by default', () => {
    // A typo'd workspace name in the workflow must not read as "no floor, so ok".
    expect(evaluateTestRun('sevrer', counts(), floors)[0]).toContain('No floor is recorded');
  });
});

describe('TEST_FLOORS', () => {
  it('covers exactly the two workspaces CI runs', () => {
    expect(Object.keys(TEST_FLOORS).sort()).toEqual(['client', 'server']);
  });

  it('records a positive floor for both, so a zeroed floor cannot pass silently', () => {
    for (const [workspace, floor] of Object.entries(TEST_FLOORS)) {
      expect(floor.files, workspace).toBeGreaterThan(0);
      expect(floor.tests, workspace).toBeGreaterThan(floor.files);
    }
  });

  it('records an explicit skip allowance for both, rather than leaving it undefined', () => {
    // An absent allowance still defaults to 0, but leaving it out is how the
    // number stops being a decision someone made.
    for (const [workspace, floor] of Object.entries(TEST_FLOORS)) {
      expect(typeof floor.maxSkipped, workspace).toBe('number');
      expect(floor.maxSkipped, workspace).toBeGreaterThanOrEqual(0);
    }
  });
});
