import type { SkillVsSeasonalNaive } from '@/types';

/**
 * What to render beside a WAPE for its skill vs the D-7 seasonal-naive
 * baseline (ABL-186). A pure mapping so the three render states — measured,
 * a loss, insufficient data — can be pinned without a DOM.
 */
export type SkillDisplay =
  | { kind: 'insufficient'; n: number }
  | { kind: 'win'; n: number; skillPct: number; label: string }
  | { kind: 'loss'; n: number; skillPct: number; label: string };

/**
 * `entry.skillVsSeasonalNaive` is optional on the wire type only so older
 * hand-built test fixtures keep compiling — a real API response always
 * carries it. Missing or `skillPct: null` (no baseline pairs, or the
 * baseline's own WAPE was 0/undefined) both read as insufficient data, never
 * as a coerced 0.
 */
export function describeSkill(skill: SkillVsSeasonalNaive | undefined | null): SkillDisplay {
  if (!skill || skill.skillPct === null) {
    return { kind: 'insufficient', n: skill?.n ?? 0 };
  }
  const label = formatSkillPct(skill.skillPct);
  return skill.skillPct < 0
    ? { kind: 'loss', n: skill.n, skillPct: skill.skillPct, label }
    : { kind: 'win', n: skill.n, skillPct: skill.skillPct, label };
}

/** `+23.4%` / `-500.0%` / `0.0%` — the sign is never left implicit. */
export function formatSkillPct(skillPct: number): string {
  const sign = skillPct > 0 ? '+' : '';
  return `${sign}${skillPct.toFixed(1)}%`;
}
