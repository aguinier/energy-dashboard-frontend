// Single-model MAPE-by-horizon bar chart — port of Charts.AccuracyBars.

function scale(val: number, dMin: number, dMax: number, rMin: number, rMax: number) {
  if (dMax === dMin) return (rMin + rMax) / 2;
  return rMin + ((val - dMin) / (dMax - dMin)) * (rMax - rMin);
}

interface Datum {
  label: string;
  v: number;
  /** True when the value is estimated rather than measured — drawn hollow. */
  extrapolated?: boolean;
}

interface Props {
  data: Datum[];
  width?: number;
  height?: number;
  accent?: string;
}

export function AbleAccuracyBars({
  data,
  width = 340,
  height = 150,
  accent = 'hsl(var(--primary))',
}: Props) {
  const padL = 32;
  const padR = 8;
  const padT = 12;
  const padB = 24;
  const iw = width - padL - padR;
  const ih = height - padT - padB;
  const mx = (data.length ? Math.max(...data.map((d) => d.v)) : 1) * 1.1;
  const bw = iw / Math.max(1, data.length) - 6;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full">
      {[0.25, 0.5, 0.75, 1].map((f, i) => {
        const y = padT + ih - f * ih;
        return (
          <line
            key={i}
            x1={padL}
            x2={padL + iw}
            y1={y}
            y2={y}
            stroke="hsl(var(--input))"
            strokeWidth={1}
            opacity={0.6}
          />
        );
      })}
      {data.map((d, i) => {
        const x = padL + i * (bw + 6);
        const h = scale(d.v, 0, mx, 0, ih);
        const y = padT + ih - h;
        return (
          <g key={d.label}>
            <rect
              x={x}
              y={y}
              width={bw}
              height={h}
              fill={accent}
              fillOpacity={d.extrapolated ? 0.22 : 0.85}
              stroke={d.extrapolated ? accent : 'none'}
              strokeOpacity={d.extrapolated ? 0.7 : 0}
              strokeWidth={d.extrapolated ? 1 : 0}
              strokeDasharray={d.extrapolated ? '3,2' : 'none'}
              rx={3}
              style={{
                transformOrigin: `${x + bw / 2}px ${padT + ih}px`,
                animation: `chartGrow 0.6s cubic-bezier(0.4, 0, 0.2, 1) ${i * 0.06}s both`,
              }}
            />
            <text
              x={x + bw / 2}
              y={height - 10}
              fill="hsl(var(--ink-muted))"
              fontSize="10"
              textAnchor="middle"
              fontFamily="'JetBrains Mono', monospace"
            >
              {d.label}
            </text>
            <text
              x={x + bw / 2}
              y={y - 4}
              fill="hsl(var(--foreground))"
              fontSize="10"
              textAnchor="middle"
              fontFamily="'JetBrains Mono', monospace"
              fontWeight={600}
              style={{ opacity: 0, animation: `chartFadeIn 0.3s ease-out ${0.5 + i * 0.06}s forwards` }}
            >
              {d.v.toFixed(1)}%
            </text>
          </g>
        );
      })}
    </svg>
  );
}
