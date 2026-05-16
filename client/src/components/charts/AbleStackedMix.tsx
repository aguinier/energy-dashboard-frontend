import { useState, useMemo } from 'react';

// Port of Charts.StackedMix — stacked smoothed area for renewable generation
// by source (solar / wind / hydro / biomass).

export interface AbleStackedMixPoint {
  ts: string;
  future: boolean;
  solar: number;
  wind: number;
  hydro: number;
  biomass: number;
}

interface Props {
  series: AbleStackedMixPoint[];
  nowIndex?: number;
  height?: number;
  width?: number;
  colors?: { solar: string; wind: string; hydro: string; biomass: string };
}

const DEFAULT_COLORS = {
  solar: '#F0B92B',
  wind: '#4D89C9',
  hydro: '#2FA39C',
  biomass: '#73A35F',
};

const KEYS = ['solar', 'wind', 'hydro', 'biomass'] as const;
const LABELS = { solar: 'Solar', wind: 'Wind', hydro: 'Hydro', biomass: 'Biomass' } as const;

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

export function AbleStackedMix({
  series,
  nowIndex,
  height = 220,
  width = 680,
  colors = DEFAULT_COLORS,
}: Props) {
  const [hover, setHover] = useState<number | null>(null);

  const padL = 44;
  const padR = 16;
  const padT = 12;
  const padB = 26;
  const iw = width - padL - padR;
  const ih = height - padT - padB;

  const NOW =
    nowIndex != null
      ? Math.max(0, Math.min(series.length - 1, nowIndex))
      : Math.max(0, series.length - 1);

  const { areas, yMax } = useMemo(() => {
    if (series.length === 0) return { areas: [], yMax: 1 };
    const totals = series.map((d) => KEYS.reduce((a, k) => a + (d[k] || 0), 0));
    const yMax = Math.max(...totals, 1) * 1.1;
    const xFor = (i: number) => padL + (i / Math.max(1, series.length - 1)) * iw;
    const yFor = (v: number) => padT + ih - scale(v, 0, yMax, 0, ih);

    const stacks: Array<Array<[number, number]>> = KEYS.map(() => []);
    series.forEach((d, i) => {
      let acc = 0;
      KEYS.forEach((k, ki) => {
        acc += d[k] || 0;
        stacks[ki].push([xFor(i), yFor(acc)]);
      });
    });

    const areas = KEYS.map((k, ki) => {
      const top = stacks[ki];
      const bottom =
        ki === 0
          ? series.map((_, i): [number, number] => [xFor(i), padT + ih])
          : stacks[ki - 1];
      const path =
        smoothPath(top) +
        ' L ' +
        [...bottom]
          .reverse()
          .map((p) => `${p[0]},${p[1]}`)
          .join(' L ') +
        ' Z';
      return { k, path, color: colors[k] };
    });

    return { areas, yMax };
  }, [series, colors, padL, ih, iw, padT]);

  const nowX = padL + (NOW / Math.max(1, series.length - 1)) * iw;

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (series.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * width;
    const ratio = (x - padL) / iw;
    const idx = Math.max(0, Math.min(series.length - 1, Math.round(ratio * (series.length - 1))));
    setHover(idx);
  };

  const h = hover != null ? series[hover] : null;
  const hx = hover != null ? padL + (hover / Math.max(1, series.length - 1)) * iw : 0;
  const total = h ? KEYS.reduce((a, k) => a + (h[k] || 0), 0) : 0;

  if (series.length === 0) {
    return (
      <div className="flex items-center justify-center text-[12px] text-ink-muted" style={{ height }}>
        No generation data for this window.
      </div>
    );
  }

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block h-auto w-full"
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        {areas.map((a, i) => (
          <path
            key={`area-${i}`}
            d={a.path}
            fill={a.color}
            fillOpacity={0.85}
            style={{ opacity: 0, animation: `chartFadeIn 0.6s ease-out ${i * 0.08}s forwards` }}
          />
        ))}

        <line
          x1={nowX}
          x2={nowX}
          y1={padT}
          y2={padT + ih}
          stroke="hsl(var(--ink-muted))"
          strokeDasharray="2,3"
          strokeWidth={1}
          opacity={0.8}
        />

        {[0.25, 0.5, 0.75, 1].map((f, i) => {
          const y = padT + ih - f * ih;
          const v = yMax * f;
          return (
            <g key={i}>
              <line
                x1={padL}
                x2={padL + iw}
                y1={y}
                y2={y}
                stroke="hsl(var(--input))"
                strokeWidth={1}
                opacity={0.5}
              />
              <text
                x={padL - 8}
                y={y + 3}
                fill="hsl(var(--ink-muted))"
                fontSize="10"
                textAnchor="end"
                fontFamily="'JetBrains Mono', monospace"
              >
                {(v / 1000).toFixed(1) + 'k'}
              </text>
            </g>
          );
        })}

        {h && (
          <g style={{ pointerEvents: 'none' }}>
            <line
              x1={hx}
              x2={hx}
              y1={padT}
              y2={padT + ih}
              stroke="hsl(var(--foreground))"
              strokeWidth={1}
              opacity={0.45}
            />
            {(() => {
              let acc = 0;
              return KEYS.map((k) => {
                acc += h[k] || 0;
                const cy = padT + ih - scale(acc, 0, yMax, 0, ih);
                return (
                  <circle
                    key={k}
                    cx={hx}
                    cy={cy}
                    r={3}
                    fill="hsl(var(--card))"
                    stroke={colors[k]}
                    strokeWidth={2}
                  />
                );
              });
            })()}
          </g>
        )}
      </svg>

      {h && (
        <div
          className="font-mono-num pointer-events-none absolute min-w-[160px] whitespace-nowrap rounded-md border border-input bg-foreground px-3 py-2.5 text-[11px] text-background shadow-[0_4px_16px_rgba(0,0,0,0.25)]"
          style={{
            left: `${(hx / width) * 100}%`,
            top: 6,
            transform:
              hover != null && hover > series.length * 0.65
                ? 'translateX(calc(-100% - 14px))'
                : 'translateX(14px)',
          }}
        >
          <div className="mb-1.5 text-[10px] opacity-60">
            {h.future ? 'forecast' : 'actual'} ·{' '}
            {new Date(h.ts).toLocaleString([], {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </div>
          {KEYS.map((k) => (
            <div key={k} className="flex items-center gap-2 py-0.5">
              <span className="h-2 w-2 rounded-sm" style={{ background: colors[k] }} />
              <span className="flex-1 opacity-85">{LABELS[k]}</span>
              <span className="font-semibold">{((h[k] || 0) / 1000).toFixed(2)}</span>
              <span className="text-[10px] opacity-55">GW</span>
            </div>
          ))}
          <div className="mt-1.5 flex items-baseline justify-between border-t border-input pt-1.5 opacity-90">
            <span className="text-[10px] opacity-70">Total renewable</span>
            <span>
              <span className="font-semibold">{(total / 1000).toFixed(2)}</span>
              <span className="ml-1 text-[10px] opacity-55">GW</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
