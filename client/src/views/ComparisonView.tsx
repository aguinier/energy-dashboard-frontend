import { lazy, Suspense } from 'react';
import { useDashboardStore } from '@/store/dashboardStore';
import { useCrossCountryMetrics } from '@/hooks/useDashboardData';
import { ComparisonFilterBar } from '@/components/comparison/ComparisonFilterBar';
import { CountryRanking } from '@/components/comparison/CountryRanking';

const ComparisonHeatmap = lazy(() => import('@/components/comparison/ComparisonHeatmap').then(m => ({ default: m.ComparisonHeatmap })));
const ComparisonMap = lazy(() => import('@/components/comparison/ComparisonMap').then(m => ({ default: m.ComparisonMap })));
const ComparisonLeaderboard = lazy(() => import('@/components/comparison/ComparisonLeaderboard').then(m => ({ default: m.ComparisonLeaderboard })));

function SectionSkeleton() {
  return <div className="animate-pulse rounded-xl border border-border bg-card p-6"><div className="mb-4 h-5 w-32 rounded bg-muted" /><div className="h-64 w-full rounded bg-muted" /></div>;
}

export default function ComparisonView() {
  const { goToMap, comparisonForecastType } = useDashboardStore();
  const { data, isLoading, isError } = useCrossCountryMetrics();
  return <div className="flex-1 overflow-auto bg-background"><div className="mx-auto max-w-[1200px] px-4 pb-14 pt-7 sm:px-8">
    <div className="mb-3.5 flex items-center gap-2"><button onClick={goToMap} className="cursor-pointer border-none bg-transparent p-0 text-meta text-ink-dim hover:text-foreground">← Map</button><span className="text-meta text-ink-faint">/</span><span className="text-meta text-ink-dim">Forecast quality</span></div>
    <h1 className="m-0 mb-2 text-display font-medium">Forecast quality</h1>
    <p className="mb-6 max-w-2xl text-body text-ink-dim">Measured forecast performance across the portfolio. Select a country to inspect its detail.</p>
    <div className="space-y-4"><ComparisonFilterBar />
      {isLoading && <SectionSkeleton />}
      {isError && <div className="flex h-64 items-center justify-center"><p className="text-sm text-ink-dim">Failed to load comparison data. The backend API may not be available yet.</p></div>}
      {data && !isLoading && <>
        <section aria-labelledby="matrix-heading"><h2 id="matrix-heading" className="sr-only">Country by forecast type matrix</h2><Suspense fallback={<SectionSkeleton />}><ComparisonHeatmap data={data} /></Suspense></section>
        <CountryRanking data={data} />
        {comparisonForecastType !== 'all' && <Suspense fallback={<SectionSkeleton />}><ComparisonMap data={data} /></Suspense>}
        <details className="rounded-lg border bg-card px-4 py-3"><summary className="cursor-pointer text-sm font-medium">Evidence and error measures</summary><div className="mt-3">{comparisonForecastType === 'all' ? <p className="text-sm text-ink-dim">Choose a forecast type above to inspect MAE, RMSE, bias, and data-point evidence.</p> : <Suspense fallback={<SectionSkeleton />}><ComparisonLeaderboard data={data} /></Suspense>}</div></details>
      </>}
    </div>
  </div></div>;
}
