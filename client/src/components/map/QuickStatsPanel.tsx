import { useMapData } from '@/hooks/useDashboardData';
import { useDashboardStore } from '@/store/dashboardStore';
import { Zap, DollarSign, Leaf, TrendingUp, TrendingDown } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

export function QuickStatsPanel() {
  const { goToCountry } = useDashboardStore();

  // Fetch map data for all metrics to compute stats
  const { data: loadData, isLoading: loadLoading } = useMapData('load');
  const { data: priceData, isLoading: priceLoading } = useMapData('price');
  const { data: renewableData, isLoading: renewableLoading } = useMapData('renewable_pct');

  const isLoading = loadLoading || priceLoading || renewableLoading;

  // Compute highlights
  const highlights = computeHighlights(loadData, priceData, renewableData);

  if (isLoading) {
    return (
      <div className="rounded-xl border bg-card/95 backdrop-blur-sm shadow-lg p-4">
        <div className="flex items-center justify-center gap-8">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-6 w-48" />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card/95 backdrop-blur-sm shadow-lg p-4">
      <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-sm">
        {/* Highest Load */}
        {highlights.highestLoad && (
          <button
            onClick={() => goToCountry(highlights.highestLoad!.code)}
            className="flex items-center gap-2 hover:text-primary transition-colors"
          >
            <Zap className="h-4 w-4 text-blue-500" />
            <span className="text-muted-foreground">Highest Load:</span>
            <span className="font-semibold">{highlights.highestLoad.code}</span>
            <span className="font-mono">{formatValue(highlights.highestLoad.value, 'load')}</span>
            <TrendingUp className="h-3 w-3 text-blue-500" />
          </button>
        )}

        {/* Lowest Price */}
        {highlights.lowestPrice && (
          <button
            onClick={() => goToCountry(highlights.lowestPrice!.code)}
            className="flex items-center gap-2 hover:text-primary transition-colors"
          >
            <DollarSign className="h-4 w-4 text-emerald-500" />
            <span className="text-muted-foreground">Lowest Price:</span>
            <span className="font-semibold">{highlights.lowestPrice.code}</span>
            <span className="font-mono">{formatValue(highlights.lowestPrice.value, 'price')}</span>
            <TrendingDown className="h-3 w-3 text-emerald-500" />
          </button>
        )}

        {/* Top Renewable */}
        {highlights.topRenewable && (
          <button
            onClick={() => goToCountry(highlights.topRenewable!.code)}
            className="flex items-center gap-2 hover:text-primary transition-colors"
          >
            <Leaf className="h-4 w-4 text-green-500" />
            <span className="text-muted-foreground">Top Renewable:</span>
            <span className="font-semibold">{highlights.topRenewable.code}</span>
            <span className="font-mono">{formatValue(highlights.topRenewable.value, 'renewable_pct')}</span>
          </button>
        )}

        {/* Highest Price (for context) */}
        {highlights.highestPrice && (
          <button
            onClick={() => goToCountry(highlights.highestPrice!.code)}
            className="flex items-center gap-2 hover:text-primary transition-colors"
          >
            <DollarSign className="h-4 w-4 text-amber-500" />
            <span className="text-muted-foreground">Highest Price:</span>
            <span className="font-semibold">{highlights.highestPrice.code}</span>
            <span className="font-mono">{formatValue(highlights.highestPrice.value, 'price')}</span>
            <TrendingUp className="h-3 w-3 text-amber-500" />
          </button>
        )}
      </div>
    </div>
  );
}

interface Highlight {
  code: string;
  value: number;
}

interface Highlights {
  highestLoad: Highlight | null;
  lowestPrice: Highlight | null;
  highestPrice: Highlight | null;
  topRenewable: Highlight | null;
}

function computeHighlights(
  loadData: { country_code: string; value: number }[] | undefined,
  priceData: { country_code: string; value: number }[] | undefined,
  renewableData: { country_code: string; value: number }[] | undefined
): Highlights {
  const highlights: Highlights = {
    highestLoad: null,
    lowestPrice: null,
    highestPrice: null,
    topRenewable: null,
  };

  if (loadData && loadData.length > 0) {
    const sorted = [...loadData].sort((a, b) => b.value - a.value);
    highlights.highestLoad = { code: sorted[0].country_code, value: sorted[0].value };
  }

  if (priceData && priceData.length > 0) {
    const validPrices = priceData.filter(d => d.value > 0);
    if (validPrices.length > 0) {
      const sortedAsc = [...validPrices].sort((a, b) => a.value - b.value);
      const sortedDesc = [...validPrices].sort((a, b) => b.value - a.value);
      highlights.lowestPrice = { code: sortedAsc[0].country_code, value: sortedAsc[0].value };
      highlights.highestPrice = { code: sortedDesc[0].country_code, value: sortedDesc[0].value };
    }
  }

  if (renewableData && renewableData.length > 0) {
    const sorted = [...renewableData].sort((a, b) => b.value - a.value);
    highlights.topRenewable = { code: sorted[0].country_code, value: sorted[0].value };
  }

  return highlights;
}

function formatValue(value: number, metric: string): string {
  switch (metric) {
    case 'load':
      return `${(value / 1000).toFixed(1)} GW`;
    case 'price':
      return `${value.toFixed(0)} EUR`;
    case 'renewable_pct':
      return `${value.toFixed(0)}%`;
    default:
      return String(value);
  }
}
