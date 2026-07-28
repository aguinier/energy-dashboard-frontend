/** Below this many hours the gap is normal publication lag and not worth noting. */
const THRESHOLD_HOURS = 2;

/**
 * Label for the gap between the last actual point and now.
 *
 * ENTSO-E actuals arrive hours late, which drew a line stopping well short of
 * the `now` marker with nothing on the chart explaining why.
 */
export function trailingGapLabel(lastActualIso: string | undefined, now: Date): string | null {
  if (!lastActualIso) return null;
  const t = Date.parse(lastActualIso);
  if (Number.isNaN(t)) return null;

  const hours = Math.floor((now.getTime() - t) / 3_600_000);
  if (hours < THRESHOLD_HOURS) return null;
  return `last actual ${hours}h ago`;
}
