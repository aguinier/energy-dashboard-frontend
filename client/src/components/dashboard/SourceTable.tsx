// Measured generation by source, as a share of load. Sourced from the full
// A75 document (energy_generation), which now carries nuclear and every
// fossil type alongside the renewables - see sourceRows.ts for the grouping.

import { buildSourceRows } from './sourceRows';
import type { GenerationMix, DashboardOverview } from '@/types';

interface Props {
  mix?: GenerationMix;
  overview?: DashboardOverview;
}

export function SourceTable({ mix, overview }: Props) {
  const load = overview?.currentLoad ?? null;
  const { rows, remainderMw } = buildSourceRows(mix, load);

  return (
    <div className="flex flex-col">
      {rows.map((s) => {
        const isNegative = s.mw != null && s.mw < 0;
        const barWidth = s.mw == null ? 0 : Math.min(100, Math.abs(s.pctOfLoad ?? 0));
        return (
          <div
            key={s.key}
            className="grid items-center gap-2.5 border-t border-input py-2.5 first:border-t-0"
            style={{ gridTemplateColumns: '10px 1fr 60px 60px 140px' }}
          >
            <span
              className={s.mw == null ? 'h-2 w-2 rounded-sm border border-border' : 'h-2 w-2 rounded-sm'}
              style={s.mw == null ? undefined : { background: s.color }}
            />
            <span className="text-[12.5px]">{s.label}</span>
            <span className="font-mono-num text-right text-[12px]">
              {s.mw == null ? '—' : (s.mw / 1000).toFixed(2)}
            </span>
            <span className="font-mono-num text-right text-[11px] text-ink-dim">
              {s.pctOfLoad == null ? '—' : `${s.pctOfLoad.toFixed(1)}%`}
            </span>
            <span className="relative block h-1 rounded-sm bg-secondary">
              {s.mw != null && (
                <span
                  className="absolute inset-y-0 rounded-sm"
                  style={{
                    width: `${barWidth}%`,
                    background: s.color,
                    // A negative reading (net pumping, a consumption-only
                    // fossil type) is real but is not "a share of load" in
                    // the same sense the positive rows are - grow the bar
                    // from the right and dim it so it reads as draw, not
                    // supply, instead of implying a magnitude it doesn't have.
                    ...(isNegative ? { right: 0, opacity: 0.45 } : { left: 0 }),
                  }}
                />
              )}
            </span>
          </div>
        );
      })}

      {remainderMw != null && (
        <div
          className="grid items-center gap-2.5 border-t border-input py-2.5"
          style={{ gridTemplateColumns: '10px 1fr 60px 60px 140px' }}
        >
          <span className="h-2 w-2 rounded-sm border border-border" />
          <span className="text-[12.5px] text-ink-dim">Balance</span>
          <span className="font-mono-num text-right text-[12px] text-ink-dim">
            {(remainderMw / 1000).toFixed(2)}
          </span>
          <span className="font-mono-num text-right text-[11px] text-ink-dim">
            {load && load > 0 ? ((remainderMw / load) * 100).toFixed(1) : '0.0'}%
          </span>
          <span />
        </div>
      )}

      <p className="mt-2 border-t border-input pt-2 text-[10.5px] text-ink-muted">
        Nuclear, every fossil type, and storage are ingested from the same ENTSO-E document as the
        renewables above — Fossil and Other each group several reported types into one row. A dash
        means this country does not report that type at all. Balance is load minus everything
        reported here: what's left once all 21 measured types are counted, not an unmeasured source.
      </p>
    </div>
  );
}
