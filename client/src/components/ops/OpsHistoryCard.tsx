import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { drawableRuns } from '@/lib/seriesSegments';
import {
  describeHeadroom,
  describeHeadroomBasis,
  describeStorage,
  diskSeries,
  hasReadings,
  type DiskSeriesPoint,
} from '@/lib/opsHistorySeries';
import type { DiskHeadroom, OpsStatusHistory } from '@/types';

/**
 * The trend half of `/ops-status` (ABL-288): disk usage over the stored
 * snapshots, and the projected crossing of the threshold the page already
 * paints a side red at.
 *
 * Every judgement here is made server-side (`services/opsHistoryService.ts`,
 * `lib/diskHeadroom.ts`) or in `lib/opsHistorySeries.ts`; this file draws.
 *
 * Two rules it does enforce visually:
 *
 *  - A missing reading breaks the line. Snapshots where a side was
 *    unreachable, or reported no disk, are holes — `drawableRuns` splits the
 *    stroke rather than joining across them, the same rule the dashboard's
 *    forecast lines follow (`lib/seriesSegments.ts`).
 *  - A side with no readings at all draws no line and says so, instead of
 *    rendering a flat stroke at the bottom of the chart.
 */

const LOCAL_COLOR = 'hsl(var(--primary))';
const PEER_COLOR = '#F59E0B';

export function OpsHistoryCard({ history }: { history: OpsStatusHistory }) {
  const series = diskSeries(history.snapshots);
  const caption = describeStorage(history);

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-title">Disk trend</CardTitle>
        <p className="text-meta text-ink-dim">{caption}</p>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        {series.length > 0 && <DiskChart series={series} threshold={history.headroom.local.thresholdPercent} />}
        <div className="grid gap-3 sm:grid-cols-2">
          <HeadroomBlock label="This environment" headroom={history.headroom.local} color={LOCAL_COLOR} />
          <HeadroomBlock label="Peer environment" headroom={history.headroom.peer} color={PEER_COLOR} />
        </div>
        <p className="text-micro text-ink-faint">
          Headroom is a projection from the readings above — a least-squares fit, not a measurement. It is
          withheld, with the reason stated, when the readings cannot support one.
        </p>
      </CardContent>
    </Card>
  );
}

function HeadroomBlock({
  label,
  headroom,
  color,
}: {
  label: string;
  headroom: DiskHeadroom;
  color: string;
}) {
  const basis = describeHeadroomBasis(headroom);
  const isProjection = headroom.reason === 'ok';
  const isAlarm = headroom.reason === 'already_breached';

  return (
    <div className="rounded-lg border border-border px-3 py-2.5">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full" aria-hidden="true" style={{ background: color }} />
        <span className="text-meta text-ink-dim">{label}</span>
      </div>
      <p
        className={`text-body ${isAlarm ? 'text-dirty' : isProjection ? 'text-foreground' : 'text-ink-dim'}`}
      >
        {describeHeadroom(headroom)}
      </p>
      {basis && <p className="font-mono-num mt-0.5 text-micro text-ink-faint">{basis}</p>}
    </div>
  );
}

const WIDTH = 940;
const HEIGHT = 190;
const PAD_L = 40;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 22;

function niceDomain(values: number[]): { min: number; max: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series would otherwise produce a zero-height domain and a divide by
  // zero; give it a 1-point band so the line sits mid-chart.
  if (max - min < 1) return { min: Math.max(0, min - 1), max: Math.min(100, max + 1) };
  return { min: Math.max(0, min - 2), max: Math.min(100, max + 2) };
}

function DiskChart({ series, threshold }: { series: DiskSeriesPoint[]; threshold: number }) {
  const values = series.flatMap((p) => [p.local, p.peer].filter((v): v is number => v !== null));
  if (values.length === 0) {
    return (
      <p className="text-meta text-ink-dim">
        No disk readings in these snapshots — neither side reported a filesystem it could measure.
      </p>
    );
  }

  const { min, max } = niceDomain(values);
  const innerW = WIDTH - PAD_L - PAD_R;
  const innerH = HEIGHT - PAD_T - PAD_B;
  const xFor = (i: number) => PAD_L + (i / Math.max(1, series.length - 1)) * innerW;
  const yFor = (v: number) => PAD_T + innerH - ((v - min) / (max - min)) * innerH;

  const pathFor = (side: 'local' | 'peer') => {
    const present: number[] = [];
    series.forEach((p, i) => {
      if (p[side] !== null) present.push(i);
    });
    return drawableRuns(present)
      .map((run) => {
        const seg = run.map((i) => [xFor(i), yFor(series[i][side] as number)] as const);
        if (seg.length === 1) return `M ${seg[0][0]},${seg[0][1]} L ${seg[0][0]},${seg[0][1]}`;
        return seg.map((p, i) => `${i ? 'L' : 'M'} ${p[0]},${p[1]}`).join(' ');
      })
      .filter(Boolean)
      .join(' ');
  };

  const ticks = [min, (min + max) / 2, max];
  const thresholdVisible = threshold >= min && threshold <= max;
  const first = series[0];
  const last = series[series.length - 1];

  return (
    <div>
      <p className="sr-only">
        Disk usage over {series.length} stored readings, from{' '}
        {new Date(first.t).toLocaleString()} to {new Date(last.t).toLocaleString()}. Gaps in a line are
        readings where that side reported no disk.
      </p>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="block h-auto w-full" aria-hidden="true">
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={PAD_L}
              x2={WIDTH - PAD_R}
              y1={yFor(v)}
              y2={yFor(v)}
              stroke="hsl(var(--input))"
              strokeWidth={1}
              opacity={0.5}
            />
            <text
              x={PAD_L - 6}
              y={yFor(v) + 3.5}
              fill="hsl(var(--ink-muted))"
              fontSize="10"
              textAnchor="end"
              fontFamily="'JetBrains Mono', monospace"
            >
              {v.toFixed(0)}%
            </text>
          </g>
        ))}

        {/* The threshold the badge already turns red at — drawn only when it
            is inside the plotted range, since a rule pinned to the top edge
            of a chart it is far outside of reads as "nearly there". */}
        {thresholdVisible && (
          <>
            <line
              x1={PAD_L}
              x2={WIDTH - PAD_R}
              y1={yFor(threshold)}
              y2={yFor(threshold)}
              stroke="hsl(var(--destructive))"
              strokeWidth={1}
              strokeDasharray="4 4"
              opacity={0.7}
            />
            <text
              x={WIDTH - PAD_R}
              y={yFor(threshold) - 4}
              fill="hsl(var(--destructive))"
              fontSize="10"
              textAnchor="end"
              fontFamily="'JetBrains Mono', monospace"
            >
              {threshold}%
            </text>
          </>
        )}

        <path d={pathFor('peer')} fill="none" stroke={PEER_COLOR} strokeWidth={1.75} strokeLinecap="round" />
        <path d={pathFor('local')} fill="none" stroke={LOCAL_COLOR} strokeWidth={2} strokeLinecap="round" />

        <text x={PAD_L} y={HEIGHT - 6} fill="hsl(var(--ink-muted))" fontSize="10" fontFamily="'JetBrains Mono', monospace">
          {shortStamp(first.t)}
        </text>
        <text
          x={WIDTH - PAD_R}
          y={HEIGHT - 6}
          fill="hsl(var(--ink-muted))"
          fontSize="10"
          textAnchor="end"
          fontFamily="'JetBrains Mono', monospace"
        >
          {shortStamp(last.t)}
        </text>
      </svg>

      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-ink-muted">
        <LegendKey color={LOCAL_COLOR} label="This environment" drawn={hasReadings(series, 'local')} />
        <LegendKey color={PEER_COLOR} label="Peer environment" drawn={hasReadings(series, 'peer')} />
      </div>
    </div>
  );
}

/**
 * A side with no readings in the window keeps its legend entry — with the
 * absence named — rather than vanishing, so an empty chart cannot be misread
 * as "both environments are identical".
 */
function LegendKey({ color, label, drawn }: { color: string; label: string; drawn: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2 w-2 shrink-0 rounded-full" aria-hidden="true" style={{ background: color, opacity: drawn ? 1 : 0.35 }} />
      <span>
        {label}
        {!drawn && <span className="text-ink-faint"> — no disk readings stored</span>}
      </span>
    </span>
  );
}

function shortStamp(iso: string): string {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
