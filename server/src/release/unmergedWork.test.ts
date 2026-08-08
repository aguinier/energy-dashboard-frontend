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
});
