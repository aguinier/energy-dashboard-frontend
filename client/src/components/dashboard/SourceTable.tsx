// Measured renewable sources, as a share of load. Nuclear and fossil are not
// ingested (no table carries them), so the balance of load is reported as an
// unattributed remainder rather than split into invented categories.

import { buildSourceRows } from './sourceRows';
import type { RenewableMix, DashboardOverview } from '@/types';

interface Props {
  mix?: RenewableMix;
  overview?: DashboardOverview;
}

export function SourceTable({ mix, overview }: Props) {
  const load = overview?.currentLoad ?? null;
  const { rows, unattributedMw } = buildSourceRows(mix, load);

  return (
    <div className="flex flex-col">
      {rows.map((s) => (
        <div
          key={s.key}
          className="grid items-center gap-2.5 border-t border-input py-2.5 first:border-t-0"
          style={{ gridTemplateColumns: '10px 1fr 60px 60px 140px' }}
        >
          <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
          <span className="text-[12.5px]">{s.label}</span>
          <span className="font-mono-num text-right text-[12px]">{(s.mw / 1000).toFixed(2)}</span>
          <span className="font-mono-num text-right text-[11px] text-ink-dim">
            {s.pctOfLoad.toFixed(1)}%
          </span>
          <span className="relative block h-1 rounded-sm bg-secondary">
            <span
              className="absolute inset-y-0 left-0 rounded-sm"
              style={{ width: `${Math.min(100, s.pctOfLoad)}%`, background: s.color }}
            />
          </span>
        </div>
      ))}

      {unattributedMw != null && (
        <div
          className="grid items-center gap-2.5 border-t border-input py-2.5"
          style={{ gridTemplateColumns: '10px 1fr 60px 60px 140px' }}
        >
          <span className="h-2 w-2 rounded-sm border border-border" />
          <span className="text-[12.5px] text-ink-dim">Not attributed</span>
          <span className="font-mono-num text-right text-[12px] text-ink-dim">
            {(unattributedMw / 1000).toFixed(2)}
          </span>
          <span className="font-mono-num text-right text-[11px] text-ink-dim">
            {load && load > 0 ? ((unattributedMw / load) * 100).toFixed(1) : '0.0'}%
          </span>
          <span />
        </div>
      )}

      <p className="mt-2 border-t border-input pt-2 text-[10.5px] text-ink-muted">
        Nuclear and fossil generation are not ingested — the remainder is left unnamed.
      </p>
    </div>
  );
}
