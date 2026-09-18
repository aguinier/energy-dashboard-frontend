/**
 * The net-position sparkline's geometry.
 *
 * 340 x 128 in the design, with the zero line through the middle and the
 * curve reaching 56px at full scale. Gaps in the series are real — a zone that
 * published nothing at 03:00 must show a break, not a line drawn through zero
 * — so the path is built as separate subpaths rather than one continuous one.
 */

export const SPARK_WIDTH = 340;
export const SPARK_HEIGHT = 128;
/** The vertical middle: the zero line. */
export const SPARK_MID = 64;
/** How far from the middle a full-scale value reaches. */
export const SPARK_REACH = 56;

export interface Sparkline {
  /** One `M…L…` subpath per run of consecutive readings. */
  line: string;
  /** The same runs closed to the zero line, for the area fill. */
  area: string;
  /** Where the hour cursor sits, or null when that hour has no reading. */
  cursor: { x: number; y: number } | null;
  /** The value the scale was built from, in the series' own units. */
  scale: number;
  /** True when nothing in the series could be drawn. */
  empty: boolean;
}

const x = (i: number): number => (i / 23) * SPARK_WIDTH;

/**
 * Build the paths for a 24-slot series.
 *
 * `minScale` keeps a flat day from being drawn as a dramatic one: without a
 * floor, a zone whose net position never leaves ±50 MW would fill the whole
 * chart and read like a crisis.
 */
export function buildSparkline(
  series: (number | null)[],
  hour: number,
  minScale = 1.5,
): Sparkline {
  const values = series.map((v) => (v === null || v === undefined ? null : v));
  const magnitudes = values.filter((v): v is number => v !== null).map(Math.abs);
  if (magnitudes.length === 0) {
    return { line: '', area: '', cursor: null, scale: minScale, empty: true };
  }

  const scale = Math.max(minScale, Math.max(...magnitudes) * 1.25);
  const y = (v: number): number => SPARK_MID - (v / scale) * SPARK_REACH;

  const lineParts: string[] = [];
  const areaParts: string[] = [];
  let run: { i: number; v: number }[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const d = run
      .map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`)
      .join(' ');
    lineParts.push(d);
    // A single-point run has no line to draw but still deserves its column of
    // area, so the closing path is built the same way for both.
    const first = run[0];
    const last = run[run.length - 1];
    areaParts.push(
      `${d} L${x(last.i).toFixed(1)} ${SPARK_MID} L${x(first.i).toFixed(1)} ${SPARK_MID} Z`,
    );
    run = [];
  };

  values.forEach((v, i) => {
    if (v === null) flush();
    else run.push({ i, v });
  });
  flush();

  const at = values[Math.max(0, Math.min(23, hour))];
  return {
    line: lineParts.join(' '),
    area: areaParts.join(' '),
    cursor: at === null || at === undefined ? null : { x: x(hour), y: y(at) },
    scale,
    empty: false,
  };
}
