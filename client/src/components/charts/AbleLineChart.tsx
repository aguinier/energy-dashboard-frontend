import { useState, useMemo } from 'react';
import { chartTimeTicks, niceTicks } from '@/lib/chartTicks';
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
  /**
   * Named forecast series, keyed by an id from the chart's `forecastSeries`
   * prop — net position's multi-model picker (ABL-203), which can put several
   * forecast lines on one chart at once. Every other caller (Load, Price,
   * ForecastTab's overlay) leaves this undefined and the chart draws the
   * single `forecast` field above exactly as it always has.
   */
  forecasts?: Record<string, number | null>;
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

/** One named forecast line: which key in `AbleSeriesPoint.forecasts` it reads, its legend label and its stroke colour. */
export interface AbleForecastSeriesSpec {
  id: string;
  label: string;
  color: string;
  /**
   * SVG stroke-dasharray for this line. Defaults to `'4 4'` (the single-line
   * forecast dash every caller used before ABL-204) when omitted — net
   * position's picker (ABL-203) does not set this, so its lines are
   * unaffected. Load/Price's picker (ABL-204) sets a distinct dash per model
   * via `forecastLineTokens.ts`, because models trained on the same data
   * routinely predict near-identical values — the normal case, not an edge
   * case — and a shared dash rhythm hides the far line under the near one.
   */
  dash?: string;
  /**
   * False when this model was explicitly selected but returned zero rows for
   * the current country/window. Defaults to true (drawn normally). A false
   * entry draws no line (there is nothing to draw) but stays IN the legend
   * with a hatched key instead of being silently dropped — the ABL-205
   * "selected but not covered" mark, carrying forward `NoDataHatch`'s
   * semantic that a texture signals absence, never a quiet/low value.
   */
  covered?: boolean;
  /** Shown beside the hatched legend key when `covered` is false, e.g. "Not available in Belgium". */
  coverageNote?: string;
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
  /**
   * When present and non-empty, draws one dashed line per spec — reading
   * `point.forecasts[spec.id]`, in `spec.color` — instead of the single
   * teal `forecast` field, plus a legend naming them. Absent or empty falls
   * back to today's single-forecast behaviour untouched.
   */
  forecastSeries?: AbleForecastSeriesSpec[];
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
  forecastSeries,
}: AbleLineChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const multi = (forecastSeries?.length ?? 0) > 0;

  const padL = 44;
  const padR = 16;
  const padT = 14;
  const padB = 26;
  const iw = width - padL - padR;
  const ih = height - padT - padB;

  const NOW = nowIndex != null
    ? Math.max(0, Math.min(series.length - 1, nowIndex))
    : series.length - 1;

  const { pts, fpts, multiFpts, yMin, yMax, bandPath, bandUpperPath, bandLowerPath } = useMemo(() => {
    if (series.length === 0) {
      return { pts: [], fpts: [], multiFpts: {} as Record<string, Array<[number, number]>>, yMin: 0, yMax: 1, bandPath: '', bandUpperPath: '', bandLowerPath: '' };
    }
    const values = series.flatMap((d) => {
      const xs: number[] = [];
      if (d.value != null) xs.push(d.value);
      if (d.forecast != null) xs.push(d.forecast);
      if (d.min != null) xs.push(d.min);
      if (d.max != null) xs.push(d.max);
      if (d.forecasts) {
        for (const v of Object.values(d.forecasts)) {
          if (v != null) xs.push(v);
        }
      }
      return xs;
    });
    if (values.length === 0) {
      return { pts: [], fpts: [], multiFpts: {} as Record<string, Array<[number, number]>>, yMin: 0, yMax: 1, bandPath: '', bandUpperPath: '', bandLowerPath: '' };
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

    // One point array per named forecast series (net position's multi-model
    // picker). Built unconditionally and cheaply even when `forecastSeries`
    // is empty — every other caller never reads it.
    const multiFpts: Record<string, Array<[number, number]>> = {};
    for (const spec of forecastSeries ?? []) {
      multiFpts[spec.id] = series.map((d, i): [number, number] => {
        const v = d.forecasts?.[spec.id];
        return [xFor(i), v != null ? yFor(v) : NaN];
      });
    }

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

    return { pts, fpts, multiFpts, yMin, yMax, bandPath, bandUpperPath, bandLowerPath };
  }, [series, padL, ih, iw, padT, forecastSeries]);

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
  const multiForecastPaths: Record<string, string> = {};
  if (multi) {
    for (const spec of forecastSeries!) {
      multiForecastPaths[spec.id] = drawPath(multiFpts[spec.id] ?? []);
    }
  }

  const yTicks = niceTicks(yMin, yMax, 4);

  const xTicks = chartTimeTicks(series.map((d) => d.ts), preset, NOW);

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
  // Per-model hover y-positions, for the multi-model marker circles below.
  const hyMulti: Record<string, number> = {};
  if (multi && hover != null) {
    for (const spec of forecastSeries!) {
      const y = multiFpts[spec.id]?.[hover]?.[1];
      if (y != null && Number.isFinite(y)) hyMulti[spec.id] = y;
    }
  }

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

        {xTicks.map((tick) => {
          const x = padL + (tick.index / Math.max(1, series.length - 1)) * iw;
          return (
            <text
              key={tick.index}
              x={x}
              y={height - 8}
              fill={T.inkMuted}
              fontSize="10"
              textAnchor="middle"
              fontFamily="'JetBrains Mono', monospace"
            >
              {tick.label}
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

        {/* Forecast dashed line(s) — one named line per spec when the caller
            passed `forecastSeries` (net position's multi-model picker),
            otherwise the single teal line every other caller has always had. */}
        {multi
          ? forecastSeries!.map((spec) => {
              const d = multiForecastPaths[spec.id];
              if (!d) return null;
              return (
                <g key={spec.id} style={{ opacity: 0, animation: 'chartFadeIn 0.6s ease-out 0.55s forwards' }}>
                  {/* Surface-colour under-stroke: exact overlap between two
                      models on the same training data is normal, not an edge
                      case, and this is what keeps a fully-hidden line's dash
                      rhythm visible through the gaps of whichever line is on
                      top of it (ABL-205). */}
                  <path d={d} fill="none" stroke={T.panel} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
                  <path
                    d={d}
                    fill="none"
                    stroke={spec.color}
                    strokeWidth={2}
                    strokeOpacity={0.9}
                    strokeDasharray={spec.dash ?? '4 4'}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </g>
              );
            })
          : forecastPath && (
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
        {h && (Number.isFinite(hy) || Number.isFinite(hyf) || Object.keys(hyMulti).length > 0) && (
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
            {!multi && (
              <circle
                cx={hx}
                cy={Number.isFinite(hy) ? hy : hyf}
                r={4}
                fill={T.panel}
                stroke={T.primary}
                strokeWidth={2}
              />
            )}
            {multi && Number.isFinite(hy) && (
              <circle cx={hx} cy={hy} r={4} fill={T.panel} stroke={T.primary} strokeWidth={2} />
            )}
            {multi &&
              forecastSeries!.map((spec) => {
                const y = hyMulti[spec.id];
                if (y == null) return null;
                return (
                  <circle key={spec.id} cx={hx} cy={y} r={3.5} fill={T.panel} stroke={spec.color} strokeWidth={2} />
                );
              })}
          </g>
        )}
      </svg>

      {/* Legend — only when several named forecast series are on screen.
          Colour is never the only way to tell them apart: each swatch carries
          its model's label as text right beside it. A `covered: false` entry
          stays in this list rather than being dropped — a selected model with
          no rows for this country/window gets a hatched key and explicit
          text, the same "texture signals absence" rule NoDataHatch uses on
          the choropleth maps (ABL-205). */}
      {multi && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-ink-muted">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: T.primary }} />
            actual
          </span>
          {forecastSeries!.map((spec) => {
            const notCovered = spec.covered === false;
            return (
              <span
                key={spec.id}
                className="flex items-center gap-1.5"
                aria-label={notCovered ? `${spec.label}, selected, ${spec.coverageNote ?? 'not available'}` : undefined}
              >
                {notCovered ? (
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{
                      background: `repeating-linear-gradient(45deg, ${spec.color}, ${spec.color} 1px, transparent 1px, transparent 3px)`,
                    }}
                  />
                ) : (
                  <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: spec.color }} />
                )}
                <span>
                  {spec.label}
                  {notCovered && <span className="text-ink-faint"> — {spec.coverageNote ?? 'not available'}</span>}
                </span>
              </span>
            );
          })}
        </div>
      )}

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
            {multi ? '' : `${h.value != null ? (h.future ? 'published' : 'actual') : 'forecast'} · `}
            {new Date(h.ts).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })}
          </div>
          {/* Per-point provenance — a single forecast series can carry
              several vintages, so the generation time is named per point
              rather than once for the whole series. Only meaningful with one
              forecast series on screen; with several, each is already
              labelled by model below instead. */}
          {!multi && h.value == null && h.forecastDayLabel && (
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
          {multi ? (
            <div className="flex flex-col gap-0.5">
              {h.value != null && (
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: T.primary }} />
                  <span className="opacity-60">actual</span>
                  <span className="font-semibold">
                    {tipFmt(h.value)}
                    {unit && <span className="ml-0.5 opacity-60">{unit}</span>}
                  </span>
                </div>
              )}
              {forecastSeries!.map((spec) => {
                const v = h.forecasts?.[spec.id];
                return (
                  <div key={spec.id} className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: spec.color }} />
                    <span className="opacity-60">{spec.label}</span>
                    <span className="font-semibold">
                      {v != null ? tipFmt(v) : '—'}
                      {v != null && unit && <span className="ml-0.5 opacity-60">{unit}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="font-semibold">
              {tipFmt(h.value ?? h.forecast ?? 0)}
              {unit && <span className="ml-0.5 opacity-60">{unit}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
