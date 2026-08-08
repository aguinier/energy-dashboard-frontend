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
