/**
 * The gate that would have caught 2026-08-20.
 *
 * Every branch, tip, commit count and diffstat in the "the 2026-08-20 checkout"
 * block is measured from the real repository on that date — `git cherry
 * origin/main <branch>` for the counts and `git diff --numstat origin/main...
 * <branch>` for the sizes — not invented. That matters here more than usual,
 * because the whole claim of this gate is that it separates six real branches
 * from five phantoms, and a fixture that made up the split would prove nothing.
 */
import { describe, it, expect } from 'vitest';
import {
  STRANDED_WORK_FAILS_CHECK,
  classifyStrandedBranch,
  classifyStrandedBranches,
  formatStrandedWork,
  isPublishedBranch,
  parseNumstat,
  strandedFindings,
  strandedHeadline,
  type LocalBranch,
} from './strandedWork.js';

/** 2026-08-20T20:00:00Z, the hour ABL-498 was filed. */
const NOW = Date.parse('2026-08-20T20:00:00Z');

function branch(over: Partial<LocalBranch> & { name: string }): LocalBranch {
  return {
    // Distinct per name unless a case deliberately shares one. Findings are
    // folded by tip, so a constant default would quietly merge unrelated cases
    // and make a passing test prove nothing.
    tip: over.name.replace(/[^a-z0-9]/gi, '').slice(0, 7).toLowerCase() || 'deadbee',
    merged: false,
    novelCommits: 1,
    lastCommitIso: '2026-08-20T18:00:00+02:00',
    diffVsMergeBase: { files: 1, insertions: 1, deletions: 0 },
    ...over,
  };
}

describe('parseNumstat', () => {
  it('sums the real ABL-469 shape', () => {
    const raw = ['1804\t35\tsrc/a.ts', '0\t0\tsrc/b.ts'].join('\n');
    expect(parseNumstat(raw)).toEqual({ files: 2, insertions: 1804, deletions: 35 });
  });

  it('counts a binary file as changed but invents no line count', () => {
    // `-\t-\t<path>` is git's binary marker. A fabricated line count here would
    // be exactly the defect this repo exists to avoid.
    const raw = ['12\t3\tsrc/a.ts', '-\t-\tassets/logo.png'].join('\n');
    expect(parseNumstat(raw)).toEqual({ files: 2, insertions: 12, deletions: 3 });
  });

  it('is empty for empty input rather than throwing', () => {
    expect(parseNumstat('')).toEqual({ files: 0, insertions: 0, deletions: 0 });
    expect(parseNumstat('\n\n')).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });

  it('skips a line that is not numstat output instead of guessing at it', () => {
    const raw = ['warning: LF will be replaced by CRLF', '5\t2\tsrc/a.ts'].join('\n');
    expect(parseNumstat(raw)).toEqual({ files: 1, insertions: 5, deletions: 2 });
  });

  it('handles a rename, which git still reports as one line', () => {
    expect(parseNumstat('3\t1\tsrc/{old => new}/a.ts')).toEqual({
      files: 1,
      insertions: 3,
      deletions: 1,
    });
  });
});

describe('isPublishedBranch', () => {
  it('an ancestor is published whatever the count says', () => {
    expect(isPublishedBranch({ merged: true, novelCommits: null })).toBe(true);
    expect(isPublishedBranch({ merged: true, novelCommits: 4 })).toBe(true);
  });

  it('a measured zero is published under other shas', () => {
    expect(isPublishedBranch({ merged: false, novelCommits: 0 })).toBe(true);
  });

  it('never reads an unmeasured count as published', () => {
    expect(isPublishedBranch({ merged: false, novelCommits: null })).toBe(false);
    expect(isPublishedBranch({ merged: false })).toBe(false);
    expect(isPublishedBranch({ merged: false, novelCommits: Number.NaN })).toBe(false);
    expect(isPublishedBranch({ merged: false, novelCommits: -1 })).toBe(false);
    expect(isPublishedBranch({ merged: false, novelCommits: 1.5 })).toBe(false);
  });
});

describe('classifyStrandedBranch', () => {
  it('an ancestor is merged', () => {
    const f = classifyStrandedBranch(branch({ name: 'old', merged: true }), NOW);
    expect(f.verdict).toBe('merged');
  });

  it('the phantom case: not an ancestor, zero novel patches, is rebased', () => {
    // ABL-166 (3c42ec8) on the real checkout — cherry-picked onto origin/main.
    const f = classifyStrandedBranch(
      branch({ name: 'ABL-166-restore-forecast-quality-page', tip: '3c42ec8', novelCommits: 0 }),
      NOW,
    );
    expect(f.verdict).toBe('rebased');
  });

  it('the real case: not an ancestor, one novel patch, is stranded', () => {
    // ABL-469 (6d2c1f3) — a finished 16-file feature that existed nowhere else.
    const f = classifyStrandedBranch(
      branch({ name: 'ABL-469-dashboard-auto-select', tip: '6d2c1f3', novelCommits: 1 }),
      NOW,
    );
    expect(f.verdict).toBe('stranded');
    expect(f.novelCommits).toBe(1);
    expect(f.branches).toEqual(['ABL-469-dashboard-auto-select']);
  });

  it('fails closed: an unmeasurable count is reported, never treated as clean', () => {
    for (const novelCommits of [null, Number.NaN, -1, 2.5]) {
      const f = classifyStrandedBranch(branch({ name: 'b', novelCommits }), NOW);
      expect(f.verdict).toBe('unmeasured');
      // Nulled rather than carried through, so nothing downstream can render a
      // nonsense count as a measurement.
      expect(f.novelCommits).toBeNull();
    }
  });

  it('takes the age from the caller-supplied clock, not the calendar', () => {
    const f = classifyStrandedBranch(
      branch({ name: 'b', lastCommitIso: '2026-08-14T20:00:00Z' }),
      NOW,
    );
    expect(f.ageDays).toBe(6);
  });

  it('reports an unreadable or absent commit date as unknown, not as zero', () => {
    expect(classifyStrandedBranch(branch({ name: 'b', lastCommitIso: null }), NOW).ageDays).toBeNull();
    expect(
      classifyStrandedBranch(branch({ name: 'b', lastCommitIso: 'not a date' }), NOW).ageDays,
    ).toBeNull();
  });

  it('clamps a tip dated in the future to 0 rather than going negative', () => {
    const f = classifyStrandedBranch(
      branch({ name: 'b', lastCommitIso: '2026-09-01T00:00:00Z' }),
      NOW,
    );
    expect(f.ageDays).toBe(0);
  });
});

describe('several refs on one commit are one body of work, not several', () => {
  // The first real run of this gate double-counted `16f27cb`, which carried
  // both the Paperclip execution-workspace name and the hand-cut convention
  // name. Two refs, one commit, one piece of unpublished work.
  const SHARED = [
    branch({
      name: 'ABL-494-day-ahead-freshness-deadline-must-be-per-stream',
      tip: '16f27cb',
      diffVsMergeBase: { files: 7, insertions: 302, deletions: 50 },
    }),
    branch({
      name: 'fix/abl-494-per-stream-day-ahead-deadline',
      tip: '16f27cb',
      current: true,
      diffVsMergeBase: { files: 7, insertions: 302, deletions: 50 },
    }),
  ];

  it('folds them into one finding carrying both names', () => {
    const findings = strandedFindings(classifyStrandedBranches(SHARED, NOW));
    expect(findings).toHaveLength(1);
    expect(findings[0].branches).toEqual([
      'ABL-494-day-ahead-freshness-deadline-must-be-per-stream',
      'fix/abl-494-per-stream-day-ahead-deadline',
    ]);
    expect(findings[0].current).toBe(true);
  });

  it('counts commits, not refs, so the headline cannot overstate', () => {
    const findings = classifyStrandedBranches(SHARED, NOW);
    expect(strandedHeadline(findings)).toContain('1 local commit');
    const out = formatStrandedWork(findings, 'origin/main');
    expect(out).toContain('STRANDED WORK  1 commit (across 2 local refs) not on origin/main');
    // The size is stated once, not added to itself.
    expect(out).toContain('7 files +302/-50 vs merge base');
    expect(out).not.toContain('+604');
  });

  it('names the extra refs rather than dropping them — both are deletable', () => {
    const out = formatStrandedWork(classifyStrandedBranches(SHARED, NOW), 'origin/main');
    expect(out).toContain('also at: fix/abl-494-per-stream-day-ahead-deadline');
    expect(out).toContain('checked out here');
  });

  it('merges conservatively when two records for one commit disagree', () => {
    const findings = strandedFindings(
      classifyStrandedBranches(
        [
          branch({ name: 'a', tip: 'abc1234', novelCommits: 2 }),
          branch({ name: 'b', tip: 'abc1234', novelCommits: null }),
        ],
        NOW,
      ),
    );
    // Unmeasured is the worse reading and wins, and the count it could not
    // confirm is not carried through as if it had been.
    expect(findings[0].verdict).toBe('unmeasured');
    expect(findings[0].novelCommits).toBeNull();
  });
});

describe('the 2026-08-20 checkout, end to end', () => {
  // Measured that day. Six branches carry novel patches; five are non-ancestors
  // whose commits are already on origin/main under other shas.
  const REAL: LocalBranch[] = [
    branch({
      name: 'ABL-469-dashboard-auto-select-the-best-available-forecast-per-country-stream-pair',
      tip: '6d2c1f3',
      novelCommits: 1,
      lastCommitIso: '2026-08-20T18:38:23+02:00',
      diffVsMergeBase: { files: 16, insertions: 1804, deletions: 35 },
    }),
    branch({
      name: 'docs/abl-460-node-modules-repair',
      tip: 'e43dc5e',
      novelCommits: 2,
      lastCommitIso: '2026-08-20T18:37:25+02:00',
      diffVsMergeBase: { files: 1, insertions: 99, deletions: 23 },
    }),
    branch({
      name: 'ABL-93-net-position-forecast-quality',
      tip: 'ff40751',
      novelCommits: 1,
      lastCommitIso: '2026-08-09T22:43:46+02:00',
      diffVsMergeBase: { files: 10, insertions: 68, deletions: 19 },
    }),
    branch({
      name: 'claude/practical-panini-71e4bd',
      tip: 'e7cda0d',
      novelCommits: 1,
      lastCommitIso: '2026-08-04T16:48:04+02:00',
      diffVsMergeBase: { files: 9, insertions: 129, deletions: 15 },
    }),
    branch({
      name: 'fix/frontend-wal-mount',
      tip: '67a9583',
      novelCommits: 1,
      lastCommitIso: '2026-04-21T14:44:07+02:00',
      diffVsMergeBase: { files: 1, insertions: 3, deletions: 1 },
    }),
    branch({
      name: 'fix/abl-494-per-stream-day-ahead-deadline',
      tip: '16f27cb',
      novelCommits: 1,
      current: true,
      lastCommitIso: '2026-08-20T18:54:26+02:00',
      diffVsMergeBase: { files: 7, insertions: 302, deletions: 50 },
    }),
  ];

  const PHANTOMS: LocalBranch[] = [
    ['ABL-166-restore-forecast-quality-page', '3c42ec8'],
    ['ABL-216-no-data-shwon-in-the-acceptance', '484b3e2'],
    ['ABL-249-syncblackoutwindow-ts-20-min-pad-insufficient', 'd84e97b'],
    ['ABL-70-c2c-promotion-gate-read-on-14-live-shadow-vintages', '9214114'],
    ['claude/determined-merkle-7f23e0', '8bbd970'],
  ].map(([name, tip]) => branch({ name, tip, novelCommits: 0 }));

  const ANCESTORS: LocalBranch[] = ['feat/abl-305-openapi', 'fix/abl-388-generation-accuracy-wape'].map(
    (name) => branch({ name, merged: true, novelCommits: null }),
  );

  const findings = classifyStrandedBranches([...PHANTOMS, ...ANCESTORS, ...REAL], NOW);

  it('surfaces the six real branches and not one of the five phantoms', () => {
    const surfaced = strandedFindings(findings).map((f) => f.branches[0]);
    expect(surfaced).toHaveLength(6);
    for (const p of PHANTOMS) expect(surfaced).not.toContain(p.name);
    for (const r of REAL) expect(surfaced).toContain(r.name);
  });

  it('leads with the biggest body of unpublished work', () => {
    // The point of the gate: gate 1 printed ABL-469 and fix/frontend-wal-mount
    // as two indistinguishable "in flight" lines.
    const surfaced = strandedFindings(findings).map((f) => f.branches[0]);
    expect(surfaced[0]).toContain('ABL-469');
    expect(surfaced.indexOf('fix/frontend-wal-mount')).toBeGreaterThan(
      surfaced.indexOf('ABL-93-net-position-forecast-quality'),
    );
  });

  it('sorts the branch you are on below the ones that need action', () => {
    const surfaced = strandedFindings(findings).map((f) => f.branches[0]);
    expect(surfaced[surfaced.length - 1]).toBe('fix/abl-494-per-stream-day-ahead-deadline');
  });

  it('renders the evidence that tells a finished feature from a scratch commit', () => {
    const out = formatStrandedWork(findings, 'origin/main');
    expect(out).toContain('16 files +1804/-35 vs merge base');
    expect(out).toContain('1 file +3/-1 vs merge base');
    expect(out).toContain('(16f27cb, checked out here)');
  });

  it('counts the phantoms without listing them', () => {
    const out = formatStrandedWork(findings, 'origin/main');
    expect(out).toContain('Excluded by patch identity: 5 commits');
    for (const p of PHANTOMS) expect(out).not.toContain(p.tip);
  });

  it('drops merged ancestors entirely — they are the overwhelming majority', () => {
    const out = formatStrandedWork(findings, 'origin/main');
    for (const a of ANCESTORS) expect(out).not.toContain(a.name);
  });

  it('gives a headline that cannot be read as an all-clear', () => {
    const headline = strandedHeadline(findings);
    expect(headline).toContain('6 local commits');
    expect(headline).toContain('5 of them not the commit you are on');
  });
});

describe('formatStrandedWork', () => {
  it('is empty when every branch is published, so empty means clean', () => {
    const findings = classifyStrandedBranches(
      [branch({ name: 'a', merged: true }), branch({ name: 'b', merged: true })],
      NOW,
    );
    expect(formatStrandedWork(findings, 'origin/main')).toBe('');
    expect(strandedHeadline(findings)).toBe('');
  });

  it('still reports the phantom count when nothing is stranded', () => {
    const findings = classifyStrandedBranches([branch({ name: 'a', novelCommits: 0 })], NOW);
    expect(formatStrandedWork(findings, 'origin/main')).toContain('Excluded by patch identity: 1 commit');
    // ...but the headline stays silent: a rebased branch is not stranded work.
    expect(strandedHeadline(findings)).toBe('');
  });

  it('names an unmeasured branch as unmeasured rather than quoting a count', () => {
    const findings = classifyStrandedBranches(
      [branch({ name: 'weird', novelCommits: null, diffVsMergeBase: null })],
      NOW,
    );
    const out = formatStrandedWork(findings, 'origin/main');
    expect(out).toContain('novel-commit count UNMEASURED');
    expect(out).toContain('size not measured');
  });

  it('puts an unmeasured branch above the measured ones', () => {
    const findings = classifyStrandedBranches(
      [
        branch({ name: 'measured', novelCommits: 3, diffVsMergeBase: { files: 40, insertions: 900, deletions: 900 } }),
        branch({ name: 'unmeasured', novelCommits: null }),
      ],
      NOW,
    );
    expect(strandedFindings(findings)[0].branches[0]).toBe('unmeasured');
  });

  it('names the target ref it compared against', () => {
    const findings = classifyStrandedBranches([branch({ name: 'a' })], NOW);
    expect(formatStrandedWork(findings, 'upstream/release')).toContain('upstream/release');
  });

  it('says "1 commit" and "1 file", never "1 commits"', () => {
    const findings = classifyStrandedBranches(
      [branch({ name: 'a', novelCommits: 1, diffVsMergeBase: { files: 1, insertions: 2, deletions: 0 } })],
      NOW,
    );
    const out = formatStrandedWork(findings, 'origin/main');
    expect(out).toContain('1 commit not on the target');
    expect(out).toContain('1 file +2/-0');
  });
});

describe('the failure policy is a decision, not an omission', () => {
  it('reports and never fails, because this checkout always carries other runs branches', () => {
    // Flipping this makes `predone` red on every day another run has work in
    // flight — the "cries wolf" failure `unmergedWork.ts` already documents.
    expect(STRANDED_WORK_FAILS_CHECK).toBe(false);
  });
});
