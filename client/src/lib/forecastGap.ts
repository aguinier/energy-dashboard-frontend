/**
 * Why a forecast overlay is drawing nothing.
 *
 * A blank overlay used to be indistinguishable from a broken page. The picker
 * pins a model, the server honours the pin strictly — `resolveModelCandidates`
 * returns `[explicit]` or nothing, never a substitute — and the dashed line
 * just disappears. catboost and xgboost cover near-disjoint country sets, so
 * this is the normal consequence of pinning, not an edge case.
 *
 * Naming the cause is the difference between a gap the user can act on and one
 * that looks like a bug. It also stays inside what we actually know: the
 * request named a model and a window, and came back with no points. It does
 * not claim the country has no forecast at all.
 *
 * Pure so it can be tested without a chart — the tabs pass in what their
 * queries returned and render whatever comes back.
 */

export interface ForecastGapInput {
  /** Overlay is switched on and expected to draw. False = nothing to explain. */
  active: boolean;
  /**
   * Label of the model the user pinned, or null when unpinned (the server
   * walked its candidate ladder). A pin is the only cause the user can clear.
   */
  pinnedLabel: string | null;
  /** Forecast request still in flight — not a gap yet. */
  isLoading: boolean;
  /** Forecast request failed — that is an error state, not an empty one. */
  isError: boolean;
  /** Forecast points the response carried for this window. */
  pointCount: number;
  /** Country to name in the copy — display name, falling back to the code. */
  countryLabel: string;
}

export interface ForecastGap {
  message: string;
  /** A pin caused it, so dropping the pin is a real way out. */
  clearable: boolean;
}

export function describeForecastGap(input: ForecastGapInput): ForecastGap | null {
  const { active, pinnedLabel, isLoading, isError, pointCount, countryLabel } = input;

  if (!active || isLoading || isError) return null;
  if (pointCount > 0) return null;

  if (pinnedLabel) {
    return {
      message: `${pinnedLabel} has no forecast for ${countryLabel} in this window.`,
      clearable: true,
    };
  }

  // Unpinned and still empty: the ladder already tried every registered model.
  // Nothing for the user to undo, so say so and offer no action.
  return {
    message: `No forecast published for ${countryLabel} in this window.`,
    clearable: false,
  };
}

/** One explicitly-checked model that came back with no rows, for the multi-select footnote list below. */
export interface SelectionGapEntry {
  id: string;
  label: string;
  color: string;
  isLoading: boolean;
  isError: boolean;
  pointCount: number;
}

export interface SelectionGap {
  id: string;
  color: string;
  message: string;
}

/**
 * Per-model counterpart of `describeForecastGap`, for Load/Price's multi-model
 * picker (ABL-204). Every registered model can be checked alongside any other,
 * and catboost/xgboost cover near-disjoint country sets — so "some of the
 * checked models have nothing here" is the ordinary outcome of checking two
 * boxes, not an edge case. One gap can no longer be described as "the" pin,
 * so this returns one entry per empty model instead of at most one message.
 *
 * Reuses `describeForecastGap`'s exact wording for the same reason that
 * function exists: naming the cause in the same voice everywhere it appears
 * is what keeps a gap reading as expected behaviour rather than a bug report.
 * Every entry here is by construction an explicit selection (there is no
 * "unpinned" case in a checked list — that is what an empty selection reads
 * as "Default" instead), so the message is always the pinned form.
 */
export function describeForecastGapsForSelection(
  entries: SelectionGapEntry[],
  countryLabel: string,
): SelectionGap[] {
  const gaps: SelectionGap[] = [];
  for (const entry of entries) {
    if (entry.isLoading || entry.isError) continue;
    if (entry.pointCount > 0) continue;
    gaps.push({
      id: entry.id,
      color: entry.color,
      message: `${entry.label} has no forecast for ${countryLabel} in this window.`,
    });
  }
  return gaps;
}
