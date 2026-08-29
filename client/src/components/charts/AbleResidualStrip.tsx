import type { ResidualPoint } from '@/components/dashboard/residualSeries';
import { PLOT_MARGINS } from './AbleLineChart';

const HOUR_MS = 60 * 60 * 1000;

/** The parent plot's x-axis domain — see `domain` below. */
export interface ResidualStripDomain {
  /** ISO timestamp at the plot's leftmost x-position. */
  start: string;
  /** ISO timestamp at the plot's rightmost x-position. */
  end: string;
}

interface Props {
  points: ResidualPoint[];
  /**
   * The x-axis domain of the plot this strip sits under, e.g. the same
   * `{ start, end }` window the caller fetched that plot's data over. Bars
   * are positioned by real elapsed time against this domain, NOT by a point's
   * position in `points` — `points` can have interior gaps (a residual is
   * dropped, never zeroed, when either side is missing), and spacing by
   * array index instead shifted every later bar left by one slot per gap.
   * An explicit domain is the only way to place a bar correctly when the
   * array itself does not record which instants are absent.
   */
  domain: ResidualStripDomain;
  /** Duration one point covers, for bar width. Defaults to one hour — the bucketing every current caller pairs residuals on. */
  intervalMs?: number;
  height?: number;
  unit?: string;
}

/**
 * A short signed axis beneath a figure: actual − forecast per interval.
 *
 * Hand-drawn SVG rather than Recharts, and it borrows `AbleLineChart`'s own
 * plot geometry (`PLOT_MARGINS`) rather than spanning the raw container
 * width: the line chart above insets its drawable area behind a y-axis label
 * gutter and a right margin, so a strip drawn edge-to-edge would sit every
 * bar left of where it belongs even with correct time spacing. It has no
 * axes, tooltip or legend of its own — it is an annotation on the figure
 * above it, not a chart.
 */
export function AbleResidualStrip({ points, domain, intervalMs = HOUR_MS, height = 46, unit = 'MW' }: Props) {
  if (points.length === 0) return null;

  const peak = Math.max(...points.map((p) => Math.abs(p.residual)));
  const zero = height / 2;
  const half = height / 2;

  const { width, padL, padR } = PLOT_MARGINS;
  const iw = width - padL - padR;
  const domainStart = new Date(domain.start).getTime();
  const domainEnd = new Date(domain.end).getTime();
  // Guards a zero-width domain (start === end) rather than dividing by it.
  const span = Math.max(domainEnd - domainStart, intervalMs);
  const barWidth = Math.max((intervalMs / span) * iw * 0.8, 0.5);
  const xFor = (t: number) => padL + ((t - domainStart) / span) * iw;

  return (
    // `px-5` matches `AbleCard`'s own body padding (`AbleCard.tsx`'s
    // `px-5 pb-5`/`pt-5`), not an arbitrary value: the plot above sits inside
    // that card, so its drawable width is the card's *content* box, narrower
    // than the card's outer width by that padding on both sides. Without
    // this, the strip's own 100% is measured against the wider outer column
    // it actually renders in (no card of its own), landing every bar ~20px
    // left of where the chart's padL gutter really starts on screen —
    // confirmed against a live render, not assumed from the numbers alone.
    <div className="w-full px-5">
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Forecast residual per interval, peak ${Math.round(peak)} ${unit}`}
      >
        {points.map((p) => {
          const x = xFor(new Date(p.t).getTime());
          // An instant outside the plot's own domain has no correct place to
          // land — drop it rather than draw it under the wrong tick, or
          // behind the y-axis gutter.
          if (!Number.isFinite(x) || x < padL - barWidth || x > width - padR + barWidth) return null;
          const h = peak === 0 ? 0 : (half * Math.abs(p.residual)) / peak;
          const over = p.residual > 0;
          return (
            <rect
              key={p.t}
              data-residual={p.residual}
              data-sign={over ? 'over' : 'under'}
              x={x}
              y={over ? zero - h : zero}
              width={barWidth}
              height={Math.max(h, 0.4)}
              fill={over ? 'hsl(var(--up))' : 'hsl(var(--down))'}
              opacity={0.8}
            />
          );
        })}
        <line x1={padL} y1={zero} x2={width - padR} y2={zero} stroke="hsl(var(--border))" strokeWidth="0.4" />
      </svg>
      {/* Below the strip, not beside it: a same-row label would shrink the
          svg's rendered width below the plot's own, which is the exact
          full-width-vs-inset mismatch this component exists to avoid. */}
      <div className="mt-1 text-right font-mono-num text-micro text-ink-muted">
        ±{Math.round(peak).toLocaleString('en-GB')} {unit}
      </div>
    </div>
  );
}
