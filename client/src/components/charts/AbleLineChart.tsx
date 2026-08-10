import { useState, useMemo } from 'react';
import { niceTicks, timeTicks, HOURLY_PRESETS, MEDIUM_SPAN_HOURS } from '@/lib/chartTicks';
import { trailingGapLabel } from '@/lib/trailingGap';
import { summarizeSeries } from '@/lib/chartSummary';
import { drawableRuns } from '@/lib/seriesSegments';

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
  /**
   * Provenance of the forecast value at this point — which run produced it
   * and how far ahead it was, e.g. net position's D+1/D+2 vintages. Optional:
   * only series that can carry several forecast vintages at once set these.
   */
  forecastGeneratedAt?: string | null;
  forecastDayLabel?: string | null;
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
  /**
   * When true, drops the now marker: the future shading, the "now" rule and
   * pill, and the trailing-gap label. For a chart that is entirely historical
   * (ForecastTab's forecast-vs-actual overlay) those marks describe nothing.
   *
   * It does NOT decide where the forecast line starts — both series always draw
   * wherever they hold a value. It used to do both, which is how the Load,
   * Price and Net position tabs lost every past-dated forecast point (ABL-92).
   */
  overlay?: boolean;
  /** Disable smoothing (Catmull-Rom). */
  smooth?: boolean;
  /** Active time preset (e.g. '24h', '7d') — chooses hour vs. date X-axis labels. */
  preset?: string;
  /**
   * What the series measures, e.g. "Electricity load" — used only to build
   * the screen-reader text summary (summarizeSeries in lib/chartSummary.ts).
   * Falls back to "Value" if omitted; the visible chart is unaffected.
   */
  label?: string;
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
  preset,
  label,
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

  const { pts, fpts, yMin, yMax, bandPath, bandUpperPath, bandLowerPath } = useMemo(() => {
    if (series.length === 0) {
      return { pts: [], fpts: [], yMin: 0, yMax: 1, bandPath: '', bandUpperPath: '', bandLowerPath: '' };
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
      return { pts: [], fpts: [], yMin: 0, yMax: 1, bandPath: '', bandUpperPath: '', bandLowerPath: '' };
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

    // Min/max band (week-ahead, or p10-p90 for net position). Upper/lower
    // edges are drawn separately (dashed) so the band reads as a defined
    // region rather than a flat fill indistinguishable from the card bg.
    let bandPath = '';
    let bandUpperPath = '';
    let bandLowerPath = '';
    const bandPts = series
      .map((d, i) => ({ i, x: xFor(i), min: d.min, max: d.max }))
      .filter((b) => b.min != null && b.max != null);
    if (bandPts.length > 1) {
      const top = bandPts.map((b): [number, number] => [b.x, yFor(b.max as number)]);
      const bottom = bandPts.map((b): [number, number] => [b.x, yFor(b.min as number)]);
      bandUpperPath = straightPath(top);
      bandLowerPath = straightPath(bottom);
      bandPath =
        bandUpperPath +
        ' L ' +
        bottom
          .slice()
          .reverse()
          .map((p) => `${p[0]},${p[1]}`)
          .join(' L ') +
        ' Z';
    }

    return { pts, fpts, yMin, yMax, bandPath, bandUpperPath, bandLowerPath };
  }, [series, padL, ih, iw, padT]);

  // BOTH series draw wherever they hold a value, and neither is truncated at
  // "now".
  //
  // For the actual series that is because day-ahead auction prices are
  // published for the whole next day, so future timestamps can carry real (not
  // forecast) data; truncating at now silently hid tomorrow's coupled prices.
  //
  // For the forecast it is because a stored forecast for a past hour is the
  // only thing on this chart that can be compared against what actually
  // happened. This used to start the dashed line at NOW unless `overlay` was
  // set (ABL-92): measured against the replica on 2026-08-09, FR/load over a 7d
  // window returns 204 forecast points of which 168 are past-dated, so 82% of
  // the served series was discarded at draw time. Because FR's actuals ran ~14h
  // behind, that left a band with neither series on it and no way to read
  // forecast against realised at all. `overlay` still suppresses the now marker
  // and the future shading — it no longer decides which forecast points exist.
  const drawPath = (points: Array<[number, number]>) => {
    // Empty slots are dropped, but only a gap the series' own cadence explains
    // is bridged — a missing sample stays a hole rather than becoming a
    // straight line through hours nothing was published for. See
    // lib/seriesSegments.ts.
    const present: number[] = [];
    for (let i = 0; i < points.length; i++) {
      if (Number.isFinite(points[i][1])) present.push(i);
    }
    return drawableRuns(present)
      .map((run) => {
        const seg = run.map((i) => points[i]);
        // A lone point has no line to draw; emit a zero-length segment so the
        // round linecap renders it as a dot instead of dropping it silently.
        if (seg.length === 1) return `M ${seg[0][0]},${seg[0][1]} L ${seg[0][0]},${seg[0][1]}`;
        return smooth ? smoothPath(seg) : straightPath(seg);
      })
      .filter(Boolean)
      .join(' ');
  };
  const actualPath = drawPath(pts);
  const forecastPath = drawPath(fpts);

  const yTicks = niceTicks(yMin, yMax, 4);

  // Sub-day windows (24h and its siblings) get hour/day+hour ticks from
  // timeTicks — the day-anchored derivation below produces at most one tick
  // when the series itself only spans ~24 hourly points, which is the
  // original bug (24h rendered no x-axis labels at all).
  //
  // Guarded on actual span, not just `preset`: NetPositionTab always extends
  // its fetch window to now+3d regardless of preset (see
  // useNetPositionData.ts), and Load/Price forecast overlays stretch the
  // merged actual+forecast grid further still (see MEDIUM_SPAN_HOURS's doc
  // comment in chartTicks.ts for the measured per-tab spans). Keying off
  // preset alone would put hour-only labels (no day context) across several
  // days, which is ambiguous, not a fix — timeTicks itself picks hour vs.
  // day+hour based on this same span. Only once the span exceeds
  // MEDIUM_SPAN_HOURS does this fall back to the existing day-marker
  // derivation verbatim, so 7d/30d render exactly as before.
  const spanHours =
    series.length > 1
      ? (new Date(series[series.length - 1].ts).getTime() - new Date(series[0].ts).getTime()) /
        3_600_000
      : 0;
  const useHourTicks =
    !!preset && HOURLY_PRESETS.has(preset) && spanHours > 0 && spanHours <= MEDIUM_SPAN_HOURS;

  let visibleXTicks: number[];
  let xLabelFor: (i: number) => string;

  if (useHourTicks) {
    const ticks = timeTicks(series.map((d) => d.ts), preset as string);
    visibleXTicks = ticks.map((t) => t.index);
    const labelByIndex = new Map(ticks.map((t) => [t.index, t.label]));
    xLabelFor = (i: number) => labelByIndex.get(i) ?? '';
  } else {
    // Day-marker X ticks anchored to NOW, thinned so labels never collide.
    const xTicks: number[] = [];
    for (let i = NOW % 24; i < series.length; i += 24) {
      if (i >= 0) xTicks.push(i);
    }
    const xStride = Math.ceil(xTicks.length / 9);
    visibleXTicks =
      xStride > 1
        ? xTicks.filter((i) => i === NOW || Math.round((i - NOW) / 24) % xStride === 0)
        : xTicks;
    // Long windows label as "8 Jul", short ones as weekday "Wed 8".
    const spanDays = series.length / 24;
    xLabelFor = (i: number): string => {
      if (i === NOW) return 'now';
      const d = new Date(series[i].ts);
      if (Number.isNaN(d.getTime())) return '';
      return spanDays > 12
        ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
        : `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${d.getDate()}`;
    };
  }

  const nowX = pts[NOW] ? pts[NOW][0] : padL + iw;

  // ENTSO-E actuals routinely arrive hours late, so the solid line stops
  // well short of the `now` marker. Name the gap instead of leaving it
  // unexplained — the header's freshness note is easy to miss.
  let lastActualIso: string | undefined;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].value != null) {
      lastActualIso = series[i].ts;
      break;
    }
  }
  const gapLabel = trailingGapLabel(lastActualIso, new Date());

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
        className="flex items-center justify-center text-meta text-ink-muted"
        style={{ height }}
      >
        No data in this window — try a longer range like 30d.
      </div>
    );
  }

  const tipFmt = formatTooltip ?? formatAxis;

  // The SVG below carries the visual: a smoothed path plus axis tick text,
  // none of which is annotated with what the data actually is. Rather than
  // trying to make ~700 individual points navigable, this gives a screen
  // reader the same "ranged X–Y, currently Z" framing a sighted user gets by
  // glancing at the chart, and hides the SVG's own (partial, unlabelled)
  // text from the accessibility tree so it doesn't also announce raw axis
  // numbers with no unit or meaning attached.
  const seriesSummary = summarizeSeries(series, NOW, { label, unit, formatValue: tipFmt });

  return (
    <div className="relative w-full">
      <p className="sr-only">{seriesSummary}</p>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block h-auto w-full"
        aria-hidden="true"
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
            <g key={i}>
              <line
                x1={padL}
                x2={padL + iw}
                y1={y}
                y2={y}
                stroke={T.rule}
                strokeWidth={1}
                opacity={0.5}
              />
              <text
                x={padL - 8}
                y={y + 4}
                fill={T.inkMuted}
                fontSize="10"
                textAnchor="end"
                fontFamily="'JetBrains Mono', monospace"
              >
                {formatAxis(v)}
              </text>
            </g>
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

        {visibleXTicks.map((i) => {
          const x = padL + (i / Math.max(1, series.length - 1)) * iw;
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
              {xLabelFor(i)}
            </text>
          );
        })}

        {/* Min/max band (week-ahead, or p10-p90 for net position) */}
        {bandPath && (
          <>
            <path d={bandPath} fill={T.primary} fillOpacity={0.16} />
            <path
              d={bandUpperPath}
              fill="none"
              stroke={T.primary}
              strokeOpacity={0.35}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <path
              d={bandLowerPath}
              fill="none"
              stroke={T.primary}
              strokeOpacity={0.35}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          </>
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

        {/* Actual line — pathLength normalizes the draw-on animation so it
            always covers the full path; a fixed dasharray left anything past
            that many units invisible on long windows. */}
        {actualPath && (
          <path
            d={actualPath}
            fill="none"
            stroke={T.primary}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={1}
            style={{
              strokeDasharray: 1,
              strokeDashoffset: 1,
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

        {/* Trailing gap — ENTSO-E actuals lag, so the solid line stops short
            of `now` with no explanation on the chart itself otherwise. */}
        {!overlay && gapLabel && (
          <text
            x={nowX}
            y={12}
            textAnchor="end"
            className="font-mono-num"
            fontSize={10}
            fill="hsl(var(--muted-foreground))"
          >
            {gapLabel}
          </text>
        )}

        {/* Hover */}
        {h && (Number.isFinite(hy) || Number.isFinite(hyf)) && (
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
              cy={Number.isFinite(hy) ? hy : hyf}
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
          className="font-mono-num pointer-events-none absolute whitespace-nowrap rounded-md border border-input bg-foreground px-2.5 py-1.5 text-micro text-background shadow-[0_4px_12px_rgba(0,0,0,0.25)]"
          style={{
            left: `${(hx / width) * 100}%`,
            top: 4,
            transform: 'translateX(-50%)',
          }}
        >
          <div className="mb-0.5 text-micro opacity-60">
            {h.value != null ? (h.future ? 'published' : 'actual') : 'forecast'} ·{' '}
            {new Date(h.ts).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })}
          </div>
          {/* Per-point provenance — several forecast vintages can be on
              screen at once, so the generation time is named per point
              rather than once for the whole series. */}
          {h.value == null && h.forecastDayLabel && (
            <div className="mb-0.5 text-micro opacity-60">
              {h.forecastDayLabel}
              {h.forecastGeneratedAt &&
                ` · run ${new Date(h.forecastGeneratedAt).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}`}
            </div>
          )}
          <div className="font-semibold">
            {tipFmt(h.value ?? h.forecast ?? 0)}
            {unit && <span className="ml-0.5 opacity-60">{unit}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
