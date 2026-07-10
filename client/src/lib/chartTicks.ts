// Shared axis-tick helper for the able SVG charts.
// Produces round tick values (1/2/2.5/5 × 10ⁿ steps) inside a data domain,
// so axes read 40k/50k/60k instead of 41.3k/49.6k/58.0k.

export function niceTicks(min: number, max: number, target = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min];
  const span = max - min;
  const step0 = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 5 : norm >= 2.5 ? 2.5 : norm >= 2 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-6; v += step) {
    // Snap away float drift (0.30000000000000004 → 0.3)
    ticks.push(Number(v.toPrecision(12)));
  }
  return ticks.length ? ticks : [min];
}

/** Format a MW value for a GW axis: 40000 → "40", 2500 → "2.5". */
export function formatGwAxis(mw: number): string {
  const gw = mw / 1000;
  if (Math.abs(gw) >= 10) return gw.toFixed(0);
  if (Math.abs(gw) >= 1) return gw.toFixed(1).replace(/\.0$/, '');
  return gw.toFixed(1);
}
