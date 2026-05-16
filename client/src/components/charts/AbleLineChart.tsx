import { useState, useMemo } from 'react';

// Typed port of the able prototype's <LineChart>. Single-series chart with
// optional dashed forecast overlay, future-region shading, "now" pill marker
// and an optional min/max band for week-ahead displays.

export interface AbleSeriesPoint {
  /** ISO timestamp the data point belongs to. */
  ts: string;
  /** Whether this point is in the future of `nowIndex`. */
  future: boolean;
  /** Actual value at this point. null = no measurement. */
  value: number | null;
  /** Forecast value at this point. null = no forecast. */
  forecast: number | null;
  /** Optional min/max band, used for ENTSO-E week-ahead daily bands. */
  min?: number | null;
  max?: number | null;
}

export interface AbleLineChartProps {
  series: AbleSeriesPoint[];
  /** Index that splits past/future. Falls back to last point if omitted. */
  nowIndex?: number;
  height?: number;
  width?: number;
  /** Format a value for axis labels. */
  formatAxis?: (v: number) => string;
  /** Format a value for the hover tooltip. */
  formatTooltip?: (v: number) => string;
  /** Unit string shown under the tooltip value. */
  unit?: string;
  /** When true, draws actual + forecast across the full window (no future split). */
  overlay?: boolean;
  /** Disable smoothing (Catmull-Rom). */
  smooth?: boolean;
}

const T = {
  ink: 'hsl(var(--foreground))',
  inkMuted: 'hsl(var(--ink-muted))',
  inkFaint: 'hsl(var(--ink-faint))',
  primary: 'hsl(var(--primary))',
  panel: 'hsl(var(--card))',
  rule: 'hsl(var(--input))',
  bg: 'hsl(var(--background))',
};

function scale(val: number, dMin: number, dMax: number, rMin: number, rMax: number): number {
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

function straightPath(points: Array<[number, number]>): string {
  if (points.length === 0) return '';
  return points.map((p, i) => (i ? 'L' : 'M') + p[0] + ',' + p[1]).join(' ');
}

function defaultAxisFmt(v: number): string {
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + 'k';
  return v.toFixed(0);
}

export function AbleLineChart({
  series,
  nowIndex,
  height = 300,
  width = 680,
  formatAxis = defaultAxisFmt,
  formatTooltip,
  unit = '',
  overlay = false,
  smooth = true,
}: AbleLineChartProps) {
  const [hover, setHover] = useState<number | null>(null);

  const padL = 44;
  const padR = 16;
  const padT = 14;
  const padB = 26;
  const iw = width - padL - padR;
  const ih = height - padT - padB;

  const NOW = nowIndex != null
    ? Math.max(0, Math.min(series.length - 1, nowIndex))
    : series.length - 1;

  const { pts, fpts, yMin, yMax, bandPath } = useMemo(() => {
    if (series.length === 0) {
      return { pts: [], fpts: [], yMin: 0, yMax: 1, bandPath: '' };
    }
    const values = series.flatMap((d) => {
      const xs: number[] = [];
      if (d.value != null) xs.push(d.value);
      if (d.forecast != null) xs.push(d.forecast);
      if (d.min != null) xs.push(d.min);
      if (d.max != null) xs.push(d.max);
      return xs;
    });
    if (values.length === 0) {
      return { pts: [], fpts: [], yMin: 0, yMax: 1, bandPath: '' };
    }
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const yMin = rawMin * (rawMin >= 0 ? 0.92 : 1.08);
    const yMax = rawMax * (rawMax >= 0 ? 1.06 : 0.94);

    const xFor = (i: number) =>
      padL + (i / Math.max(1, series.length - 1)) * iw;
    const yFor = (v: number) => padT + ih - scale(v, yMin, yMax, 0, ih);

    const pts = series.map((d, i): [number, number] => [
      xFor(i),
      d.value != null ? yFor(d.value) : NaN,
    ]);
    const fpts = series.map((d, i): [number, number] => [
      xFor(i),
      d.forecast != null ? yFor(d.forecast) : NaN,
    ]);

    // Min/max band (week-ahead)
    let bandPath = '';
    const bandPts = series
      .map((d, i) => ({ i, x: xFor(i), min: d.min, max: d.max }))
      .filter((b) => b.min != null && b.max != null);
    if (bandPts.length > 1) {
      const top = bandPts.map((b): [number, number] => [b.x, yFor(b.max as number)]);
      const bottom = bandPts.map((b): [number, number] => [b.x, yFor(b.min as number)]);
      bandPath =
        straightPath(top) +
        ' L ' +
        bottom
          .slice()
          .reverse()
          .map((p) => `${p[0]},${p[1]}`)
          .join(' L ') +
        ' Z';
    }

    return { pts, fpts, yMin, yMax, bandPath };
  }, [series, padL, ih, iw, padT]);

  // Split into past (solid) / future (dashed) — but in overlay mode draw both fully.
  const splitAt = overlay ? series.length : Math.min(NOW + 1, series.length);
  const fStart = overlay ? 0 : Math.min(NOW, series.length - 1);

  // Filter out null y-values, keep the line continuous across small gaps.
  const compact = (slice: Array<[number, number]>) =>
    slice.filter((p) => Number.isFinite(p[1]));
  const actualPath = (() => {
    const c = compact(pts.slice(0, splitAt));
    return smooth ? smoothPath(c) : straightPath(c);
  })();
  const forecastPath = (() => {
    const c = compact(fpts.slice(fStart));
    return smooth ? smoothPath(c) : straightPath(c);
  })();

  const yTicks: number[] = [];
  for (let i = 0; i <= 4; i++) {
    yTicks.push(yMin + ((yMax - yMin) * i) / 4);
  }

  // Day-marker X ticks anchored to NOW.
  const xTicks: number[] = [];
  for (let i = NOW % 24; i < series.length; i += 24) {
    if (i >= 0) xTicks.push(i);
  }

  const nowX = pts[NOW] ? pts[NOW][0] : padL + iw;

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (series.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * width;
    const ratio = (x - padL) / iw;
    const idx = Math.max(0, Math.min(series.length - 1, Math.round(ratio * (series.length - 1))));
    setHover(idx);
  };

  const h = hover != null ? series[hover] : null;
  const hx = hover != null && pts[hover] ? pts[hover][0] : 0;
  const hy = hover != null && pts[hover] ? pts[hover][1] : 0;
  const hyf = hover != null && fpts[hover] ? fpts[hover][1] : 0;

  if (series.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-[12px] text-ink-muted"
        style={{ height }}
      >
        No data for this window.
      </div>
    );
  }

  const tipFmt = formatTooltip ?? formatAxis;

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block h-auto w-full"
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="ablechart-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={T.primary} stopOpacity={0.18} />
            <stop offset="100%" stopColor={T.primary} stopOpacity={0} />
          </linearGradient>
        </defs>

        {!overlay && (
          <rect
            x={nowX}
            y={padT}
            width={padL + iw - nowX}
            height={ih}
            fill={T.rule}
            fillOpacity={0.45}
          />
        )}

        {yTicks.map((v, i) => {
          const y = padT + ih - scale(v, yMin, yMax, 0, ih);
          return (
            <text
              key={i}
              x={padL - 8}
              y={y + 4}
              fill={T.inkMuted}
              fontSize="10"
              textAnchor="end"
              fontFamily="'JetBrains Mono', monospace"
            >
              {formatAxis(v)}
            </text>
          );
        })}

        <line
          x1={padL}
          x2={padL + iw}
          y1={padT + ih}
          y2={padT + ih}
          stroke={T.rule}
          strokeWidth={1}
        />

        {xTicks.map((i) => {
          const x = padL + (i / Math.max(1, series.length - 1)) * iw;
          const dayOffset = Math.round((i - NOW) / 24);
          const label =
            i === NOW ? 'now' : dayOffset > 0 ? `+${dayOffset}d` : `${dayOffset}d`;
          return (
            <text
              key={i}
              x={x}
              y={height - 8}
              fill={T.inkMuted}
              fontSize="10"
              textAnchor="middle"
              fontFamily="'JetBrains Mono', monospace"
            >
              {label}
            </text>
          );
        })}

        {/* Min/max band (week-ahead) */}
        {bandPath && (
          <path d={bandPath} fill={T.primary} fillOpacity={0.10} />
        )}

        {/* Forecast dashed line */}
        {forecastPath && (
          <path
            d={forecastPath}
            fill="none"
            stroke={T.primary}
            strokeWidth={1.5}
            strokeOpacity={0.45}
            strokeDasharray="4,4"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ opacity: 0, animation: 'chartFadeIn 0.6s ease-out 0.55s forwards' }}
          />
        )}

        {/* Now line */}
        {!overlay && (
          <line
            x1={nowX}
            x2={nowX}
            y1={padT + 4}
            y2={padT + ih}
            stroke={T.primary}
            strokeOpacity={0.4}
            strokeDasharray="2,3"
            strokeWidth={1}
          />
        )}

        {/* Actual line */}
        {actualPath && (
          <path
            d={actualPath}
            fill="none"
            stroke={T.primary}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              strokeDasharray: 2400,
              strokeDashoffset: 2400,
              animation: 'chartDraw 0.9s cubic-bezier(0.4, 0, 0.2, 1) forwards',
            }}
          />
        )}

        {/* Now pill */}
        {!overlay && (
          <g
            style={{
              pointerEvents: 'none',
              opacity: 0,
              animation: 'chartFadeIn 0.4s ease-out 0.7s forwards',
            }}
          >
            <rect x={nowX - 14} y={padT - 1} width="28" height="14" rx="7" fill={T.primary} />
            <text
              x={nowX}
              y={padT + 9}
              fill={T.bg}
              fontSize="9"
              fontWeight={600}
              textAnchor="middle"
              fontFamily="'JetBrains Mono', monospace"
              letterSpacing="0.05em"
            >
              now
            </text>
          </g>
        )}

        {/* Hover */}
        {h && Number.isFinite(hy) && (
          <g>
            <line
              x1={hx}
              x2={hx}
              y1={padT}
              y2={padT + ih}
              stroke={T.inkMuted}
              strokeWidth={1}
              opacity={0.4}
            />
            <circle
              cx={hx}
              cy={h.future && Number.isFinite(hyf) ? hyf : hy}
              r={4}
              fill={T.panel}
              stroke={T.primary}
              strokeWidth={2}
            />
          </g>
        )}
      </svg>

      {h && (
        <div
          className="font-mono-num pointer-events-none absolute whitespace-nowrap rounded-md border border-input bg-foreground px-2.5 py-1.5 text-[11px] text-background shadow-[0_4px_12px_rgba(0,0,0,0.25)]"
          style={{
            left: `${(hx / width) * 100}%`,
            top: 4,
            transform: 'translateX(-50%)',
          }}
        >
          <div className="mb-0.5 text-[10px] opacity-60">
            {h.future ? 'forecast' : 'actual'} · {new Date(h.ts).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })}
          </div>
          <div className="font-semibold">
            {tipFmt(h.future ? h.forecast ?? 0 : h.value ?? 0)}
            {unit && <span className="ml-0.5 opacity-60">{unit}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
