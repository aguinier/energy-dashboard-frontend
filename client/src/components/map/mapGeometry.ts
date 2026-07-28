// Pure geometry helpers for EuropeMap.tsx, pulled out so the two decisions
// task-11's review flagged as regressions — which viewBox to render, and
// where the hover card sits — can be unit-tested directly. This client is
// vitest-only (no jsdom/RTL), so anything that can be expressed as
// (numbers in) -> (numbers out) belongs here rather than only inline in the
// component.

export const DESKTOP_MIN_WIDTH = 1024;
export const DESKTOP_VIEWBOX = { width: 1000, height: 650, scale: 440 };
// Reference width for the narrow viewBox. The resulting on-screen ink % is
// independent of the absolute number chosen here (only the scale/width
// ratio matters) so this is just a convenient unit; height is derived per
// container from the measured aspect ratio — see `narrowViewBoxHeight`.
export const NARROW_VIEWBOX_WIDTH = 420;
// Empirically tuned (see task-11 report) so Europe's ink — Iceland to
// Turkey, Norway to Malta, all confirmed unclipped — fills ~95% of the
// narrow viewBox width, instead of the ~39% a scaled-down fixed 1000-wide
// viewBox produced on a phone screen.
export const NARROW_SCALE = 305;

/**
 * Review finding 1 (task-11): a width-only gate picked the fixed 1000x650
 * landscape viewBox for any container >=1024px wide, aspect be damned. An
 * iPad Pro 12.9" in portrait is 1024x1366 — it took the "desktop" branch
 * and rendered at 58% width / 43% height ink, the same letterboxing this
 * task exists to eliminate. One pixel narrower (1023x1366) took the narrow
 * branch and hit 95%/72%.
 *
 * Why width>=height (aspect ratio, not a magic ratio constant): with SVG's
 * default `preserveAspectRatio="xMidYMid meet"`, a *landscape* viewBox
 * (1000x650, aspect ~1.54) inside a *portrait* container is always
 * width-bound — no choice of scale fixes that, only a differently-shaped
 * viewBox does. The narrow viewBox is self-matching (its height is derived
 * from the container's own measured aspect every render — see
 * `narrowViewBoxHeight`), so it never letterboxes regardless of container
 * shape. The simplest correct rule is therefore: only use the fixed
 * landscape viewBox when the container is itself landscape-or-square
 * (width >= height); a container taller than it is wide always gets the
 * self-matching narrow viewBox, independent of how many px wide it is.
 *
 * The width gate stays layered on top, because it answers a different
 * question: a landscape *phone* (e.g. 812x375) clears width>=height easily
 * but is still far too small for the monitor-sized desktop scale/viewBox.
 */
export function isDesktopGeometry(containerWidth: number, containerHeight: number): boolean {
  return containerWidth >= DESKTOP_MIN_WIDTH && containerWidth >= containerHeight;
}

/** Narrow viewBox height for a container of the given size — fixed width, height
 * derived from the container's measured aspect so `meet` binds evenly on both
 * axes instead of leaving one letterboxed. */
export function narrowViewBoxHeight(containerWidth: number, containerHeight: number): number {
  if (!(containerWidth > 0)) return NARROW_VIEWBOX_WIDTH;
  return Math.round(NARROW_VIEWBOX_WIDTH * (containerHeight / containerWidth));
}

export interface MapGeometry {
  isDesktop: boolean;
  projectionScale: number;
  mapWidth: number;
  mapHeight: number;
}

/** Given the measured container box and whether this is the full-screen map
 * view or a docked chart card, pick the <ComposableMap> viewBox/scale. */
export function selectMapGeometry(
  containerWidth: number,
  containerHeight: number,
  fullScreen: boolean,
): MapGeometry {
  const isDesktop = isDesktopGeometry(containerWidth, containerHeight);
  if (!fullScreen) {
    return { isDesktop, projectionScale: 260, mapWidth: DESKTOP_VIEWBOX.width, mapHeight: 420 };
  }
  if (isDesktop) {
    return {
      isDesktop,
      projectionScale: DESKTOP_VIEWBOX.scale,
      mapWidth: DESKTOP_VIEWBOX.width,
      mapHeight: DESKTOP_VIEWBOX.height,
    };
  }
  return {
    isDesktop,
    projectionScale: NARROW_SCALE,
    mapWidth: NARROW_VIEWBOX_WIDTH,
    mapHeight: narrowViewBoxHeight(containerWidth, containerHeight),
  };
}

/**
 * Review finding 2 (task-11): the hover card's position was a static
 * `isDesktop ? corner : lower` ternary, so it snapped to the top-right
 * corner (`right-5 top-5`, a >=260px-wide card) the instant the container
 * hit 1024px wide. But the floating MapMetricSelector (rendered by
 * MapView, centered across that same container) is ~578px wide at its
 * current 4-metric content and doesn't clear a corner-anchored card's left
 * edge until the container is roughly 1150px — 1024-1150px is an ordinary
 * non-maximised browser window, not an edge case, and the corner card sat
 * on top of the selector pill there.
 *
 * Rather than hardcode that ~1150px crossover as a second magic-number
 * breakpoint, this derives it from the same box geometry both elements
 * actually use, so it self-corrects if either element's width ever
 * changes:
 *   - the selector is horizontally centered on the container, so its right
 *     edge is `containerWidth/2 + SELECTOR_WIDTH/2`
 *   - the corner card's left edge, if it took the corner, would be
 *     `containerWidth - HOVER_CARD_MARGIN - HOVER_CARD_WIDTH`
 * The corner position is only safe once that left edge would land at or
 * past the selector's right edge, with a little breathing room
 * (HOVER_CARD_GAP) so the two don't sit pixel-adjacent. Below that width,
 * this falls back to the lower position — which sits vertically below the
 * selector's ~41px-tall pill regardless of container width, so it's a safe
 * default at every width, not just narrow ones.
 */
export const SELECTOR_WIDTH = 578; // MapMetricSelector `floating`, 4 metrics, unclamped (measured)
export const HOVER_CARD_WIDTH = 260; // matches the hover card's `min-w-[260px]`
export const HOVER_CARD_MARGIN = 20; // matches the hover card's `right-5` (1.25rem)
export const HOVER_CARD_GAP = 8; // breathing room past bare geometric clearance

export function hoverCardClearsSelector(containerWidth: number): boolean {
  const cardLeftAtCorner = containerWidth - HOVER_CARD_MARGIN - HOVER_CARD_WIDTH;
  const selectorRightEdge = containerWidth / 2 + SELECTOR_WIDTH / 2;
  return cardLeftAtCorner - selectorRightEdge >= HOVER_CARD_GAP;
}
