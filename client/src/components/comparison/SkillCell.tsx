import { SCALE_CLEAN, SCALE_DIRTY } from '@/lib/dataScale';
import type { SkillVsSeasonalNaive } from '@/types';
import { describeSkill } from './skillBadge';

/**
 * Skill vs the D-7 seasonal-naive baseline, rendered beside the WAPE it was
 * measured with (ABL-186) — shared by `ComparisonLeaderboard` and
 * `CountryRanking` so the two views cannot drift on what "a loss" looks like.
 * A loss reads as a failure — colour plus a down-marker plus explicit words,
 * never colour alone — and "insufficient data" is its own state rather than a
 * dash or a coerced 0%. See `skillBadge.ts` for the pure classification.
 */
export function SkillCell({ skill, compact = false }: { skill: SkillVsSeasonalNaive | undefined; compact?: boolean }) {
  const display = describeSkill(skill);
  if (display.kind === 'insufficient') {
    return (
      <span className="text-xs text-ink-faint" title={`No D-7 baseline pairs in this window (n=${display.n})`}>
        insufficient data
      </span>
    );
  }
  const colour = display.kind === 'loss' ? SCALE_DIRTY : SCALE_CLEAN;
  return (
    <span className="inline-flex flex-col items-center gap-0.5" title={`n=${display.n} pairs vs the D-7 baseline`}>
      <span className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: colour }}>
        {display.kind === 'loss' && <span aria-hidden="true">▼</span>}
        {display.label}
        {display.kind === 'loss' && <span className="sr-only"> — worse than the D-7 naive baseline</span>}
      </span>
      {!compact && <span className="text-micro text-ink-faint">n={display.n}</span>}
    </span>
  );
}
