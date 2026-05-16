// 7d × 24h heatmap — port of Charts.PriceHeatmap from the able prototype.
// Caller provides a series already aligned to 7×24 = 168 hourly cells.

export interface AbleHeatmapPoint {
  ts: string;
  value: number | null;
  future: boolean;
}

interface Props {
  /** Up to 168 cells (7 days × 24 hours), in chronological order. Today's row
   *  is the 5th (index 4) so we get 4 days past + today + 2 days future. */
  cells: AbleHeatmapPoint[];
  height?: number;
  width?: number;
  accent?: string;
  unit?: string;
}

const DAY_LABELS = ['−4d', '−3d', '−2d', 'Yest', 'Today', '+1d', '+2d'];

export function AblePriceHeatmap({
  cells,
  height = 180,
  width = 680,
  accent = 'hsl(var(--primary))',
}: Props) {
  if (cells.length === 0) {
    return (
      <div className="flex items-center justify-center text-[12px] text-ink-muted" style={{ height }}>
        No data for this window.
      </div>
    );
  }

  const days = 7;
  const hrs = 24;
  const cw = (width - 40) / hrs;
  const ch = (height - 20) / days;

  const allValues = cells
    .map((c) => c.value)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const mn = allValues.length ? Math.min(...allValues) : 0;
  const mx = allValues.length ? Math.max(...allValues) : 1;
  const range = mx - mn || 1;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full">
      {cells.map((cell, idx) => {
        const d = Math.floor(idx / hrs);
        const h = idx % hrs;
        if (d >= days) return null;
        const future = cell.future;
        const v = cell.value;
        const t = v != null ? (v - mn) / range : 0;
        const fillOpacity = v != null ? 0.10 + t * 0.80 : 0;
        return (
          <rect
            key={idx}
            x={40 + h * cw}
            y={d * ch}
            width={cw - 1}
            height={ch - 1}
            fill={accent}
            fillOpacity={fillOpacity}
            stroke={future ? accent : 'none'}
            strokeOpacity={future ? 0.25 : 0}
            strokeDasharray={future ? '1,1' : 'none'}
            rx={2}
            style={{
              opacity: 0,
              transformOrigin: `${40 + h * cw + cw / 2}px ${d * ch + ch / 2}px`,
              animation: `heatmapPop 0.45s cubic-bezier(0.4, 0, 0.2, 1) ${(d * 24 + h) * 0.004}s forwards`,
            }}
          />
        );
      })}
      {DAY_LABELS.map((l, d) => (
        <text
          key={d}
          x={34}
          y={d * ch + ch / 2 + 3}
          fill={d === 4 ? 'hsl(var(--foreground))' : 'hsl(var(--ink-muted))'}
          fontSize="9.5"
          textAnchor="end"
          fontWeight={d === 4 ? 600 : 400}
          fontFamily="'JetBrains Mono', monospace"
        >
          {l}
        </text>
      ))}
      {[0, 6, 12, 18].map((h) => (
        <text
          key={h}
          x={40 + h * cw + cw / 2}
          y={days * ch + 14}
          fill="hsl(var(--ink-muted))"
          fontSize="9"
          textAnchor="middle"
          fontFamily="'JetBrains Mono', monospace"
        >
          {String(h).padStart(2, '0')}:00
        </text>
      ))}
    </svg>
  );
}
