/**
 * The gate that would have caught 2026-08-12.
 *
 * The case that matters most here is `main ahead N, behind 0` — that is the
 * literal state the CEO measured at 13:52Z (12 ahead, 0 behind) with five
 * issues reading `done`, and the state the old check reported as a single
 * `unattributed` line before exiting 0.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyPublishState,
  formatPublishState,
  isPublishGap,
  type PublishCounts,
} from './publishState.js';

describe('classifyPublishState', () => {
  it('0 ahead / 0 behind is published', () => {
    expect(classifyPublishState({ ahead: 0, behind: 0 })).toBe('published');
  });

  it('0 ahead / N behind is behind, not a gap — nothing local is stranded', () => {
    expect(classifyPublishState({ ahead: 0, behind: 4 })).toBe('behind');
  });

  it('N ahead / 0 behind is unpublished — the ABL-311 defect', () => {
    expect(classifyPublishState({ ahead: 12, behind: 0 })).toBe('unpublished');
  });

  it('N ahead / M behind is diverged', () => {
    expect(classifyPublishState({ ahead: 4, behind: 3 })).toBe('diverged');
  });

  it('a missing local main is reported, not failed', () => {
    expect(classifyPublishState(null)).toBe('no-local-main');
  });

  it('rejects nonsense counts rather than classifying them', () => {
    expect(() => classifyPublishState({ ahead: -1, behind: 0 })).toThrow(/non-negative/);
    expect(() => classifyPublishState({ ahead: 1.5, behind: 0 })).toThrow(/non-negative/);
    expect(() =>
      classifyPublishState({ ahead: Number.NaN, behind: 0 } as PublishCounts),
    ).toThrow(/non-negative/);
  });
});

describe('isPublishGap', () => {
  it('fails exactly the two verdicts that mean work is stranded locally', () => {
    expect(isPublishGap('unpublished')).toBe(true);
    expect(isPublishGap('diverged')).toBe(true);
  });

  it('does not fail on healthy or inapplicable states', () => {
    // `behind` is what every checkout looks like between someone else's push
    // and your next fetch. Failing on it would make the gate cry wolf.
    expect(isPublishGap('published')).toBe(false);
    expect(isPublishGap('behind')).toBe(false);
    expect(isPublishGap('no-local-main')).toBe(false);
  });
});

describe('the 2026-08-12 scenario, end to end', () => {
  it('12 ahead / 0 behind fails and names the push as the fix', () => {
    const counts = { ahead: 12, behind: 0 };
    const verdict = classifyPublishState(counts);

    expect(verdict).toBe('unpublished');
    expect(isPublishGap(verdict)).toBe(true);

    const msg = formatPublishState(verdict, counts, 'origin/main');
    expect(msg).toContain('NOT PUBLISHED');
    expect(msg).toContain('12 commit(s) ahead');
    expect(msg).toContain('git push origin main');
  });

  it('the mid-hour re-formed gap (4 ahead / 3 behind) also fails', () => {
    const counts = { ahead: 4, behind: 3 };
    const verdict = classifyPublishState(counts);

    expect(isPublishGap(verdict)).toBe(true);
    expect(formatPublishState(verdict, counts, 'origin/main')).toContain('NOT PUBLISHED');
  });

  it('the state the CEO left the repo in (0 ahead / 4 behind) passes', () => {
    const counts = { ahead: 0, behind: 4 };
    const verdict = classifyPublishState(counts);

    expect(isPublishGap(verdict)).toBe(false);
    expect(formatPublishState(verdict, counts, 'origin/main')).toContain('0 ahead');
  });
});

describe('formatPublishState', () => {
  it('never renders a failing verdict without the word NOT PUBLISHED', () => {
    for (const [verdict, counts] of [
      ['unpublished', { ahead: 1, behind: 0 }],
      ['diverged', { ahead: 1, behind: 1 }],
    ] as const) {
      expect(formatPublishState(verdict, counts, 'origin/main')).toContain('NOT PUBLISHED');
    }
  });

  it('tells you to integrate before publishing when diverged', () => {
    const msg = formatPublishState('diverged', { ahead: 2, behind: 5 }, 'origin/main');
    expect(msg).toMatch(/pull|merge/);
    expect(msg).toContain('git push origin main');
  });

  it('handles null counts without throwing', () => {
    expect(formatPublishState('no-local-main', null, 'origin/main')).toContain('nothing to publish');
  });
});
