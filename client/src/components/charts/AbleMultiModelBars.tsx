// Grouped multi-model comparison bars — port of MultiModelBars from app.jsx.

interface ModelSeries {
  id: string;
  name: string;
  version: string;
  mape: number;
  color: string;
  bars: Array<{ label: string; v: number }>;
}

interface Props {
  series: ModelSeries[];
  width?: number;
  height?: number;
}

export function AbleMultiModelBars({ series, width = 680, height = 200 }: Props) {
  if (!series.length) {
    return (
      <div className="py-7 text-center text-[12px] text-ink-muted">
        Select at least one model.
      </div>
    );
  }
  const horizons = series[0].bars.map((b) => b.label);
  const mx = Math.max(...series.flatMap((s) => s.bars.map((b) => b.v))) * 1.1 || 1;
  const padL = 36;
  const padR = 12;
  const padT = 12;
  const padB = 26;
  const iw = width - padL - padR;
  const ih = height - padT - padB;
  const groupW = iw / Math.max(1, horizons.length);
  const barW = Math.max(2, (groupW - 16) / series.length);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full">
      {[0.25, 0.5, 0.75, 1].map((f, i) => {
        const y = padT + ih - f * ih;
        return (
          <g key={i}>
            <line
              x1={padL}
              x2={padL + iw}
              y1={y}
              y2={y}
              stroke="hsl(var(--input))"
              strokeWidth={1}
            />
            <text
              x={padL - 6}
              y={y + 3}
              fill="hsl(var(--ink-muted))"
              fontSize="9.5"
              textAnchor="end"
              fontFamily="'JetBrains Mono', monospace"
            >
              {(f * mx).toFixed(1)}%
            </text>
          </g>
        );
      })}
      {horizons.map((label, gi) => {
        const gx = padL + gi * groupW + 8;
        return (
          <g key={label}>
            <text
              x={gx + (groupW - 16) / 2}
              y={height - 8}
              fill="hsl(var(--ink-muted))"
              fontSize="10"
              textAnchor="middle"
              fontFamily="'JetBrains Mono', monospace"
            >
              {label}
            </text>
            {series.map((s, si) => {
              const x = gx + si * barW;
              const v = s.bars[gi]?.v ?? 0;
              const h = (v / mx) * ih;
              const y = padT + ih - h;
              return (
                <rect
                  key={s.id}
                  x={x}
                  y={y}
                  width={Math.max(1, barW - 2)}
                  height={h}
                  fill={s.color}
                  fillOpacity={0.85}
                  rx={2}
                  style={{
                    transformOrigin: `${x + barW / 2}px ${padT + ih}px`,
                    animation: `chartGrow 0.5s cubic-bezier(0.4, 0, 0.2, 1) ${(gi * series.length + si) * 0.04}s both`,
                  }}
                />
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}
