import {
  useDashboardOverview,
  useLoadData,
  usePriceData,
  useRenewableData,
} from '@/hooks/useDashboardData';
import { AbleSparkline } from '@/components/charts/AbleSparkline';
import { cn } from '@/lib/utils';

// Top 4-stat strip on the country page. Each cell shows a big number, unit,
// 24h delta, and a tiny sparkline pulled from the time series the page is
// already fetching for the line charts below (no extra requests).

type StatItem = {
  label: string;
  value: string;
  unit: string;
  delta?: string;
  good?: boolean;
  spark: number[];
};

function lastN(values: Array<number | null | undefined>, n: number): number[] {
  return values
    .filter((v): v is number => v != null && Number.isFinite(v))
    .slice(-n);
}

// The price window now extends into tomorrow (published auction), but the
// stat tile's spark is a *recent trend* — keep it to points at or before now.
function isPast(ts: string | undefined): boolean {
  if (!ts) return true;
  const iso = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
  const t = new Date(iso).getTime();
  return !Number.isFinite(t) || t <= Date.now();
}

export function AbleStatRow() {
  const { data: overview, isLoading } = useDashboardOverview();
  const { data: load } = useLoadData();
  const { data: price } = usePriceData();
  const { data: renewable } = useRenewableData();

  const loadSpark = lastN(load?.map((p) => p.load ?? p.avg_load ?? null) ?? [], 48);
  const priceSpark = lastN(
    price?.filter((p) => isPast(p.timestamp)).map((p) => p.price) ?? [],
    48,
  );
  const renewableSpark = lastN(
    renewable?.map((p) => {
      const total = (p.solar ?? 0) + (p.wind_onshore ?? 0) + (p.wind_offshore ?? 0) + (p.hydro ?? 0) + (p.biomass ?? 0);
      return total;
    }) ?? [],
    48,
  );
  // Peak demand sparkline = same load series (peak comes from the same data).
  const peakSpark = loadSpark;

  const items: StatItem[] = [
    {
      label: 'Day-ahead price',
      value: overview?.avgPrice != null ? `€${overview.avgPrice.toFixed(1)}` : '—',
      unit: '/MWh',
      delta:
        overview?.priceChange24h != null
          ? `${overview.priceChange24h >= 0 ? '+' : ''}${overview.priceChange24h.toFixed(2)}%`
          : undefined,
      good: overview?.priceChange24h != null ? overview.priceChange24h < 0 : undefined,
      spark: priceSpark,
    },
    {
      label: 'Current load',
      value:
        overview?.currentLoad != null
          ? (overview.currentLoad / 1000).toFixed(2)
          : '—',
      unit: 'GW',
      delta:
        overview?.loadChange24h != null
          ? `${overview.loadChange24h >= 0 ? '+' : ''}${overview.loadChange24h.toFixed(2)}%`
          : undefined,
      // Load moving up or down carries no valence — leave it neutral ink.
      good: undefined,
      spark: loadSpark,
    },
    {
      label: 'Renewable share',
      value:
        overview?.renewablePercentage != null
          ? overview.renewablePercentage.toFixed(0)
          : '—',
      unit: '%',
      spark: renewableSpark,
    },
    {
      label: 'Peak demand',
      value:
        overview?.peakDemand != null ? (overview.peakDemand / 1000).toFixed(2) : '—',
      unit: 'GW',
      spark: peakSpark,
    },
  ];

  return (
    <div className="mb-5 grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-card md:grid-cols-4">
      {items.map((it, i) => (
        <div
          key={it.label}
          className={cn(
            'px-5 py-4',
            i < items.length - 1 && 'md:border-r md:border-border',
            i % 2 === 0 && i < items.length - 1 && 'border-r border-border md:border-r',
          )}
        >
          <div className="mb-2 font-mono-num text-[10px] uppercase tracking-[0.1em] text-ink-muted">
            {it.label}
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="num text-[26px] font-medium text-foreground">
              {isLoading ? '…' : it.value}
            </span>
            <span className="text-[11px] text-ink-muted">{it.unit}</span>
          </div>
          <div className="mt-2 flex min-h-[22px] items-center justify-between">
            {it.delta != null ? (
              <span
                className={cn(
                  'font-mono-num text-[11px]',
                  it.good == null ? 'text-ink-muted' : it.good ? 'text-up' : 'text-down',
                )}
              >
                {it.delta}
                <span className="ml-1 text-ink-muted">24h</span>
              </span>
            ) : (
              <span />
            )}
            {it.spark.length > 1 && (
              <AbleSparkline values={it.spark} width={70} height={22} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
