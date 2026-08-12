import { describe, it, expect } from 'vitest';
import {
  classifyBranch,
  classifyBranches,
  formatFindings,
  issueFromBranch,
  shippingGaps,
  SHIPPED_STATUSES,
  type BranchTip,
} from './unmergedWork.js';

// The real board statuses, measured 2026-08-08 against this company's issues:
// in_progress 2, done 54, blocked 7, backlog 10, in_review 2, todo 2.
const BOARD = new Map<string, string>([
  ['ABL-58', 'done'],
  ['ABL-16', 'done'],
  ['ABL-15', 'done'],
  ['ABL-38', 'done'],
  ['ABL-46', 'done'],
  ['ABL-76', 'in_progress'],
  ['ABL-67', 'blocked'],
  ['ABL-70', 'backlog'],
  ['ABL-72', 'in_review'],
  ['ABL-74', 'todo'],
]);

const branch = (name: string, merged: boolean, tip = 'abc1234'): BranchTip => ({
  name,
  tip,
  merged,
});

/** A branch that is not an ancestor but whose commits all landed elsewhere. */
const rebasedBranch = (name: string, tip = 'abc1234'): BranchTip => ({
  name,
  tip,
  merged: false,
  novelCommits: 0,
});

describe('issueFromBranch', () => {
  it('reads the Paperclip execution-workspace shape', () => {
    expect(issueFromBranch('ABL-15-automate-the-claude-md-citation-check')).toBe('ABL-15');
    expect(
      issueFromBranch(
        'ABL-58-current-load-stat-tile-shows-arbitrarily-stale-data-with-zero-staleness-disclosure-gb-5yr-old',
      ),
    ).toBe('ABL-58');
  });

  it('reads the hand-cut convention shape, whatever the prefix', () => {
    expect(issueFromBranch('fix/abl-35-impossible-zero-load-actuals')).toBe('ABL-35');
    expect(issueFromBranch('feat/abl-60-freshness-staleness-signal')).toBe('ABL-60');
    expect(issueFromBranch('docs/abl-21-join-site-shapes')).toBe('ABL-21');
    expect(issueFromBranch('chore/abl-63-reconcile-origin')).toBe('ABL-63');
    expect(issueFromBranch('test/abl-54-dayahead-price-serving')).toBe('ABL-54');
  });

  it('takes the digit run whole, so abl-6 and abl-60 stay distinct', () => {
    expect(issueFromBranch('feat/abl-6-model-comparison-panel')).toBe('ABL-6');
    expect(issueFromBranch('feat/abl-60-freshness')).toBe('ABL-60');
  });

  it('returns null for a branch that names no issue rather than guessing', () => {
    // All real branches in this repo.
    expect(issueFromBranch('main')).toBeNull();
    expect(issueFromBranch('feat/accuracy-model-param')).toBeNull();
    expect(issueFromBranch('claude/nervous-mcnulty-abf971')).toBeNull();
    expect(issueFromBranch('refactor/unreachable-presets-dead-constants')).toBeNull();
    expect(issueFromBranch('_tmpcheck')).toBeNull();
  });

  it('does not match a word that merely contains the letters', () => {
    expect(issueFromBranch('feat/stable-42-thing')).toBeNull();
    expect(issueFromBranch('feat/scrabble-7')).toBeNull();
  });
});

describe('classifyBranch', () => {
  it('says merged when the tip is an ancestor, whatever the issue says', () => {
    expect(classifyBranch(branch('fix/abl-35-x', true), BOARD).verdict).toBe('merged');
    expect(classifyBranch(branch('ABL-76-x', true), BOARD).verdict).toBe('merged');
  });

  // The ABL-76 defect itself.
  it('flags an unmerged branch whose issue reads done', () => {
    const f = classifyBranch(branch('ABL-58-current-load-stat-tile', false, '74aba1a'), BOARD);
    expect(f).toMatchObject({
      issue: 'ABL-58',
      issueStatus: 'done',
      verdict: 'shipping-gap',
      tip: '74aba1a',
    });
  });

  it('leaves work that has not claimed to be finished alone', () => {
    for (const [name, status] of [
      ['ABL-76-five-issues', 'in_progress'],
      ['ABL-67-delete-rows', 'blocked'],
      ['ABL-70-gate-read', 'backlog'],
      ['ABL-72-gate-harness', 'in_review'],
      ['ABL-74-fr-flows', 'todo'],
    ] as const) {
      const f = classifyBranch(branch(name, false), BOARD);
      expect(f.verdict, `${name} (${status})`).toBe('in-flight');
      expect(f.issueStatus).toBe(status);
    }
  });

  it('reports rather than fails when the board does not have the issue', () => {
    // A branch for an issue on another board, or one since deleted. Not knowing
    // is not the same as knowing it shipped.
    const f = classifyBranch(branch('ABL-999-gone', false), BOARD);
    expect(f).toMatchObject({ issue: 'ABL-999', issueStatus: null, verdict: 'unknown-issue' });
  });

  it('reports rather than fails when the branch names no issue', () => {
    const f = classifyBranch(branch('claude/nervous-mcnulty-abf971', false), BOARD);
    expect(f).toMatchObject({ issue: null, issueStatus: null, verdict: 'unattributed' });
  });

  it('only treats `done` as shipped', () => {
    expect([...SHIPPED_STATUSES]).toEqual(['done']);
  });
});

// The three false positives measured against this repo on 2026-08-12: a tip
// that is not an ancestor, on a `done` issue, whose every commit is already on
// origin/main under another sha. Ancestry alone called each of these a shipping
// gap; patch identity clears them.
describe('classifyBranch — patch identity, not just ancestry', () => {
  it('clears a cherry-picked branch on a done issue instead of failing it', () => {
    const f = classifyBranch(rebasedBranch('ABL-58-current-load', '3c42ec8'), BOARD);
    expect(f).toMatchObject({
      issue: 'ABL-58',
      issueStatus: 'done',
      verdict: 'rebased',
      tip: '3c42ec8',
    });
    expect(shippingGaps([f])).toEqual([]);
  });

  it('still fails a branch with even one commit that did not land', () => {
    const f = classifyBranch(
      { name: 'ABL-58-current-load', tip: '74aba1a', merged: false, novelCommits: 1 },
      BOARD,
    );
    expect(f.verdict).toBe('shipping-gap');
  });

  it('prefers ancestry: a merged branch reads merged whatever the count says', () => {
    const f = classifyBranch(
      { name: 'ABL-58-x', tip: 'abc1234', merged: true, novelCommits: 3 },
      BOARD,
    );
    expect(f.verdict).toBe('merged');
  });

  it('clears a rebased branch whatever the issue status, since the work shipped', () => {
    for (const name of ['ABL-76-five-issues', 'ABL-999-gone', 'claude/nervous-mcnulty-abf971']) {
      expect(classifyBranch(rebasedBranch(name), BOARD).verdict, name).toBe('rebased');
    }
  });

  // Fail-closed: an absent, null or nonsense count is "not measured", and an
  // unmeasured branch must never read as an all-clear.
  it('falls back to ancestry when the count is missing, null or nonsense', () => {
    const cases: Array<number | null | undefined> = [undefined, null, -1, 1.5, Number.NaN];
    for (const novelCommits of cases) {
      const f = classifyBranch(
        { name: 'ABL-58-current-load', tip: '74aba1a', merged: false, novelCommits },
        BOARD,
      );
      expect(f.verdict, `novelCommits=${String(novelCommits)}`).toBe('shipping-gap');
    }
  });

  // A squash merge collapses N commits into one whose patch matches none of
  // them, so the branch still reads novel. Over-reporting is the safe direction
  // and this is the test that pins it as deliberate rather than an oversight.
  it('still reports a squash-merged branch, which is the safe direction', () => {
    const f = classifyBranch(
      { name: 'ABL-58-current-load', tip: '74aba1a', merged: false, novelCommits: 3 },
      BOARD,
    );
    expect(f.verdict).toBe('shipping-gap');
  });
});

describe('classifyBranches', () => {
  const branches = [
    branch('fix/abl-35-impossible-zero-load-actuals', true),
    branch('ABL-76-five-issues', false),
    branch('ABL-58-current-load', false, '74aba1a'),
    branch('claude/nervous-mcnulty-abf971', false),
    branch('ABL-15-citation-check', false, 'e9bbb62'),
    branch('ABL-999-gone', false),
  ];

  it('drops merged branches, which are the overwhelming majority', () => {
    const out = classifyBranches(branches, BOARD);
    expect(out.map((f) => f.branch)).not.toContain('fix/abl-35-impossible-zero-load-actuals');
  });

  it('leads with the shipping gaps', () => {
    const out = classifyBranches(branches, BOARD);
    expect(out.slice(0, 2).map((f) => f.branch)).toEqual([
      'ABL-15-citation-check',
      'ABL-58-current-load',
    ]);
    expect(shippingGaps(out).map((f) => f.issue)).toEqual(['ABL-15', 'ABL-58']);
  });

  it('is clean when everything done is merged', () => {
    const allMerged = branches.map((b) => ({ ...b, merged: true }));
    expect(shippingGaps(classifyBranches(allMerged, BOARD))).toEqual([]);
  });

  // The state this branch leaves the repo in.
  it('reports no gap for the five ABL-76 merges once they are ancestors', () => {
    const merged = ['ABL-58-x', 'ABL-16-x', 'ABL-15-x', 'ABL-38-x', 'ABL-46-x'].map((n) =>
      branch(n, true),
    );
    expect(shippingGaps(classifyBranches(merged, BOARD))).toEqual([]);
  });

  it('keeps rebased branches but sorts them last, below every real finding', () => {
    const out = classifyBranches(
      [rebasedBranch('ABL-16-cherry-picked'), ...branches],
      BOARD,
    );
    expect(out.at(-1)).toMatchObject({ branch: 'ABL-16-cherry-picked', verdict: 'rebased' });
    expect(out.map((f) => f.branch)).toContain('ABL-16-cherry-picked');
  });

  // The measured 2026-08-12 shape: 7 gaps by ancestry, 4 of them real.
  it('reports only the genuinely unpublished branches of a mixed set', () => {
    const mixed: BranchTip[] = [
      // Real: commits that exist nowhere else.
      { name: 'ABL-58-real-gap', tip: 'bfb3411', merged: false, novelCommits: 1 },
      { name: 'ABL-15-real-gap', tip: 'a8e8a88', merged: false, novelCommits: 2 },
      // Phantom: cherry-picked, every patch already on the target.
      rebasedBranch('ABL-16-phantom', '3c42ec8'),
      rebasedBranch('ABL-38-phantom', '484b3e2'),
      rebasedBranch('ABL-46-phantom', 'd84e97b'),
    ];
    expect(shippingGaps(classifyBranches(mixed, BOARD)).map((f) => f.branch)).toEqual([
      'ABL-15-real-gap',
      'ABL-58-real-gap',
    ]);
  });
});

describe('formatFindings', () => {
  it('returns empty for nothing to report, so empty can mean clean', () => {
    expect(formatFindings([], 'main')).toBe('');
  });

  it('names the issue, its status, the branch, the tip and the target', () => {
    const out = formatFindings(
      classifyBranches([branch('ABL-58-current-load', false, '74aba1a')], BOARD),
      'main',
    );
    expect(out).toContain('SHIPPING GAP');
    expect(out).toContain('ABL-58');
    expect(out).toContain('done');
    expect(out).toContain('74aba1a');
    expect(out).toContain('main');
  });

  it('does not shout about in-flight work', () => {
    const out = formatFindings(classifyBranches([branch('ABL-76-x', false)], BOARD), 'main');
    expect(out).not.toContain('SHIPPING GAP');
    expect(out).toContain('in flight');
  });

  it('says a rebased branch is already there, and does not shout', () => {
    const out = formatFindings(
      classifyBranches([rebasedBranch('ABL-58-cherry-picked', '3c42ec8')], BOARD),
      'origin/main',
    );
    expect(out).not.toContain('SHIPPING GAP');
    expect(out).toContain('already on origin/main');
    expect(out).toContain('ABL-58-cherry-picked');
    expect(out).toContain('3c42ec8');
    expect(out).toContain('Safe to delete');
  });
});
