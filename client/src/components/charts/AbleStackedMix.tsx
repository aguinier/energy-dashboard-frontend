import { useId, useState, useMemo } from 'react';
import { chartTimeTicks, niceTicks, formatGwAxis } from '@/lib/chartTicks';
import { divergingStack, stackExtent } from '@/lib/divergingStack';
import { computeGroupGaps } from '@/lib/stackedMixGaps';
import { NoDataHatchPattern, noDataHatchUrl } from '@/components/map/NoDataHatch';

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
//    (`buildGenerationMixSeries`), so nothing here draws a fabricated band. A
//    hole *inside* an otherwise-reporting group (`lib/stackedMixGaps.ts`) is
//    NOT bridged with a drawn line either — `divergingStack`'s zero-width band
//    at that index is used only to keep the baseline correct for the OTHER
//    groups stacked around it, never to paint this group's own area across
//    it. The area path breaks into one segment per run of reported points,
//    and a hatched marker (`components/map/NoDataHatch.tsx`) covers the gap,
//    so a missing hour reads as "not reported" rather than as a measured dip
//    to zero. It still reads `—` in the tooltip.

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

const LABEL_FONT_SIZE = 10;
const LABEL_SWATCH_WIDTH = 12;
const LABEL_GUTTER = 6; // px between the plot's right edge and a label's swatch
const LABEL_TEXT_GAP = 5; // px between a label's swatch and its text
// A band's own last-reported height must clear this before it gets a label
// at all, and two labels must clear it from each other - both roughly one
// line of LABEL_FONT_SIZE text plus a hair of breathing room. Below either
// threshold the label is dropped rather than forced: the hover tooltip
// already lists every drawn group by name and colour regardless, so a
// dropped label does not make that band unidentifiable, only un-annotated
// at rest.
const LABEL_MIN_BAND_HEIGHT = 12;
const LABEL_MIN_VERTICAL_GAP = 13;

// No canvas to measure real glyph widths against (this chart is hand-built
// SVG, not a text-layout engine) - an average-char-width estimate is close
// enough to size the right margin so the longest visible label doesn't clip.
function estimateLabelWidth(text: string): number {
  return text.length * LABEL_FONT_SIZE * 0.56;
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
  const hatchId = `stacked-mix-gap-${useId()}`;

  const padL = 44;
  // Wide enough for the longest visible band label plus its swatch, since
  // labels now render directly beside each band's end rather than in a
  // legend below the chart (see the label block near the bottom of this
  // component). Keys with no label recorded fall back to the raw key so the
  // margin is never sized against an empty string.
  const padR = Math.max(
    16,
    Math.ceil(
      keys.reduce((m, k) => Math.max(m, estimateLabelWidth(labels[k] ?? k)), 0),
    ) + LABEL_GUTTER + LABEL_SWATCH_WIDTH + LABEL_TEXT_GAP,
  );
  const padT = 12;
  const padB = 26;
  const iw = width - padL - padR;
  const ih = height - padT - padB;

  const NOW =
    nowIndex != null
      ? Math.max(0, Math.min(series.length - 1, nowIndex))
      : Math.max(0, series.length - 1);

  // Same formula the big memo below uses for its own (memoized) `xFor` — kept
  // as a second, cheap copy here rather than hoisted out of that memo, so the
  // memo's dependency list does not have to name a freshly-allocated function
  // on every render.
  const xForIndex = (i: number) => padL + (i / Math.max(1, series.length - 1)) * iw;

  const gaps = useMemo(() => computeGroupGaps(series, keys), [series, keys]);

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
    // `divergingStack` is called for every point regardless of whether `key`
    // is reported there — a null member still needs its zero-width band to
    // keep the OTHER members' baselines correct — but a point is only pushed
    // into that key's own top/bottom run when it actually reported a value.
    // Runs are kept separate (not one flat array per key) precisely so a run
    // boundary — a reported point followed by an unreported one — breaks the
    // path instead of the smoothing curve bridging straight across the hole.
    const topRuns: Record<string, Array<Array<[number, number]>>> = {};
    const bottomRuns: Record<string, Array<Array<[number, number]>>> = {};
    const lastIndex: Record<string, number> = {};
    for (const k of keys) {
      topRuns[k] = [];
      bottomRuns[k] = [];
      lastIndex[k] = -2; // never adjacent to index 0
    }
    series.forEach((d, i) => {
      for (const band of divergingStack(keys, d.values)) {
        if (d.values[band.key] == null) continue;
        const top: [number, number] = [xFor(i), yFor(band.y1)];
        const bottom: [number, number] = [xFor(i), yFor(band.y0)];
        if (lastIndex[band.key] === i - 1) {
          topRuns[band.key][topRuns[band.key].length - 1].push(top);
          bottomRuns[band.key][bottomRuns[band.key].length - 1].push(bottom);
        } else {
          topRuns[band.key].push([top]);
          bottomRuns[band.key].push([bottom]);
        }
        lastIndex[band.key] = i;
      }
    });

    const areas = keys.flatMap((k) =>
      topRuns[k]
        .map((run, runIndex) => ({ run, bottomRun: bottomRuns[k][runIndex], runIndex }))
        // A single reported point has no line to fill an area with — same
        // "nothing to draw" rule `AbleLineChart`'s `drawPath` applies to a
        // lone point, just without that chart's zero-length dot: a filled
        // area needs at least two x-positions to have a width at all.
        .filter(({ run }) => run.length >= 2)
        .map(({ run, bottomRun, runIndex }) => ({
          k,
          runIndex,
          path:
            smoothPath(run) +
            ' L ' +
            [...bottomRun].reverse().map((p) => `${p[0]},${p[1]}`).join(' L ') +
            ' Z',
          color: colors[k],
        })),
    );

    return { areas, yMin, yMax, zeroY: yFor(0) };
  }, [series, keys, colors, padL, ih, iw, padT]);

  /**
   * Direct band labels — one per group, at the right end of its own band,
   * replacing the swatch-row legend GenerationTab used to render below the
   * chart. Anchored at each key's own *last reported* index rather than a
   * shared right edge: a group with a trailing gap (unpublished latest hour)
   * or one that stopped reporting mid-window gets its label where its real
   * line actually ends, not floated past it.
   *
   * Two things suppress a label rather than force it: a band shorter than
   * `LABEL_MIN_BAND_HEIGHT` at that point (nothing to visually attach a line
   * of text to), and a label that would land within `LABEL_MIN_VERTICAL_GAP`
   * of one already kept (processed bottom-of-stack first, i.e. in `keys`
   * order, so a collision drops the higher band's label rather than the
   * lower one's). Either way the group stays identifiable — the hover
   * tooltip lists every drawn key by name and colour regardless of whether
   * it earned a resting label.
   */
  const bandLabels = useMemo(() => {
    if (series.length === 0 || keys.length === 0) return [];
    const xFor = (i: number) => padL + (i / Math.max(1, series.length - 1)) * iw;
    const yFor = (v: number) => padT + ih - scale(v, yMin, yMax, 0, ih);

    const candidates = keys
      .map((k) => {
        let idx = -1;
        for (let i = series.length - 1; i >= 0; i--) {
          if (series[i].values[k] != null) { idx = i; break; }
        }
        if (idx === -1) return null;
        const band = divergingStack(keys, series[idx].values).find((b) => b.key === k);
        if (!band) return null;
        const yTop = yFor(band.y1);
        const yBottom = yFor(band.y0);
        return {
          key: k,
          text: labels[k] ?? k,
          x: xFor(idx),
          y: (yTop + yBottom) / 2,
          height: Math.abs(yBottom - yTop),
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null && c.height >= LABEL_MIN_BAND_HEIGHT);

    const kept: typeof candidates = [];
    for (const c of candidates) {
      const prev = kept[kept.length - 1];
      if (prev && Math.abs(prev.y - c.y) < LABEL_MIN_VERTICAL_GAP) continue;
      kept.push(c);
    }
    return kept;
  }, [series, keys, labels, padL, padT, ih, iw, yMin, yMax]);

  const nowX = padL + (NOW / Math.max(1, series.length - 1)) * iw;
  const xTicks = chartTimeTicks(series.map((d) => d.ts), preset, NOW);

  const hoverIndexFromClientX = (clientX: number, rect: DOMRect) => {
    const x = ((clientX - rect.left) / rect.width) * width;
    const ratio = (x - padL) / iw;
    return Math.max(0, Math.min(series.length - 1, Math.round(ratio * (series.length - 1))));
  };

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (series.length === 0) return;
    setHover(hoverIndexFromClientX(e.clientX, e.currentTarget.getBoundingClientRect()));
  };

  /**
   * Touch has no hover, and the tooltip this reaches is the fallback that
   * makes a *suppressed* band label (see `bandLabels` above) still
   * identifiable. In the country document's Generation figure
   * (`GenerationTab`'s `variant="figure"`) there is deliberately no
   * `SourceTable` beside the chart — it is its own chart/table, not an
   * annotation on this one — so on a touch device that tooltip was the
   * *only* remaining way to name a too-thin band, and a mouse-only handler
   * made it unreachable there. `touchstart` only, not `touchmove`: tracking
   * a drag would fight the page's own vertical scroll gesture in a
   * scrolling document, and a single tap already surfaces every group's
   * name, colour and value the way a hover does.
   */
  const handleTouchStart = (e: React.TouchEvent<SVGSVGElement>) => {
    if (series.length === 0 || e.touches.length === 0) return;
    setHover(hoverIndexFromClientX(e.touches[0].clientX, e.currentTarget.getBoundingClientRect()));
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
        onTouchStart={handleTouchStart}
      >
        <defs>
          <NoDataHatchPattern id={hatchId} />
        </defs>

        {areas.map((a, i) => (
          <path
            key={`area-${a.k}-${a.runIndex}`}
            data-area-key={a.k}
            d={a.path}
            fill={a.color}
            fillOpacity={0.85}
            style={{ opacity: 0, animation: `chartFadeIn 0.6s ease-out ${i * 0.08}s forwards` }}
          />
        ))}

        {/*
          Interior data holes (`lib/stackedMixGaps.ts`) — a group that reports
          nothing for part of an otherwise-reporting window. The area above
          already breaks its path here rather than bridging it (no drawn
          line), and this hatched marker names *where* along the baseline
          that hole is, using the same "not on the scale" texture the map
          choropleths use for the same reason (`NoDataHatch.tsx`). It cannot
          mark the hole's true vertical extent — the missing group's own band
          position depends on values it did not report — so it is drawn as a
          thin strip at the baseline rather than guessed as a full band.
        */}
        {gaps.map((g) => {
          const step = iw / Math.max(1, series.length - 1);
          const x = xForIndex(g.startIndex) - step / 2;
          const w = xForIndex(g.endIndex) - xForIndex(g.startIndex) + step;
          const gapHours = g.endIndex - g.startIndex + 1;
          return (
            <rect
              key={`gap-${g.key}-${g.startIndex}`}
              data-gap-key={g.key}
              data-gap-start-index={g.startIndex}
              data-gap-end-index={g.endIndex}
              x={x}
              y={padT + ih - 5}
              width={Math.max(w, 1)}
              height={5}
              fill={noDataHatchUrl(hatchId)}
            >
              <title>
                {`${labels[g.key] ?? g.key}: not reported for ${gapHours} plotted point${gapHours === 1 ? '' : 's'}`}
              </title>
            </rect>
          );
        })}

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

        {/*
          Direct band labels (see `bandLabels` above) — a swatch dash plus the
          group's name, sitting in the right margin at that band's own height.
          Text is drawn in the muted ink colour, not the band's own colour:
          the contrast-vs-surface WARN some of `GENERATION_GROUP_COLORS` carry
          (see that constant's comment) is about a *mark* being hard to see
          against the card, not about what colour identifies it in text — the
          swatch still carries the category colour, same as `SourceTable`'s
          rows.
        */}
        {bandLabels.map((l) => (
          <g key={`label-${l.key}`} data-band-label-key={l.key}>
            <rect
              x={l.x + LABEL_GUTTER}
              y={l.y - 1}
              width={LABEL_SWATCH_WIDTH}
              height={2}
              rx={1}
              fill={colors[l.key]}
            />
            <text
              x={l.x + LABEL_GUTTER + LABEL_SWATCH_WIDTH + LABEL_TEXT_GAP}
              y={l.y + 3}
              fill="hsl(var(--ink-muted))"
              fontSize={LABEL_FONT_SIZE}
              textAnchor="start"
            >
              {l.text}
            </text>
          </g>
        ))}

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
                {h.values[k] == null ? '—' : (h.values[k] / 1000).toFixed(2)}
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
