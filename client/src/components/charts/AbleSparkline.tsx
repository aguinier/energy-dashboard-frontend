// Tiny inline sparkline — port of Charts.Sparkline from the able prototype.

function scale(val: number, dMin: number, dMax: number, rMin: number, rMax: number) {
  if (dMax === dMin) return (rMin + rMax) / 2;
  return rMin + ((val - dMin) / (dMax - dMin)) * (rMax - rMin);
}

function smoothPath(points: Array<[number, number]>): string {
  if (points.length < 2) return '';
  const p = points;
  let d = `M ${p[0][0]},${p[0][1]}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] || p[i];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[i + 2] || p2;
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}

interface Props {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: string;
}

export function AbleSparkline({
  values,
  width = 70,
  height = 22,
  color = 'hsl(var(--muted-foreground))',
  fill,
}: Props) {
  const cleaned = values.filter((v) => Number.isFinite(v));
  if (cleaned.length < 2) return null;
  const mn = Math.min(...cleaned);
  const mx = Math.max(...cleaned);
  const pts = cleaned.map((v, i): [number, number] => [
    (i / (cleaned.length - 1)) * width,
    height - scale(v, mn, mx, 2, height - 2),
  ]);
  const d = smoothPath(pts);
  const area = d ? `${d} L ${width},${height} L 0,${height} Z` : '';
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {fill && area && <path d={area} fill={fill} />}
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
