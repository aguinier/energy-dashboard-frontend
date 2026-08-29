import type { ResidualPoint } from '@/components/dashboard/residualSeries';

interface Props {
  points: ResidualPoint[];
  height?: number;
  unit?: string;
}

/**
 * A short signed axis beneath a figure: actual − forecast per interval.
 *
 * Hand-drawn SVG rather than Recharts. It shares the parent plot's x-domain by
 * construction (one bar per point, evenly spaced) and has no axes, tooltip or
 * legend of its own — it is an annotation on the figure above it, not a chart.
 * Reaching for Recharts here would buy machinery this does not use.
 */
export function AbleResidualStrip({ points, height = 46, unit = 'MW' }: Props) {
  if (points.length === 0) return null;

  const peak = Math.max(...points.map((p) => Math.abs(p.residual)));
  const zero = height / 2;
  const half = height / 2;
  const step = 100 / points.length;

  return (
    <div className="flex items-center gap-3">
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Forecast residual per interval, peak ${Math.round(peak)} ${unit}`}
      >
        {points.map((p, i) => {
          const h = peak === 0 ? 0 : (half * Math.abs(p.residual)) / peak;
          const over = p.residual > 0;
          return (
            <rect
              key={p.t}
              data-residual={p.residual}
              data-sign={over ? 'over' : 'under'}
              x={i * step}
              y={over ? zero - h : zero}
              width={step * 0.8}
              height={Math.max(h, 0.4)}
              fill={over ? 'hsl(var(--up))' : 'hsl(var(--down))'}
              opacity={0.8}
            />
          );
        })}
        <line x1="0" y1={zero} x2="100" y2={zero} stroke="hsl(var(--border))" strokeWidth="0.4" />
      </svg>
      <span className="whitespace-nowrap font-mono-num text-micro text-ink-muted">
        ±{Math.round(peak).toLocaleString('en-GB')} {unit}
      </span>
    </div>
  );
}
