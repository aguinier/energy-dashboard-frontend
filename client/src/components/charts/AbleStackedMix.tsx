import { useState, useMemo } from 'react';
import { chartTimeTicks, niceTicks, formatGwAxis } from '@/lib/chartTicks';
import { divergingStack, stackExtent } from '@/lib/divergingStack';

// Stacked smoothed area for the generation mix by source.
//
// ABL-44 widened this from the four hardcoded renewable families
// (solar/wind/hydro/biomass, read from the frozen `energy_renewable`) to
// whichever families the caller passes, so nuclear and fossil are drawn too
// and the chart describes the same mix as the donut and by-source table on the
// same card. Two consequences, both handled here:
//
//  - **Members can be negative.** Pumped storage is negative while charging and
//    a consumption-only fossil type is negative outright. The stack is a
//    DIVERGING one (`lib/divergingStack.ts`, where that decision is argued):
//    positives go up from the zero baseline, negatives go down from it, and the
//    axis only reaches below zero when something really is negative.
//  - **A member can be absent.** `values[key]` is `number | null`, and null is
//    "not reported", never 0. The caller drops a key that is null throughout
//    (`buildGenerationMixSeries`), so nothing here draws a fabricated band; a
//    null at a single point is a zero-width band and reads `—` in the tooltip
//    rather than a number.

export interface AbleStackedMixPoint {
  ts: string;
  future: boolean;
  /** MW by group key. Null means "not reported", never a measured 0. */
  values: Record<string, number | null>;
}

interface Props {
  series: AbleStackedMixPoint[];
  /** Stack order, bottom of the stack first. Only these keys are drawn. */
  keys: readonly string[];
  labels: Record<string, string>;
  colors: Record<string, string>;
  nowIndex?: number;
  height?: number;
  width?: number;
  /** Tooltip footer label for the signed sum of the drawn keys. */
  totalLabel?: string;
  /** Active time preset, used to choose hour vs. day X-axis labels. */
  preset?: string;
}

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
  keys,
  labels,
  colors,
  nowIndex,
  height = 220,
  width = 680,
  totalLabel = 'Net generation',
  preset,
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

  const { areas, yMin, yMax, zeroY } = useMemo(() => {
    if (series.length === 0 || keys.length === 0) {
      return { areas: [], yMin: 0, yMax: 1, zeroY: padT + ih };
    }

    const extent = stackExtent(series, keys);
    // 10% headroom on whichever ends the domain actually uses. `min` is 0
    // unless something is genuinely negative, so an all-positive series keeps
    // its baseline flat on the axis exactly as before.
    const yMax = Math.max(extent.max * 1.1, 1);
    const yMin = extent.min < 0 ? extent.min * 1.1 : 0;

    const xFor = (i: number) => padL + (i / Math.max(1, series.length - 1)) * iw;
    const yFor = (v: number) => padT + ih - scale(v, yMin, yMax, 0, ih);

    // One diverging stack per point, then transposed into a band per key.
    const tops: Record<string, Array<[number, number]>> = {};
    const bottoms: Record<string, Array<[number, number]>> = {};
    for (const k of keys) {
      tops[k] = [];
      bottoms[k] = [];
    }
    series.forEach((d, i) => {
      for (const band of divergingStack(keys, d.values)) {
        tops[band.key].push([xFor(i), yFor(band.y1)]);
        bottoms[band.key].push([xFor(i), yFor(band.y0)]);
      }
    });

    const areas = keys.map((k) => ({
      k,
      path:
        smoothPath(tops[k]) +
        ' L ' +
        [...bottoms[k]].reverse().map((p) => `${p[0]},${p[1]}`).join(' L ') +
        ' Z',
      color: colors[k],
    }));

    return { areas, yMin, yMax, zeroY: yFor(0) };
  }, [series, keys, colors, padL, ih, iw, padT]);

  const nowX = padL + (NOW / Math.max(1, series.length - 1)) * iw;
  const xTicks = chartTimeTicks(series.map((d) => d.ts), preset, NOW);

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
  // Null contributes nothing; the total is null when nothing was reported at
  // all, so the footer reads "—" instead of a confident 0.
  const hoverTotal = h
    ? keys.reduce<number | null>((acc, k) => {
        const v = h.values[k];
        return v == null ? acc : (acc ?? 0) + v;
      }, null)
    : null;

  if (series.length === 0 || keys.length === 0) {
    return (
      <div className="flex items-center justify-center text-meta text-ink-muted" style={{ height }}>
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
            key={`area-${a.k}`}
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

        {niceTicks(yMin, yMax, 4).map((v, i) => {
          if (v === 0) return null;
          const y = padT + ih - scale(v, yMin, yMax, 0, ih);
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
                {formatGwAxis(v)}
              </text>
            </g>
          );
        })}

        {/*
          The zero baseline. Only drawn when the domain reaches below it — with
          nothing negative it coincides with the bottom of the plot area, where
          a solid rule would just be chart junk. When something IS negative it
          is the reference the whole stack diverges from, so it is drawn darker
          than the gridlines and labelled.
        */}
        {yMin < 0 && (
          <g>
            <line
              x1={padL}
              x2={padL + iw}
              y1={zeroY}
              y2={zeroY}
              stroke="hsl(var(--ink-muted))"
              strokeWidth={1}
              opacity={0.75}
            />
            <text
              x={padL - 8}
              y={zeroY + 3}
              fill="hsl(var(--ink-muted))"
              fontSize="10"
              textAnchor="end"
              fontFamily="'JetBrains Mono', monospace"
            >
              0
            </text>
          </g>
        )}

        <line
          x1={padL}
          x2={padL + iw}
          y1={padT + ih}
          y2={padT + ih}
          stroke="hsl(var(--input))"
          strokeWidth={1}
        />

        {xTicks.map((tick) => {
          const x = padL + (tick.index / Math.max(1, series.length - 1)) * iw;
          return (
            <text
              key={tick.index}
              x={x}
              y={height - 8}
              fill="hsl(var(--ink-muted))"
              fontSize="10"
              textAnchor="middle"
              fontFamily="'JetBrains Mono', monospace"
            >
              {tick.label}
            </text>
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
            {divergingStack(keys, h.values).map((band) =>
              // No marker for a group with nothing to report at this point —
              // a dot on the baseline would read as a measured zero.
              h.values[band.key] == null ? null : (
                <circle
                  key={band.key}
                  cx={hx}
                  cy={padT + ih - scale(band.y1, yMin, yMax, 0, ih)}
                  r={3}
                  fill="hsl(var(--card))"
                  stroke={colors[band.key]}
                  strokeWidth={2}
                />
              ),
            )}
          </g>
        )}
      </svg>

      {h && (
        <div
          className="font-mono-num pointer-events-none absolute min-w-[160px] whitespace-nowrap rounded-md border border-input bg-foreground px-3 py-2.5 text-micro text-background shadow-[0_4px_16px_rgba(0,0,0,0.25)]"
          style={{
            left: `${(hx / width) * 100}%`,
            top: 6,
            transform:
              hover != null && hover > series.length * 0.65
                ? 'translateX(calc(-100% - 14px))'
                : 'translateX(14px)',
          }}
        >
          <div className="mb-1.5 text-micro opacity-60">
            {new Date(h.ts).toLocaleString([], {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </div>
          {keys.map((k) => (
            <div key={k} className="flex items-center gap-2 py-0.5">
              <span className="h-2 w-2 rounded-sm" style={{ background: colors[k] }} />
              <span className="flex-1 opacity-85">{labels[k] ?? k}</span>
              <span className="font-semibold">
                {h.values[k] == null ? '—' : ((h.values[k] as number) / 1000).toFixed(2)}
              </span>
              <span className="text-micro opacity-55">GW</span>
            </div>
          ))}
          <div className="mt-1.5 flex items-baseline justify-between border-t border-input pt-1.5 opacity-90">
            <span className="text-micro opacity-70">{totalLabel}</span>
            <span>
              <span className="font-semibold">
                {hoverTotal == null ? '—' : (hoverTotal / 1000).toFixed(2)}
              </span>
              <span className="ml-1 text-micro opacity-55">GW</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
