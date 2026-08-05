// Measured generation by source, as a share of this window's total measured
// generation (not load - see sourceRows.ts). Sourced from the full A75
// document (energy_generation), which now carries nuclear and every fossil
// type alongside the renewables - see sourceRows.ts for the grouping.

import { buildSourceRows } from './sourceRows';
import type { GenerationMix } from '@/types';

interface Props {
  mix?: GenerationMix;
}

export function SourceTable({ mix }: Props) {
  const { rows } = buildSourceRows(mix);

  return (
    <div className="flex flex-col">
      {rows.map((s) => {
        const isNegative = s.mw != null && s.mw < 0;
        const barWidth = s.mw == null ? 0 : Math.min(100, Math.abs(s.pctOfGeneration ?? 0));
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
            <span className="text-meta">{s.label}</span>
            <span className="font-mono-num text-right text-meta">
              {s.mw == null ? '—' : (s.mw / 1000).toFixed(2)}
            </span>
            <span className="font-mono-num text-right text-micro text-ink-dim">
              {s.pctOfGeneration == null ? '—' : `${s.pctOfGeneration.toFixed(1)}%`}
            </span>
            <span className="relative block h-1 rounded-sm bg-secondary">
              {s.mw != null && (
                <span
                  className="absolute inset-y-0 rounded-sm"
                  style={{
                    width: `${barWidth}%`,
                    background: s.color,
                    // A negative reading (net pumping, a consumption-only
                    // fossil type) is real but is not "a share of generation"
                    // in the same sense the positive rows are - grow the bar
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

      <p className="mt-2 border-t border-input pt-2 text-micro text-ink-muted">
        Nuclear, every fossil type, and storage are ingested from the same ENTSO-E document as the
        renewables above — Fossil and Other each group several reported types into one row. A dash
        means this country does not report that type at all. Percentages are each row's share of
        this window's total measured generation (positive output only), not a share of load — a
        negative row (pumped storage charging) shows as a negative share of that. The gap between
        generation and load is exports, imports, and losses; see the Net position tab for that.
      </p>
    </div>
  );
}
