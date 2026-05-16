// Renewable donut chart — port of Charts.Donut from the able prototype.

interface DonutValue {
  key: string;
  value: number;
  isGreen: boolean;
}

interface Props {
  values: DonutValue[];
  size?: number;
  thickness?: number;
  colors: Record<string, string>;
}

export function AbleDonut({ values, size = 140, thickness = 22, colors }: Props) {
  const total = values.reduce((a, v) => a + v.value, 0) || 1;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - thickness / 2 - 2;
  let a0 = -Math.PI / 2;

  const arcs = values.map((v) => {
    const frac = v.value / total;
    const a1 = a0 + frac * 2 * Math.PI;
    const large = frac > 0.5 ? 1 : 0;
    const x0 = cx + r * Math.cos(a0);
    const y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    const d = `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
    a0 = a1;
    return { d, key: v.key, value: v.value, frac };
  });

  const greenTotal = values.filter((v) => v.isGreen).reduce((a, v) => a + v.value, 0);
  const pct = Math.round((greenTotal / total) * 100);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {arcs.map((a, i) => (
        <path
          key={i}
          d={a.d}
          fill="none"
          stroke={colors[a.key] || 'hsl(var(--ink-faint))'}
          strokeWidth={thickness}
          strokeLinecap="butt"
        />
      ))}
      <text
        x={cx}
        y={cy - 2}
        fill="hsl(var(--foreground))"
        fontSize="22"
        fontWeight={600}
        textAnchor="middle"
        fontFamily="'JetBrains Mono', monospace"
      >
        {pct}%
      </text>
      <text
        x={cx}
        y={cy + 16}
        fill="hsl(var(--ink-muted))"
        fontSize="10"
        textAnchor="middle"
        letterSpacing="0.5"
      >
        RENEWABLE
      </text>
    </svg>
  );
}
